import { checkProfileHealth, siteProfileFor } from '@sync-your-cookie/shared/lib/siteProfiles';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { siteHealthStorage } from '@sync-your-cookie/storage/lib/siteHealthStorage';

/**
 * Login health checks ask the site — with the restored cookie jar — whether
 * the synced session is actually alive. Checks run only after a restore, on
 * explicit request, or once daily: never on the two-minute sync loop, because
 * each call carries the user's session to an external API.
 */
const alarmName = 'cookiesync-site-health';
const minIntervalMs = 10 * 60000;

const checking = new Map<string, Promise<void>>();

export async function checkSiteHealth(domain: string, options?: { force?: boolean }): Promise<void> {
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
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (
      message?.type === 'CookieSyncCheckSiteHealth' &&
      sender.id === chrome.runtime.id &&
      sender.url?.startsWith(chrome.runtime.getURL(''))
    ) {
      void checkSiteHealth(message.domain, { force: true })
        .then(() => reply({ isOk: true }))
        .catch(() => reply({ isOk: false }));
      return true;
    }
    return false;
  });
}
