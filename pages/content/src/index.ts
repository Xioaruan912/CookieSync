import { init } from './localStorage';
import { matchesSitePage } from '@sync-your-cookie/shared/lib/cookie/restore';
import { isSiteAllowed, siteRulesFromStorage } from '@sync-your-cookie/storage/lib/commonSites';
import { readPageSnapshot } from './snapshot';
init();

// Observe only enabled sites; snapshots travel through private extension messages.
let localSignature = '';
let automaticEnabled = false;
let includeLocalStorage = true;
let includeSessionStorage = false;

const currentSnapshot = () => {
  const snapshot = readPageSnapshot();
  return {
    origin: snapshot.origin,
    localStorageItems: includeLocalStorage ? snapshot.localStorageItems : [],
    sessionStorageItems: includeSessionStorage ? snapshot.sessionStorageItems : [],
  };
};

const checkLocalChanges = async () => {
  try {
    if (chrome.extension.inIncognitoContext) {
      automaticEnabled = false;
      return;
    }
    const settings = (await chrome.storage.sync.get('settings-storage-key'))['settings-storage-key'];
    includeLocalStorage = settings?.includeLocalStorage !== false;
    if (settings?.backgroundSync === false) {
      automaticEnabled = false;
      return;
    }
    const config = (await chrome.storage.local.get('domainConfig-storage-key'))['domainConfig-storage-key'];
    const host = location.host;
    if (!isSiteAllowed(host, siteRulesFromStorage(await chrome.storage.sync.get(null)))) {
      automaticEnabled = false;
      return;
    }
    const registered = Object.entries(config?.domainMap || {}).find(([domain]) => matchesSitePage(domain, host));
    const enabled = registered
      ? (registered[1] as { autoPush?: boolean }).autoPush !== false
      : settings?.autoDiscoverSites !== false;
    // Session storage is opt-in: a site switch wins, then the global default.
    includeSessionStorage =
      (registered?.[1] as { includeSessionStorage?: boolean } | undefined)?.includeSessionStorage ??
      settings?.includeSessionStorage ??
      false;
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
};
void checkLocalChanges();
setInterval(() => void checkLocalChanges(), 30000);
window.addEventListener('pagehide', () => {
  if (!automaticEnabled) return;
  try {
    void chrome.runtime
      .sendMessage({
        type: 'CookieSyncLocalStorageChanged',
        ...currentSnapshot(),
      })
      .catch(() => {});
  } catch {
    /* Page teardown is best effort. */
  }
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'SetLocalStorage' || message?.type === 'SetPageStorage')
    setTimeout(() => {
      try {
        localSignature = JSON.stringify(currentSnapshot());
      } catch {
        /* Unavailable origin. */
      }
    }, 100);
});
void chrome.runtime.sendMessage({ type: 'CookieSyncPageReady' }).catch(() => {});
