import { init } from './localStorage';
import { matchesSitePage } from '@sync-your-cookie/shared/lib/cookie/restore';
init();

// Observe only enabled sites; snapshots travel through private extension messages.
let localSignature = '';
let automaticEnabled = false;
let includeLocalStorage = true;
const snapshotLocalItems = () =>
  Object.keys(localStorage)
    .sort()
    .map(key => ({ key, value: localStorage.getItem(key) || '' }));
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
    const registered = Object.entries(config?.domainMap || {}).find(([domain]) => matchesSitePage(domain, host));
    const enabled = registered
      ? (registered[1] as { autoPush?: boolean }).autoPush !== false
      : settings?.autoDiscoverSites !== false;
    automaticEnabled = enabled;
    if (!enabled) return;
    const items = settings?.includeLocalStorage === false ? [] : snapshotLocalItems();
    const next = JSON.stringify(items);
    if (!registered) {
      await chrome.runtime.sendMessage({ type: 'CookieSyncPageReady', localStorageItems: items });
    } else if (localSignature && next !== localSignature) {
      await chrome.runtime.sendMessage({ type: 'CookieSyncLocalStorageChanged', localStorageItems: items });
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
        localStorageItems: includeLocalStorage ? snapshotLocalItems() : [],
      })
      .catch(() => {});
  } catch {
    /* Page teardown is best effort. */
  }
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'SetLocalStorage')
    setTimeout(() => {
      try {
        localSignature = JSON.stringify(snapshotLocalItems());
      } catch {
        /* Unavailable origin. */
      }
    }, 100);
});
void chrome.runtime.sendMessage({ type: 'CookieSyncPageReady' }).catch(() => {});
