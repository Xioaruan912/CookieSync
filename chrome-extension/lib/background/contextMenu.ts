const MENU_ID = 'openSidePanel';
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

  if (!clickListenerBound) {
    clickListenerBound = true;
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      if (info.menuItemId === MENU_ID && tab?.windowId) {
        void chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
      }
    });
  }
};

export const removeContextMenu = () => {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.remove(MENU_ID, () => {
    void chrome.runtime.lastError;
  });
};
