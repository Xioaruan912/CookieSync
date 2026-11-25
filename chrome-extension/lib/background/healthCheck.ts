import { RuntimeMessageType } from '@sync-your-cookie/shared';
import { checkProfileHealth, siteProfileFor } from '@sync-your-cookie/shared/lib/siteProfiles';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { siteHealthStorage } from '@sync-your-cookie/storage/lib/siteHealthStorage';
import { isDeviceStandby } from './activeDevice/leaseManager';
import { registerExtensionHandler } from './router';

/**
 * Login health checks ask the site — with the restored cookie jar — whether
 * the synced session is actually alive. Checks ONLY run on the active device
 * (never on a standby PC, so idle PCs never poke 115 servers from another IP).
 */
const alarmName = 'cookiesync-site-health';
const minIntervalMs = 10 * 60000;

const checking = new Map<string, Promise<void>>();

export async function checkSiteHealth(domain: string, options?: { force?: boolean }): Promise<void> {
  if (!options?.force && isDeviceStandby()) return;
  const profile = siteProfileFor(domain);
  if (!profile?.healthCheck) return;
  if (checking.has(profile.domain)) return checking.get(profile.domain);
  if (!options?.force) {
    const entry = (await siteHealthStorage.get())[profile.domain];
    if (entry?.checkedAt && Date.now() - entry.checkedAt < minIntervalMs) return;
  }
  const run = (async () => {
    const result = await checkProfileHealth(profile);
    await siteHealthStorage.updateDomain(profile.domain, {
      state: result.state,
      checkedAt: Date.now(),
      message: result.message,
      userName: result.state === 'ok' ? result.userName : undefined,
    });
  })()
    .catch(() => {})
    .finally(() => {
      checking.delete(profile.domain);
    });
  checking.set(profile.domain, run);
  return run;
}

async function runDailyChecks() {
  if (isDeviceStandby()) return;
  try {
    const config = await domainConfigStorage.get();
    for (const domain of Object.keys(config.domainMap)) {
      if (siteProfileFor(domain)) void checkSiteHealth(domain);
    }
  } catch {
    /* Try again on the next alarm. */
  }
}

export function initSiteHealthChecks() {
  void chrome.alarms.create(alarmName, { delayInMinutes: 30, periodInMinutes: 720 });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === alarmName) void runDailyChecks();
  });
  registerExtensionHandler(RuntimeMessageType.CheckSiteHealth, async message => {
    await checkSiteHealth(String(message.domain || ''), { force: true });
    return { isOk: true, msg: '健康检查完成' };
  });
}
