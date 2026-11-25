import type { SendResponse } from '@sync-your-cookie/shared';

export type RouterHandler = (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
) => Promise<SendResponse | void> | SendResponse | void;

interface RegisteredRoute {
  scope: 'extension' | 'content';
  handler: RouterHandler;
}

const routes = new Map<string, RegisteredRoute>();
let mounted = false;

export const isFromExtensionPage = (sender: chrome.runtime.MessageSender): boolean =>
  sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));

export const isFromNormalWebTab = (sender: chrome.runtime.MessageSender): boolean =>
  !!sender.tab?.url?.startsWith('http') && !sender.tab.incognito;

export function registerExtensionHandler(type: string, handler: RouterHandler) {
  routes.set(type, { scope: 'extension', handler });
  ensureRouterMounted();
}

export function registerContentHandler(type: string, handler: RouterHandler) {
  routes.set(type, { scope: 'content', handler });
  ensureRouterMounted();
}

const dispatchMessage = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  reply: (response?: SendResponse) => void,
): boolean => {
  if (!message || typeof message !== 'object' || !('type' in message)) return false;
  const type = String((message as { type?: unknown }).type || '');
  const route = routes.get(type);
  if (!route) return false;

  if (route.scope === 'extension' && !isFromExtensionPage(sender)) {
    reply({ isOk: false, msg: '仅扩展内部页面可执行此操作' });
    return false;
  }
  if (route.scope === 'content' && !isFromNormalWebTab(sender)) {
    return false;
  }

  try {
    const outcome = route.handler(message as Record<string, unknown>, sender);
    if (outcome && typeof (outcome as Promise<SendResponse | void>).then === 'function') {
      void (outcome as Promise<SendResponse | void>)
        .then(res => {
          reply(res ?? { isOk: true, msg: 'ok' });
        })
        .catch(error => {
          const msg = error instanceof Error ? error.message : String(error || '操作失败');
          const code = typeof error === 'object' && error && 'code' in error ? (error as { code?: never }).code : undefined;
          reply({ isOk: false, msg, code });
        });
      return true;
    }
    if (outcome) {
      reply(outcome as SendResponse);
    }
    return false;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error || '操作失败');
    reply({ isOk: false, msg });
    return false;
  }
};

export function ensureRouterMounted() {
  if (mounted) return;
  if (!chrome.runtime?.onMessage?.addListener) return;
  chrome.runtime.onMessage.addListener(dispatchMessage);
  mounted = true;
}

/** Testing helper to inspect or reset router state if needed. */
export function hasRoute(type: string): boolean {
  return routes.has(type);
}
