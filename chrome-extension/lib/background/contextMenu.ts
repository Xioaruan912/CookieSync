import { extractDomainAndPort } from '@sync-your-cookie/shared';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { sitePolicyStorage } from '@sync-your-cookie/storage/lib/sitePolicyStorage';

const MENU_ID = 'openSidePanel';
const ADD_CURRENT_SITE_ID = 'addCurrentSiteToSync';
let clickListenerBound = false;

export const initContextMenu = () => {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.remove(MENU_ID, () => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '打开 Cookie 同步管理',
      contexts: ['all'],
    });
  });

  chrome.contextMenus.remove(ADD_CURRENT_SITE_ID, () => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: ADD_CURRENT_SITE_ID,
      title: '一键加入当前网站到同步名单',
      contexts: ['page'],
    });
  });

  if (!clickListenerBound) {
    clickListenerBound = true;
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      if (info.menuItemId === MENU_ID && tab?.windowId) {
        void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
        return;
      }
      if (info.menuItemId === ADD_CURRENT_SITE_ID && tab?.url && /^https?:\/\//.test(tab.url) && !tab.incognito) {
        void (async () => {
          try {
            const [host, port] = await extractDomainAndPort(tab.url!);
            const domain = port ? `${host}:${port}` : host;
            if (!domain) return;
            await sitePolicyStorage.setRule(domain, true);
            await domainConfigStorage.updateItem(domain, {
              autoPush: true,
              autoPull: true,
              sourceUrl: tab.url,
              ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
            });
          } catch {
            /* Ignore invalid or restricted pages. */
          }
        })();
      }
    });
  }
};

export const removeContextMenu = () => {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.remove(MENU_ID, () => {
    void chrome.runtime.lastError;
  });
  chrome.contextMenus.remove(ADD_CURRENT_SITE_ID, () => {
    void chrome.runtime.lastError;
  });
};
