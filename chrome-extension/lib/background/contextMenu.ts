let globalMenuId: number | string = '';

export const initContextMenu = () => {
  globalMenuId = chrome.contextMenus.create({
    id: 'openSidePanel',
    title: '打开 Cookie 同步管理',
    contexts: ['all'],
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'openSidePanel' && tab?.windowId) {
      // This will open the panel in all the pages on the current window.

      chrome.sidePanel.open({ windowId: tab.windowId });
    }
  });
};

export const removeContextMenu = () => {
  if (globalMenuId) {
    chrome.contextMenus.remove(globalMenuId);
  }
};
