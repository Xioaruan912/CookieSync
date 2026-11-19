import { initAutomaticSync, flushAutomaticSync, setAutomaticSyncReady, startAutomaticSession } from './automaticSync';
// sort-imports-ignore
import 'webextension-polyfill';

import {
  pullAndSetCookies,
  pullCookies,
  syncCookieDomain,
  matchesSyncDomain,
} from '@sync-your-cookie/shared';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { domainStatusStorage } from '@sync-your-cookie/storage/lib/domainStatusStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { initContextMenu } from './contextMenu';
import { refreshListen } from './listen';
import { initSubscribe } from './subscribe';
import { initUpdateChecks } from './update';

const ping = () => {
  chrome.tabs.query({ active: true, currentWindow: true }, async function (tabs) {
    if (tabs.length === 0) {
      // const allOpendTabs = await chrome.tabs.query({});

      // reject({ isOk: false, msg: 'No active tab found' } as SendResponse);
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id!, 'ping', function (result) {});
  });
  // setTimeout(ping, 4000);
};

const init = async () => {
  try {
    await refreshListen();

    await initSubscribe(); // await state reset finish

    await pullCookies(true);

    // ping();
  } catch (error) {}
};

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  const settingsSnapShot = await settingsStorage.get();
  if (settingsSnapShot?.contextMenu) {
    initContextMenu();
  }
});

initAutomaticSync();
initUpdateChecks();

chrome.tabs.onActivated.addListener(async function () {
  const domainStatus = await domainStatusStorage.get();
  const settingsStorageInfo = await settingsStorage.get();
  if (!domainStatus.pulling && !domainStatus.pushing && !settingsStorageInfo.localStorageGetting) {
    refreshListen();
  }
});

// MV3 restarts the worker; listeners/subscriptions must be restored every time.
const backgroundReady = init();
setAutomaticSyncReady(backgroundReady);
void backgroundReady.then(() => startAutomaticSession()).then(() => flushAutomaticSync());
