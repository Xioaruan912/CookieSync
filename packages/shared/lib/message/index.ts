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
  // Page storage
  GetLocalStorage = 'GetLocalStorage',
  SetLocalStorage = 'SetLocalStorage',
  GetPageStorage = 'GetPageStorage',
  SetPageStorage = 'SetPageStorage',
}

/** Unified background command & content event identifiers. */
export const RuntimeMessageType = {
  RunAutomaticSync: 'CookieSyncRunAutomaticSync',
  RecheckStorageLimits: 'CookieSyncRecheckStorageLimits',
  PullAll: 'CookieSyncPullAll',
  PushAll: 'CookieSyncPushAll',
  Overview: 'CookieSyncOverview',
  PushSite: 'CookieSyncPushSite',
  PullSite: 'CookieSyncPullSite',
  Rollback: 'CookieSyncRollback',
  Diagnostics: 'CookieSyncDiagnostics',
  BackupInfo: 'CookieSyncBackupInfo',
  RestoreBackup: 'CookieSyncRestoreBackup',
  CheckSiteHealth: 'CookieSyncCheckSiteHealth',
  TakeoverNow: 'CookieSyncTakeoverNow',
  RenameDevice: 'CookieSyncRenameDevice',
  // Content-script events
  LocalStorageChanged: 'CookieSyncLocalStorageChanged',
  PageReady: 'CookieSyncPageReady',
} as const;

export type RuntimeMessageName = (typeof RuntimeMessageType)[keyof typeof RuntimeMessageType];

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
  [MessageType.PushCookie]: { type: MessageType.PushCookie; payload: PushCookieMessagePayload };
  [MessageType.RemoveCookie]: { type: MessageType.RemoveCookie; payload: RemoveCookieMessagePayload };
  [MessageType.PullCookie]: { type: MessageType.PullCookie; payload: PullCookieMessagePayload };
  [MessageType.RemoveCookieItem]: { type: MessageType.RemoveCookieItem; payload: RemoveCookieItemMessagePayload };
  [MessageType.EditCookieItem]: { type: MessageType.EditCookieItem; payload: EditCookieItemMessagePayload };
  [MessageType.GetLocalStorage]: { type: MessageType.GetLocalStorage; payload: DomainPayload };
  [MessageType.SetLocalStorage]: { type: MessageType.SetLocalStorage; payload: SetLocalStorageMessagePayload };
  [MessageType.GetPageStorage]: { type: MessageType.GetPageStorage; payload: PageStoragePayload };
  [MessageType.SetPageStorage]: { type: MessageType.SetPageStorage; payload: SetPageStoragePayload };
};

export type Message<T extends MessageType = MessageType> = MessageMap[T];

export type SendResponse<T = unknown> = {
  isOk: boolean;
  msg: string;
  result?: T;
  code?: MessageErrorCode;
};

export function sendMessage<T extends MessageType>(message: Message<T>, isTab = false, useTimeout = false) {
  const send = (
    resolve: (value: SendResponse | PromiseLike<SendResponse>) => void,
    reject: (reason?: unknown) => void,
  ) => {
    chrome.runtime.sendMessage(message, (result: SendResponse) => {
      if (result?.isOk) resolve(result);
      else reject(result || { isOk: false, msg: chrome.runtime.lastError?.message || '请求失败' });
    });
  };
  const fn = () => {
    if (isTab) {
      return new Promise<SendResponse>((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
          if (!tabs.length || tabs[0].id === undefined) {
            send(resolve, reject);
            return;
          }
          chrome.tabs.sendMessage(tabs[0].id, message, result => {
            if (result?.isOk) resolve(result);
            else reject(result || { isOk: false, msg: chrome.runtime.lastError?.message || '页面未响应' });
          });
        });
      });
    }
    return new Promise<SendResponse>((resolve, reject) => send(resolve, reject));
  };
  if (useTimeout) {
    return pTimeout(fn(), {
      milliseconds: 5000,
      fallback: () => ({ isOk: false, msg: 'Timeout' }) as SendResponse,
    });
  }
  return fn();
}

