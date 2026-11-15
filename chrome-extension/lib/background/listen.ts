import {
  check,
  syncCookieDomain,
  checkResponseAndCallback,
  CookieOperator,
  extractDomainAndPort,
  ICookie,
  Message,
  MessageType,
  pullAndSetCookies,
  PushCookieMessagePayload,
  pushCookies,
  removeCookieItem,
  removeCookies,
  sendGetLocalStorageMessage,
  SendResponse,
} from '@sync-your-cookie/shared';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';

import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { domainStatusStorage } from '@sync-your-cookie/storage/lib/domainStatusStorage';

type HandleCallback = (response?: SendResponse) => void;

const handlePush = async (payload: PushCookieMessagePayload, callback: HandleCallback) => {
  const { sourceUrl, host, favIconUrl } = payload || {};
  const userAgent = navigator?.userAgent || '';
  try {
    await check();
    const previousConfig = (await domainConfigStorage.get()).domainMap[host];
    await domainConfigStorage.updateItem(host, {
      autoPush: previousConfig?.autoPush ?? true,
      autoPull: previousConfig?.autoPull ?? true,
      sourceUrl: sourceUrl,
      favIconUrl,
    });
    await domainStatusStorage.updateItem(host, {
      pushing: true,
    });
    const [domain, port, hostname] = await extractDomainAndPort(host);
    const condition = { domain: syncCookieDomain(sourceUrl ? new URL(sourceUrl).hostname : domain) };
    const cookies = await chrome.cookies.getAll(condition);

    let localStorageItems: NonNullable<Parameters<typeof pushCookies>[2]> = [];
    const includeLocalStorage = settingsStorage.getSnapshot()?.includeLocalStorage !== false;
    if (includeLocalStorage) {
      try {
        const hostname = sourceUrl ? new URL(sourceUrl).hostname : host;
        localStorageItems = await sendGetLocalStorageMessage(hostname);
      } catch (error) {
        const cookieMap = await cookieStorage.getSnapshot();
        localStorageItems = cookieMap?.domainCookieMap?.[host]?.localStorageItems || [];
      }
    } else {
      const cookieMap = await cookieStorage.getSnapshot();
      localStorageItems = cookieMap?.domainCookieMap?.[host]?.localStorageItems || [];
    }

    if (cookies?.length || localStorageItems.length) {
      const res = await pushCookies(host, cookies, localStorageItems, userAgent);
      checkResponseAndCallback(res, 'push', callback);
    } else {
      callback({ isOk: false, msg: '未找到 Cookie 或 LocalStorage，请先确认已登录', result: cookies });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    checkResponseAndCallback(err, 'push', callback);
  } finally {
    await domainStatusStorage.togglePushingState(host, false);
  }
};

const handlePull = async (activeTabUrl: string, domain: string, isReload: boolean, callback: HandleCallback) => {
  try {
    await check();
    await domainStatusStorage.togglePullingState(domain, true);
    const cookieMap = await pullAndSetCookies(activeTabUrl, domain, isReload);

    const previousConfig = (await domainConfigStorage.get()).domainMap[domain];
    await domainConfigStorage.updateItem(domain, {
      autoPull: previousConfig?.autoPull ?? true,
      autoPush: previousConfig?.autoPush ?? true,
      sourceUrl: activeTabUrl,
    });
    callback({ isOk: true, msg: '拉取成功', result: cookieMap });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    checkResponseAndCallback(err, 'pull', callback);
  } finally {
    await domainStatusStorage.togglePullingState(domain, false);
  }
};

const handleRemove = async (domain: string, callback: HandleCallback) => {
  try {
    await check();
    const res = await removeCookies(domain);
    checkResponseAndCallback(res, 'remove', callback);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    checkResponseAndCallback(err, 'remove', callback);

    // callback({ isOk: false, msg: (err as Error).message || 'remove fail, please try again ', result: err });
  }
};

const handleRemoveItem = async (domain: string, id: string, callback: HandleCallback) => {
  try {
    await check();
    const res = await removeCookieItem(domain, id);
    checkResponseAndCallback(res, 'delete', callback);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    checkResponseAndCallback(err, 'delete', callback);
  }
};

const handleEditItem = async (domain: string, oldItem: ICookie, newItem: ICookie, callback: HandleCallback) => {
  try {
    await check();
    const res = await CookieOperator.editCookieItem(domain, oldItem, newItem);
    checkResponseAndCallback(res, 'edit', callback);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    checkResponseAndCallback(err, 'edit', callback);
  }
};
function handleMessage(
  message: Message,
  sender: chrome.runtime.MessageSender,
  callback: (response?: SendResponse) => void,
) {
  const type = message.type;
  switch (type) {
    case MessageType.PushCookie:
      handlePush(message.payload, callback);
      break;
    case MessageType.PullCookie:
      // eslint-disable-next-line no-case-declarations, @typescript-eslint/no-non-null-asserted-optional-chain
      const activeTabUrl = message.payload.activeTabUrl || sender.tab?.url!;
      handlePull(activeTabUrl!, message.payload.domain, message.payload.reload, callback);
      break;
    case MessageType.RemoveCookie:
      handleRemove(message.payload.domain, callback);
      break;
    case MessageType.RemoveCookieItem:
      handleRemoveItem(message.payload.domain, message.payload.id, callback);
      break;
    case MessageType.EditCookieItem:
      handleEditItem(message.payload.domain, message.payload.oldItem, message.payload.newItem, callback);
      break;
    default:
      break;
  }
  return true;
}
export const refreshListen = async () => {
  chrome.runtime.onMessage.removeListener(handleMessage);
  chrome.runtime.onMessage.addListener(handleMessage);
};
