import { ICookie, ILocalStorageItem } from '@sync-your-cookie/protobuf';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import pTimeout from 'p-timeout';
import { pageOrigin } from '../cookie/storageScope';
export type { ICookie };
export enum MessageType {
  PushCookie = 'PushCookie',
  RefreshCookies = 'RefreshCookies',
  PullCookie = 'PullCookie',
  RemoveCookie = 'RemoveCookie',
  RemoveCookieItem = 'RemoveCookieItem',
  EditCookieItem = 'EditCookieItem',
  // LocalStorage
  GetLocalStorage = 'GetLocalStorage',
  SetLocalStorage = 'SetLocalStorage',
  // Origin-tagged localStorage + sessionStorage (1.16+). The content script of
  // an extension version that was reloaded mid-session does not know these, so
  // callers fall back to the two messages above.
  GetPageStorage = 'GetPageStorage',
  SetPageStorage = 'SetPageStorage',
}

export enum MessageErrorCode {
  AccountCheck = 'AccountCheck',
  DecryptFailed = 'DecryptFailed',
  DecodeFailed = 'DecodeFailed',
}

export type PushCookieMessagePayload = {
  host: string;
  sourceUrl?: string;
  favIconUrl?: string;
};

export type DomainPayload = {
  domain: string;
};

export type RemoveCookieMessagePayload = {
  domain: string;
};

export type RemoveCookieItemMessagePayload = {
  domain: string;
  id: string;
};

export type PullCookieMessagePayload = {
  domain: string;
  activeTabUrl: string;
  reload: boolean;
};

export type EditCookieItemMessagePayload = {
  domain: string;
  oldItem: ICookie;
  newItem: ICookie;
};

export type SetLocalStorageMessagePayload = {
  domain: string;
  value: ILocalStorageItem[];
  onlyKey?: string;
};

export type PageStoragePayload = {
  domain: string;
  /** Exact origin requested by the background; the page compares it strictly. */
  origin?: string;
  includeSessionStorage?: boolean;
  includeIndexedDB?: boolean;
};

export type IndexedDbRecordPayload = {
  database: string;
  store: string;
  key: string;
  value: string;
  origin: string;
};

export type SetPageStoragePayload = {
  domain: string;
  origin?: string;
  localStorageItems?: ILocalStorageItem[];
  sessionStorageItems?: ILocalStorageItem[];
  indexedDBRecords?: IndexedDbRecordPayload[];
  /** Session storage is per tab, so restoring replaces the whole set. */
  replaceSession?: boolean;
  replaceIndexedDB?: boolean;
};

export type PageStorageResult = {
  origin: string;
  localStorageItems: ILocalStorageItem[];
  sessionStorageItems: ILocalStorageItem[];
  indexedDBRecords?: IndexedDbRecordPayload[];
  skippedIndexedDB?: string[];
};

export type MessageMap = {
  [MessageType.RefreshCookies]: { type: MessageType.RefreshCookies; payload: Record<string, never> };
  [MessageType.PushCookie]: {
    type: MessageType.PushCookie;
    payload: PushCookieMessagePayload;
  };
  [MessageType.RemoveCookie]: {
    type: MessageType.RemoveCookie;
    payload: RemoveCookieMessagePayload;
  };
  [MessageType.PullCookie]: {
    type: MessageType.PullCookie;
    payload: PullCookieMessagePayload;
  };
  [MessageType.RemoveCookieItem]: {
    type: MessageType.RemoveCookieItem;
    payload: RemoveCookieItemMessagePayload;
  };
  [MessageType.EditCookieItem]: {
    type: MessageType.EditCookieItem;
    payload: EditCookieItemMessagePayload;
  };
  // LocalStorage
  [MessageType.GetLocalStorage]: {
    type: MessageType.GetLocalStorage;
    payload: DomainPayload;
  };
  [MessageType.SetLocalStorage]: {
    type: MessageType.SetLocalStorage;
    payload: SetLocalStorageMessagePayload;
  };
  [MessageType.GetPageStorage]: {
    type: MessageType.GetPageStorage;
    payload: PageStoragePayload;
  };
  [MessageType.SetPageStorage]: {
    type: MessageType.SetPageStorage;
    payload: SetPageStoragePayload;
  };
};

// export type Message<T extends MessageType = MessageType> = {
//   type: T;
//   payload: MessagePayloadMap[T];
// };

export type Message<T extends MessageType = MessageType> = MessageMap[T];

export type SendResponse = {
  isOk: boolean;
  msg: string;
  result?: unknown;
  code?: MessageErrorCode;
};

export function sendMessage<T extends MessageType>(message: Message<T>, isTab = false, useTimeout: boolean = false) {
  const send = (resolve: (value: SendResponse | PromiseLike<SendResponse>) => void, reject: (reason?: any) => void) => {
    chrome.runtime.sendMessage(message, function (result: SendResponse) {
      if (result?.isOk) {
        resolve(result);
      } else {
        reject(result as SendResponse);
      }
    });
  };
  const fn = () => {
    if (isTab) {
      return new Promise<SendResponse>((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, async function (tabs) {
          if (tabs.length === 0) {
            // const allOpendTabs = await chrome.tabs.query({});

            // reject({ isOk: false, msg: 'No active tab found' } as SendResponse);
            send(resolve, reject);
            return;
          }
          chrome.tabs.sendMessage(tabs[0].id!, message, function (result) {
            if (result?.isOk) {
              resolve(result);
            } else {
              reject(result as SendResponse);
            }
          });
        });
      });
    }
    return new Promise<SendResponse>((resolve, reject) => {
      send(resolve, reject);
    });
  };
  if (useTimeout) {
    return pTimeout(fn(), {
      milliseconds: 5000,
      fallback: () => {
        return { isOk: false, msg: 'Timeout' } as SendResponse;
      },
    });
  }
  return fn();
}

