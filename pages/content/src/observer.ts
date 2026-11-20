import {
  DomainPayload,
  MessageType,
  PageStoragePayload,
  SendResponse,
  SetLocalStorageMessagePayload,
  SetPageStoragePayload,
} from '@sync-your-cookie/shared';
import { matchesSiteScope } from '@sync-your-cookie/shared/lib/cookie/restore';
import { messageListener } from './listener';
import { readPageSnapshot } from './snapshot';
import { captureIndexedDb, restoreIndexedDb } from './indexedDb';

class Observer {
  observers: any[] = [];

  constructor() {}

  // 订阅获取本地存储
  subscribeGetLocalStorage(callback: (data: any, sendResponse: (data: SendResponse) => void) => void) {
    messageListener.on(MessageType.GetLocalStorage, callback);
  }

  subscribeSetLocalStorage(callback: (data: any, sendResponse: (data: SendResponse) => void) => void) {
    messageListener.on(MessageType.SetLocalStorage, callback);
  }

  subscribeGetPageStorage(callback: (data: any, sendResponse: (data: SendResponse) => void) => void) {
    messageListener.on(MessageType.GetPageStorage, callback);
  }

  subscribeSetPageStorage(callback: (data: any, sendResponse: (data: SendResponse) => void) => void) {
    messageListener.on(MessageType.SetPageStorage, callback);
  }
}

export const observer = new Observer();

/**
 * The background addresses one exact origin. The old host check accepted any
 * origin that merely contained the domain (evil-example.com for example.com),
 * so the legacy path now uses the same site-family boundary as cookies.
 */
const inScope = (payload: { domain: string; origin?: string }) =>
  payload.origin ? payload.origin === location.origin : matchesSiteScope(payload.domain, location.host);

const setItems = (area: Storage, items: { key?: string | null; value?: string | null }[]) => {
  for (const item of items) area.setItem(item.key || '', item.value || '');
};

class eventHandler {
  constructor() {
    // this.init();
  }

  init() {
    this.handleGetLocalStorage();
    this.handleSetLocalStorage();
    this.handleGetPageStorage();
    this.handleSetPageStorage();
  }

  handleGetLocalStorage() {
    observer.subscribeGetLocalStorage(async (result: DomainPayload, sendResponse: (data: SendResponse) => void) => {
      if (inScope(result)) {
        try {
          const items: { key: string; value: string }[] = [];
          const localObject = { ...localStorage };
          for (const key in localObject) {
            const value: string = localObject[key].toString();
            items.push({ key, value });
          }

          sendResponse({
            isOk: true,
            msg: 'get localStorage success',
            result: items,
          });
          // const json = JSON.parse(result.response);
        } catch (error) {
          sendResponse({
            isOk: false,
            msg: 'get localStorage error',
            result: error,
          });
        }
      } else {
      }
    });
  }

  handleSetLocalStorage() {
    observer.subscribeSetLocalStorage(
      async (result: SetLocalStorageMessagePayload, sendResponse: (data: SendResponse) => void) => {
        if (inScope(result)) {
          try {
            const values = result.value;
            const setKey = result.onlyKey;
            if (setKey) {
              const targetItem = values.find((item: any) => item.key === setKey);
              if (targetItem) {
                localStorage.setItem(setKey, targetItem.value || '');
              } else {
              }
            } else {
              setItems(localStorage, values);
            }
            sendResponse({
              isOk: true,
              msg: 'set localStorage success',
            });
            // const json = JSON.parse(result.response);
          } catch (error) {
            sendResponse({
              isOk: false,
              msg: 'set localStorage error',
              result: error,
            });
          }
        } else {
        }
      },
    );
  }

  handleGetPageStorage() {
    observer.subscribeGetPageStorage(async (result: PageStoragePayload, sendResponse: (data: SendResponse) => void) => {
      if (!inScope(result)) return;
      try {
        const snapshot = readPageSnapshot();
        const indexedDb = result.includeIndexedDB ? await captureIndexedDb() : undefined;
        sendResponse({
          isOk: true,
          msg: 'get page storage success',
          result: {
            ...snapshot,
            sessionStorageItems: result.includeSessionStorage === false ? [] : snapshot.sessionStorageItems,
            ...(indexedDb
              ? { indexedDBRecords: indexedDb.records, skippedIndexedDB: indexedDb.skipped }
              : {}),
          },
        });
      } catch (error) {
        sendResponse({ isOk: false, msg: 'get page storage error', result: error });
      }
    });
  }

  handleSetPageStorage() {
    observer.subscribeSetPageStorage(
      async (result: SetPageStoragePayload, sendResponse: (data: SendResponse) => void) => {
        if (!inScope(result)) return;
        try {
          if (result.localStorageItems) setItems(localStorage, result.localStorageItems);
          if (result.sessionStorageItems) {
            // Session storage belongs to this tab: restoring replaces the set so
            // a stale key from an older session cannot survive.
            if (result.replaceSession !== false) sessionStorage.clear();
            setItems(sessionStorage, result.sessionStorageItems);
          }
          let indexedDb;
          if (result.indexedDBRecords && result.replaceIndexedDB !== false)
            indexedDb = await restoreIndexedDb(result.indexedDBRecords, location.origin);
          sendResponse({ isOk: true, msg: 'set page storage success', result: indexedDb });
        } catch (error) {
          sendResponse({ isOk: false, msg: 'set page storage error', result: error });
        }
      },
    );
  }
}
export const eventHandlerInstance = new eventHandler();
