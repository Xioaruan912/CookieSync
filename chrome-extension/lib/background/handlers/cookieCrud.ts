import {
  check,
  CookieOperator,
  MessageType,
  refreshRemoteCookies,
  removeCookieItem,
  removeCookies,
  type EditCookieItemMessagePayload,
  type PullCookieMessagePayload,
  type PushCookieMessagePayload,
  type RemoveCookieItemMessagePayload,
  type RemoveCookieMessagePayload,
} from '@sync-your-cookie/shared';
import { registerExtensionHandler } from '../router';
import { pullSingleSite, pushSingleSite } from '../sync/batch';

export function initCookieCrudHandlers() {
  registerExtensionHandler(MessageType.RefreshCookies, async () => {
    await refreshRemoteCookies();
    return { isOk: true, msg: '远程列表已刷新' };
  });

  registerExtensionHandler(MessageType.PushCookie, async message => {
    const payload = message.payload as PushCookieMessagePayload;
    const summary = await pushSingleSite(payload.host, {
      sourceUrl: payload.sourceUrl,
      favIconUrl: payload.favIconUrl,
      requireListed: false,
      createSnapshot: true,
    });
    return { isOk: true, msg: '推送成功', result: summary };
  });

  registerExtensionHandler(MessageType.PullCookie, async (message, sender) => {
    const payload = message.payload as PullCookieMessagePayload;
    const activeTabUrl = payload.activeTabUrl || sender.tab?.url;
    await pullSingleSite(payload.domain, {
      activeTabUrl,
      reload: payload.reload,
      requireListed: false,
      createSnapshot: true,
    });
    return { isOk: true, msg: '拉取成功' };
  });

  registerExtensionHandler(MessageType.RemoveCookie, async message => {
    const payload = message.payload as RemoveCookieMessagePayload;
    await check();
    const res = await removeCookies(payload.domain);
    return res.success ? { isOk: true, msg: '移除成功' } : { isOk: false, msg: '移除失败，请重试' };
  });

  registerExtensionHandler(MessageType.RemoveCookieItem, async message => {
    const payload = message.payload as RemoveCookieItemMessagePayload;
    await check();
    const res = await removeCookieItem(payload.domain, payload.id);
    return res.success ? { isOk: true, msg: '删除成功' } : { isOk: false, msg: '删除失败，请重试' };
  });

  registerExtensionHandler(MessageType.EditCookieItem, async message => {
    const payload = message.payload as EditCookieItemMessagePayload;
    await check();
    const res = await CookieOperator.editCookieItem(payload.domain, payload.oldItem, payload.newItem);
    return res.success ? { isOk: true, msg: '编辑成功' } : { isOk: false, msg: '编辑失败，请重试' };
  });
}
