import { collectSiteCookies, RuntimeMessageType } from '@sync-your-cookie/shared';
import { checkProfileHealth, missingLoginKeys, siteProfileFor } from '@sync-your-cookie/shared/lib/siteProfiles';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { siteHealthStorage } from '@sync-your-cookie/storage/lib/siteHealthStorage';
import { isDeviceStandby } from './activeDevice/leaseManager';
import { registerExtensionHandler } from './router';

/**
 * Login health checks verify whether the synced session is alive:
 * - Sites with a read-only `healthCheck` endpoint (e.g. 115) call it on the active device.
 * - Sites with `loginKeys` (e.g. Quark, Alipan, Baidu Pan) inspect the live browser cookie jar.
 */
const alarmName = 'cookiesync-site-health';
const minIntervalMs = 10 * 60000;

const checking = new Map<string, Promise<void>>();

export async function checkSiteHealth(domain: string, options?: { force?: boolean }): Promise<void> {
  if (!options?.force && isDeviceStandby()) return;
  const profile = siteProfileFor(domain);
  if (!profile || (!profile.healthCheck && !profile.loginKeys.length)) return;
  if (checking.has(profile.domain)) return checking.get(profile.domain);
  if (!options?.force) {
    const entry = (await siteHealthStorage.get())[profile.domain];
    if (entry?.checkedAt && Date.now() - entry.checkedAt < minIntervalMs) return;
  }
  const run = (async () => {
    const cookies = await collectSiteCookies(`https://${profile.domain}`).catch(() => []);
    const missing = missingLoginKeys(profile, cookies);

    if (profile.healthCheck) {
      const result = await checkProfileHealth(profile);
      await siteHealthStorage.updateDomain(profile.domain, {
        state: result.state,
        checkedAt: Date.now(),
        loginKeysMissing: missing.length > 0,
        message: result.message,
        userName: result.state === 'ok' ? result.userName : undefined,
      });
      return;
    }

    const total = profile.loginKeys.length;
    const present = total - missing.length;
    await siteHealthStorage.updateDomain(profile.domain, {
      state: missing.length === 0 ? 'ok' : 'invalid',
      checkedAt: Date.now(),
      loginKeysMissing: missing.length > 0,
      message:
        missing.length === 0
          ? `本机核心登录凭证齐全（${present}/${total}）`
          : `本机缺少核心登录凭证（${missing.join('、')}），请点击「扫码重新登录」完成登录`,
      userName: undefined,
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
