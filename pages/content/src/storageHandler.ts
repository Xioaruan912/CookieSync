import {
  DomainPayload,
  Message,
  MessageType,
  PageStoragePayload,
  SendResponse,
  SetLocalStorageMessagePayload,
  SetPageStoragePayload,
} from '@sync-your-cookie/shared';
import { matchesSiteScope } from '@sync-your-cookie/shared/lib/cookie/restore';
import { captureIndexedDb, restoreIndexedDb } from './indexedDb';
import { readPageSnapshot } from './snapshot';

const inScope = (payload: { domain?: string; origin?: string } | undefined) => {
  if (!payload) return false;
  if (payload.origin) return payload.origin === location.origin;
  return !!payload.domain && matchesSiteScope(payload.domain, location.host);
};

const writeStorageArea = (area: Storage, items: { key?: string | null; value?: string | null }[]) => {
  for (const item of items) area.setItem(item.key || '', item.value || '');
};

export function initStorageMessageHandler(onRemoteApplied: () => void) {
  chrome.runtime.onMessage.addListener(
    (message: Message, _sender, sendResponse: (response?: SendResponse) => void) => {
      if (!message || typeof message !== 'object' || !('type' in message)) return false;

      if (message.type === MessageType.GetLocalStorage) {
        const payload = message.payload as DomainPayload;
        if (!inScope(payload)) return false;
        try {
          const items = readPageSnapshot().localStorageItems.map(({ key, value }) => ({ key, value }));
          sendResponse({ isOk: true, msg: 'get localStorage success', result: items });
        } catch (error) {
          sendResponse({ isOk: false, msg: 'get localStorage error', result: error });
        }
        return false;
      }

      if (message.type === MessageType.SetLocalStorage) {
        const payload = message.payload as SetLocalStorageMessagePayload;
        if (!inScope(payload)) return false;
        try {
          const values = payload.value || [];
          if (payload.onlyKey) {
            const target = values.find(item => item.key === payload.onlyKey);
            if (target) localStorage.setItem(payload.onlyKey, target.value || '');
          } else {
            writeStorageArea(localStorage, values);
          }
          onRemoteApplied();
          sendResponse({ isOk: true, msg: 'set localStorage success' });
        } catch (error) {
          sendResponse({ isOk: false, msg: 'set localStorage error', result: error });
        }
        return false;
      }

      if (message.type === MessageType.GetPageStorage) {
        const payload = message.payload as PageStoragePayload;
        if (!inScope(payload)) return false;
        void (async () => {
          try {
            const snapshot = readPageSnapshot();
            const indexedDb = payload.includeIndexedDB ? await captureIndexedDb() : undefined;
            sendResponse({
              isOk: true,
              msg: 'get page storage success',
              result: {
                ...snapshot,
                sessionStorageItems: payload.includeSessionStorage === false ? [] : snapshot.sessionStorageItems,
                ...(indexedDb ? { indexedDBRecords: indexedDb.records, skippedIndexedDB: indexedDb.skipped } : {}),
              },
            });
          } catch (error) {
            sendResponse({ isOk: false, msg: 'get page storage error', result: error });
          }
        })();
        return true;
      }

      if (message.type === MessageType.SetPageStorage) {
        const payload = message.payload as SetPageStoragePayload;
        if (!inScope(payload)) return false;
        void (async () => {
          try {
            if (payload.localStorageItems) writeStorageArea(localStorage, payload.localStorageItems);
            if (payload.sessionStorageItems) {
              if (payload.replaceSession !== false) sessionStorage.clear();
              writeStorageArea(sessionStorage, payload.sessionStorageItems);
            }
            const indexedDb =
              payload.indexedDBRecords && payload.replaceIndexedDB !== false
                ? await restoreIndexedDb(payload.indexedDBRecords, location.origin)
                : undefined;
            onRemoteApplied();
            sendResponse({ isOk: true, msg: 'set page storage success', result: indexedDb });
          } catch (error) {
            sendResponse({ isOk: false, msg: 'set page storage error', result: error });
          }
        })();
        return true;
      }

      return false;
    },
  );
}