export function pushCookieUsingMessage(payload: PushCookieMessagePayload) {
  return sendMessage<MessageType.PushCookie>({
    payload,
    type: MessageType.PushCookie,
  });
}

export function removeCookieUsingMessage(payload: RemoveCookieMessagePayload) {
  return sendMessage<MessageType.RemoveCookie>({
    payload,
    type: MessageType.RemoveCookie,
  });
}

export function pullCookieUsingMessage(payload: PullCookieMessagePayload) {
  return sendMessage<MessageType.PullCookie>({
    payload,
    type: MessageType.PullCookie,
  });
}

export function removeCookieItemUsingMessage(payload: RemoveCookieItemMessagePayload) {
  const sendType = MessageType.RemoveCookieItem;
  return sendMessage<typeof sendType>({
    payload,
    type: sendType,
  });
}

export function editCookieItemUsingMessage(payload: EditCookieItemMessagePayload) {
  const sendType = MessageType.EditCookieItem;
  return sendMessage<typeof sendType>({
    payload,
    type: sendType,
  });
}

export const getTabsByHost = async (host: string) => {
  return new Promise<chrome.tabs.Tab[]>((resolve, reject) => {
    try {
      chrome.tabs.query({}, function (tabs) {
        const matchedTabs = tabs.filter(tab => tab.url && tab.id && tab.url.includes(host));
        resolve(matchedTabs);
      });
    } catch (error) {
      reject(error);
    }
  });
};

const validItems = (value: unknown): ILocalStorageItem[] | undefined =>
  Array.isArray(value) &&
  value.every(item => item && typeof item.key === 'string' && typeof item.value === 'string')
    ? (value as ILocalStorageItem[])
    : undefined;

/**
 * Reads one tab's origin-tagged storage. Falls back to the pre-1.16 message so
 * pages that still run an older content script (the extension was reloaded
 * while they stayed open) keep working: their snapshot is tagged with the tab's
 * own origin and carries no session storage.
 */
export const sendPageStorageMessage = async (
  host: string,
  isTry = true,
  includeSessionStorage = true,
  includeIndexedDB = false,
): Promise<PageStorageResult | undefined> => {
  const read = async (): Promise<PageStorageResult> => {
    const newer = await sendMessage(
      {
        type: MessageType.GetPageStorage,
        payload: { domain: host, includeSessionStorage, includeIndexedDB },
      },
      true,
    ).catch(() => undefined);
    if (newer?.isOk) {
      const result = newer.result as Partial<PageStorageResult> | undefined;
      const localStorageItems = validItems(result?.localStorageItems);
      const indexedDBRecords = Array.isArray(result?.indexedDBRecords) ? result?.indexedDBRecords : undefined;
      const skippedIndexedDB = Array.isArray(result?.skippedIndexedDB) ? result?.skippedIndexedDB : undefined;
      if (localStorageItems)
        return {
          origin: typeof result?.origin === 'string' ? result.origin : '',
          localStorageItems,
          sessionStorageItems: validItems(result?.sessionStorageItems) || [],
          ...(indexedDBRecords ? { indexedDBRecords } : {}),
          ...(skippedIndexedDB ? { skippedIndexedDB } : {}),
        };
    }
    const legacy = await sendMessage(
      {
        type: MessageType.GetLocalStorage,
        payload: { domain: host },
      },
      true,
    );
    const localStorageItems = validItems(legacy.result);
    if (!legacy.isOk || !localStorageItems) throw new Error(legacy.msg || 'getLocalStorage fail');
    // Older content script: derive the origin from the tab we just read.
    const tab = await new Promise<chrome.tabs.Tab | undefined>(resolve =>
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0])),
    );
    return { origin: pageOrigin(tab?.url) || '', localStorageItems, sessionStorageItems: [] };
  };

  return new Promise<PageStorageResult | undefined>(async (resolve, reject) => {
    const myResolve = (value: PageStorageResult | undefined) => {
      settingsStorage.update({
        localStorageGetting: false,
      });
      resolve(value);
    };
    const myReject = (err: any) => {
      settingsStorage.update({
        localStorageGetting: false,
      });
      reject(err);
    };
    settingsStorage.update({
      localStorageGetting: true,
    });
    try {
      myResolve(await read());
    } catch {
      if (isTry == false) {
        myReject(new Error('getLocalStorage fail'));
        return;
      }
      const matchedTabs = await getTabsByHost(host);
      if (matchedTabs.length === 0) {
        await chrome.tabs.create({
          url: 'https://' + host,
        });
      } else {
        const activeTab = matchedTabs.find(tab => tab.active);
        if (activeTab) {
          chrome.tabs.reload(activeTab.id!);
        } else {
          matchedTabs.forEach(function (tab) {
            chrome.tabs.reload(tab.id!);
          });
        }
      }
      setTimeout(async () => {
        try {
          myResolve(await sendPageStorageMessage(host, false, includeSessionStorage, includeIndexedDB));
        } catch (error) {
          myReject(error);
        }
      }, 500);
    }
  });
};

export const sendGetLocalStorageMessage = async (host: string, isTry = true) =>
  (await sendPageStorageMessage(host, isTry))?.localStorageItems || [];

export const refreshCookiesUsingMessage = () =>
  sendMessage<MessageType.RefreshCookies>({ type: MessageType.RefreshCookies, payload: {} });