export async function sendRuntimeCommand<T = unknown>(
  message: { type: RuntimeMessageName; [key: string]: unknown },
): Promise<SendResponse<T>> {
  const response = (await chrome.runtime.sendMessage(message)) as SendResponse<T> | undefined;
  if (!response) return { isOk: false, msg: '后台服务未响应' };
  return response;
}

export function pushCookieUsingMessage(payload: PushCookieMessagePayload) {
  return sendMessage<MessageType.PushCookie>({ payload, type: MessageType.PushCookie });
}

export function removeCookieUsingMessage(payload: RemoveCookieMessagePayload) {
  return sendMessage<MessageType.RemoveCookie>({ payload, type: MessageType.RemoveCookie });
}

export function pullCookieUsingMessage(payload: PullCookieMessagePayload) {
  return sendMessage<MessageType.PullCookie>({ payload, type: MessageType.PullCookie });
}

export function removeCookieItemUsingMessage(payload: RemoveCookieItemMessagePayload) {
  return sendMessage<MessageType.RemoveCookieItem>({ payload, type: MessageType.RemoveCookieItem });
}

export function editCookieItemUsingMessage(payload: EditCookieItemMessagePayload) {
  return sendMessage<MessageType.EditCookieItem>({ payload, type: MessageType.EditCookieItem });
}

export const refreshCookiesUsingMessage = () =>
  sendMessage<MessageType.RefreshCookies>({ type: MessageType.RefreshCookies, payload: {} });

export const getTabsByHost = async (host: string): Promise<chrome.tabs.Tab[]> => {
  const tabs = await chrome.tabs.query({});
  return tabs.filter(tab => tab.url && tab.id && tab.url.includes(host));
};

const validItems = (value: unknown): ILocalStorageItem[] | undefined =>
  Array.isArray(value) &&
  value.every(item => item && typeof item.key === 'string' && typeof item.value === 'string')
    ? (value as ILocalStorageItem[])
    : undefined;

/**
 * Gently reads one active tab's origin-tagged page storage without ever
 * opening new tabs or force-reloading user tabs. Falls back to legacy
 * GetLocalStorage if the tab runs an older content script.
 */
export const sendPageStorageMessage = async (
  host: string,
  _isTry = true,
  includeSessionStorage = true,
  includeIndexedDB = false,
): Promise<PageStorageResult | undefined> => {
  await settingsStorage.update({ localStorageGetting: true }).catch(() => {});
  try {
    const newer = await sendMessage(
      {
        type: MessageType.GetPageStorage,
        payload: { domain: host, includeSessionStorage, includeIndexedDB },
      },
      true,
      true,
    ).catch(() => undefined);
    if (newer?.isOk) {
      const result = newer.result as Partial<PageStorageResult> | undefined;
      const localStorageItems = validItems(result?.localStorageItems);
      const indexedDBRecords = Array.isArray(result?.indexedDBRecords) ? result?.indexedDBRecords : undefined;
      const skippedIndexedDB = Array.isArray(result?.skippedIndexedDB) ? result?.skippedIndexedDB : undefined;
      if (localStorageItems) {
        return {
          origin: typeof result?.origin === 'string' ? result.origin : '',
          localStorageItems,
          sessionStorageItems: validItems(result?.sessionStorageItems) || [],
          ...(indexedDBRecords ? { indexedDBRecords } : {}),
          ...(skippedIndexedDB ? { skippedIndexedDB } : {}),
        };
      }
    }
    const legacy = await sendMessage(
      {
        type: MessageType.GetLocalStorage,
        payload: { domain: host },
      },
      true,
      true,
    ).catch(() => undefined);
    const localStorageItems = validItems(legacy?.result);
    if (!legacy?.isOk || !localStorageItems) return undefined;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [] as chrome.tabs.Tab[]);
    return { origin: pageOrigin(tabs[0]?.url) || '', localStorageItems, sessionStorageItems: [] };
  } finally {
    await settingsStorage.update({ localStorageGetting: false }).catch(() => {});
  }
};

export const sendGetLocalStorageMessage = async (host: string, isTry = true) =>
  (await sendPageStorageMessage(host, isTry))?.localStorageItems || [];
