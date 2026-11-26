import { initStorageMessageHandler } from './storageHandler';
import { initPageWatcher, refreshAppliedSignature } from './watcher';

const INIT_FLAG = '__COOKIESYNC_CONTENT_INITIALIZED__';
if (!(globalThis as Record<string, unknown>)[INIT_FLAG]) {
  (globalThis as Record<string, unknown>)[INIT_FLAG] = true;
  try {
    document.documentElement?.setAttribute(
      'data-cookiesync-ext',
      chrome.runtime?.getManifest?.()?.version || '1',
    );
  } catch {
    /* Non-DOM or restricted document. */
  }
  initStorageMessageHandler(refreshAppliedSignature);
  initPageWatcher();
}
