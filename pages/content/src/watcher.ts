import { matchesSitePage } from '@sync-your-cookie/shared/lib/cookie/restore';
import {
  isSiteAllowed,
  siteRulePrefix,
  siteRulesFromStorage,
  type SiteRules,
} from '@sync-your-cookie/storage/lib/commonSites';
import { readPageSnapshot } from './snapshot';

interface CachedWatcherConfig {
  settings: {
    includeLocalStorage?: boolean;
    includeSessionStorage?: boolean;
    backgroundSync?: boolean;
    autoDiscoverSites?: boolean;
  };
  domainMap: Record<string, { autoPush?: boolean; includeSessionStorage?: boolean }>;
  rules: SiteRules;
  loaded: boolean;
}

const state: CachedWatcherConfig = {
  settings: {},
  domainMap: {},
  rules: {},
  loaded: false,
};

let localSignature = '';
let automaticEnabled = false;
let registeredSite = false;
let includeLocalStorage = true;
let includeSessionStorage = false;

function currentSnapshot() {
  const snapshot = readPageSnapshot();
  return {
    origin: snapshot.origin,
    localStorageItems: includeLocalStorage ? snapshot.localStorageItems : [],
    sessionStorageItems: includeSessionStorage ? snapshot.sessionStorageItems : [],
  };
}

async function loadWatcherConfig() {
  const [syncData, localData] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get('domainConfig-storage-key'),
  ]);
  state.settings = (syncData['settings-storage-key'] as CachedWatcherConfig['settings']) || {};
  state.rules = siteRulesFromStorage(syncData);
  const config = localData['domainConfig-storage-key'] as { domainMap?: CachedWatcherConfig['domainMap'] } | undefined;
  state.domainMap = config?.domainMap || {};
  state.loaded = true;
}

function subscribeConfigChanges() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync') {
      if (changes['settings-storage-key']) {
        state.settings = (changes['settings-storage-key'].newValue as CachedWatcherConfig['settings']) || {};
      }
      if (Object.keys(changes).some(key => key.startsWith(siteRulePrefix))) {
        void chrome.storage.sync
          .get(null)
          .then(syncData => {
            state.rules = siteRulesFromStorage(syncData);
          })
          .catch(() => {});
      }
    } else if (areaName === 'local' && changes['domainConfig-storage-key']) {
      const next = changes['domainConfig-storage-key'].newValue as
        | { domainMap?: CachedWatcherConfig['domainMap'] }
        | undefined;
      state.domainMap = next?.domainMap || {};
    }
  });
}

async function checkLocalChanges() {
  try {
    if (chrome.extension.inIncognitoContext) {
      automaticEnabled = false;
      return;
    }
    if (!state.loaded) await loadWatcherConfig();

    includeLocalStorage = state.settings?.includeLocalStorage !== false;
    if (state.settings?.backgroundSync === false) {
      automaticEnabled = false;
      return;
    }
    const host = location.host;
    if (!isSiteAllowed(host, state.rules)) {
      automaticEnabled = false;
      return;
    }
    const registered = Object.entries(state.domainMap).find(([domain]) => matchesSitePage(domain, host));
    registeredSite = !!registered;
    const enabled = registered ? registered[1].autoPush !== false : state.settings?.autoDiscoverSites !== false;
    includeSessionStorage = registered?.[1]?.includeSessionStorage ?? state.settings?.includeSessionStorage ?? false;
    automaticEnabled = enabled;
    if (!enabled) return;

    const snapshot = currentSnapshot();
    const next = JSON.stringify(snapshot);
    if (!registered) {
      await chrome.runtime.sendMessage({ type: 'CookieSyncPageReady', ...snapshot });
    } else if (localSignature && next !== localSignature) {
      await chrome.runtime.sendMessage({ type: 'CookieSyncLocalStorageChanged', ...snapshot });
    }
    localSignature = next;
  } catch {
    /* Extension reloaded, page navigated, or storage unavailable. */
  }
}

export function refreshAppliedSignature() {
  setTimeout(() => {
    try {
      localSignature = JSON.stringify(currentSnapshot());
    } catch {
      /* Unavailable origin. */
    }
  }, 80);
}

export function initPageWatcher() {
  subscribeConfigChanges();
  void checkLocalChanges();
  setInterval(() => void checkLocalChanges(), 30000);
  let lastFinalSignature: string | undefined;
  const reportFinal = () => {
    if (!automaticEnabled) return;
    try {
      const snapshot = currentSnapshot();
      const signature = JSON.stringify(snapshot);
      if (signature === lastFinalSignature || (registeredSite && signature === localSignature)) return;
      lastFinalSignature = signature;
      void chrome.runtime
        .sendMessage({
          type: 'CookieSyncLocalStorageChanged',
          finalCapture: true,
          ...snapshot,
        })
        .catch(() => {
          if (lastFinalSignature === signature) lastFinalSignature = undefined;
        });
    } catch {
      /* Page teardown is best effort. */
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') reportFinal();
    else lastFinalSignature = undefined;
  });
  window.addEventListener('pagehide', reportFinal);
  void chrome.runtime.sendMessage({ type: 'CookieSyncPageReady' }).catch(() => {});
}
