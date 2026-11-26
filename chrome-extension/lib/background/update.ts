import { checkLatestRelease, downloadRelease } from '@sync-your-cookie/shared/lib/update';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { updateStatusStorage } from '@sync-your-cookie/storage/lib/updateStatusStorage';

const alarmName = 'cookiesync-update-check';
const alarmPeriodMinutes = 720;

async function runUpdateCheck(allowDownload: boolean) {
  try {
    await checkLatestRelease();
  } catch {
    // checkLatestRelease already recorded the failure; retry on the next alarm.
    return;
  }
  if (!allowDownload) return;
  const settings = await settingsStorage.get();
  if (settings.autoUpdateDownload === false) return;
  const status = await updateStatusStorage.get();
  if (status.state === 'available' && !status.error) {
    // Auto-download is best effort: failures surface on the options page.
    await downloadRelease().catch(() => {});
  }
}

export function initUpdateChecks() {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === alarmName) void runUpdateCheck(true);
  });
  chrome.runtime.onStartup.addListener(() => {
    void runUpdateCheck(true);
  });
  chrome.runtime.onInstalled.addListener(() => {
    void runUpdateCheck(true);
  });
  // The alarm survives MV3 worker restarts; a short delay keeps startup light.
  void chrome.alarms.create(alarmName, { delayInMinutes: 5, periodInMinutes: alarmPeriodMinutes });
}
