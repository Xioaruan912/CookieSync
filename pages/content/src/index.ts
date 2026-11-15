import { init } from './localStorage';
init();

// Observe only enabled sites; snapshots travel through private extension messages.
let localSignature = '';
let automaticEnabled = false;
const snapshotLocalItems = () =>
  Object.keys(localStorage)
    .sort()
    .map(key => ({ key, value: localStorage.getItem(key) || '' }));
const checkLocalChanges = async () => {
  try {
    const settings = (await chrome.storage.sync.get('settings-storage-key'))['settings-storage-key'];
    if (settings?.backgroundSync === false || settings?.includeLocalStorage === false) {
      automaticEnabled = false;
      return;
    }
    const config = (await chrome.storage.local.get('domainConfig-storage-key'))['domainConfig-storage-key'];
    const host = location.host;
    const enabled = Object.entries(config?.domainMap || {}).some(
      ([domain, item]) =>
        (item as { autoPush?: boolean }).autoPush !== false &&
        (host === domain || host.replace(/^www\./, '') === domain),
    );
    automaticEnabled = enabled;
    if (!enabled) return;
    const items = snapshotLocalItems();
    const next = JSON.stringify(items);
    if (localSignature && next !== localSignature) {
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
      .sendMessage({ type: 'CookieSyncLocalStorageChanged', localStorageItems: snapshotLocalItems() })
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
