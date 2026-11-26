// sort-imports-ignore
import 'webextension-polyfill';

import { accountStorage } from '@sync-your-cookie/storage/lib/accountStorage';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { domainStatusStorage } from '@sync-your-cookie/storage/lib/domainStatusStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { initAutomaticSync, setAutomaticSyncReady, startAutomaticSession, flushAutomaticSync } from './automaticSync';
import { initBadgeController } from './badgeController';
import { initContextMenu, removeContextMenu } from './contextMenu';
import { initCookieCrudHandlers } from './handlers/cookieCrud';
import { initSiteHealthChecks } from './healthCheck';
import { initOverview } from './overview';
import { ensureRouterMounted } from './router';
import { initSafety } from './safety';

function bindSettingsSubscriptions() {
  let previousContextMenu: boolean | undefined;
  settingsStorage.subscribe(() => {
    const snapshot = settingsStorage.getSnapshot();
    if (previousContextMenu === snapshot?.contextMenu) return;
    previousContextMenu = snapshot?.contextMenu;
    if (snapshot?.contextMenu) initContextMenu();
    else removeContextMenu();
  });

  let previousProvider = accountStorage.getSnapshot()?.selectedProvider;
  accountStorage.subscribe(async () => {
    const nextProvider = accountStorage.getSnapshot()?.selectedProvider;
    if (nextProvider === previousProvider) return;
    previousProvider = nextProvider;
    await domainStatusStorage.resetState();
    await cookieStorage.reset();
  });
}

const init = async () => {
  try {
    await domainStatusStorage.resetState();
    bindSettingsSubscriptions();
  } catch {
    /* Best-effort worker recovery. */
  }
};

chrome.runtime.onInstalled.addListener(async () => {
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false });
  const settings = await settingsStorage.get();
  if (settings?.contextMenu) initContextMenu();
});

// Register all modules onto the single message router before awaiting async init.
ensureRouterMounted();
initCookieCrudHandlers();
initAutomaticSync();
initSiteHealthChecks();
initOverview();
initSafety();
initBadgeController();

// MV3 restarts the worker; restore state cleanly without duplicate startup pulls.
const backgroundReady = init();
setAutomaticSyncReady(backgroundReady);
void backgroundReady
  .then(() => startAutomaticSession())
  .then(() => flushAutomaticSync(false, true))
  .catch(() => {});
