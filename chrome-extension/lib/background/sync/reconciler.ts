import {
  acknowledgeJobs,
  automaticIntervalMs,
  domainContentHash,
  editSyncJobs,
  getSyncBaseline,
  missingLoginKeys,
  pullAndSetCookies,
  pullCookies,
  pushMultipleDomainCookies,
  setSyncBaseline,
  siteProfileFor,
  syncDestinationKey,
  syncWebdavConfig,
  uaMismatchHint,
  waitSyncJobEdits,
} from '@sync-your-cookie/shared';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { isAutomaticCookieAllowed, isSiteAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { siteHealthStorage } from '@sync-your-cookie/storage/lib/siteHealthStorage';
import { readSiteRules } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import { syncRuntimeStorage } from '@sync-your-cookie/storage/lib/syncRuntimeStorage';
import {
  checkIfLeaseLost,
  isDeviceStandby,
  isDeviceTakingOver,
  publishDataWriteLease,
} from '../activeDevice/leaseManager';
import { checkSiteHealth } from '../healthCheck';
import {
  bindCaptureFlush,
  captureAutomaticSync,
  clearDestinationJobs,
  getActiveJobs,
  getJobs,
  waitCapture,
  type Jobs,
} from './capture';
import { discoverOpenSites } from './discovery';

const cookieAllowed = isAutomaticCookieAllowed;

let uploadInFlight: Promise<void> | undefined;
let reconcileInFlight: Promise<void> | undefined;
let uploadBatch: { key: string; jobs: Jobs } | undefined;

export function getUploadingJobs(key: string): Jobs {
  return uploadBatch?.key === key ? uploadBatch.jobs : {};
}

export const syncErrorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : typeof error === 'object' && error && 'message' in error
      ? String((error as { message: unknown }).message)
      : '自动同步失败，请检查连接和加密设置';

export function isUploadInFlight() {
  return !!uploadInFlight;
}

export async function waitReconcile() {
  if (reconcileInFlight) await reconcileInFlight;
}

export async function flushAutomaticSync(force = false, expedited = false): Promise<void> {
  if (uploadInFlight) return uploadInFlight;
  uploadInFlight = (async () => {
    const settings = await settingsStorage.get();
    const activeMode = settings.activeDeviceSync !== false;
    if (!force && activeMode && (isDeviceStandby() || isDeviceTakingOver())) return;
    if (settings.backgroundSync === false && !force) return;
    const key = await syncDestinationKey();
    let sent: Jobs = {};
    try {
      try {
        await syncWebdavConfig();
      } catch (configError) {
        await autoSyncStatusStorage.update({ error: syncErrorMessage(configError) });
      }
      await waitSyncJobEdits();
      if (!Object.keys(await getActiveJobs(key)).length) return;

      const rateKey = `${key}-last-attempt`;
      const lastAttempt = (await chrome.storage.local.get(rateKey))[rateKey] || 0;
      if (!force && !expedited && Date.now() - lastAttempt < automaticIntervalMs(settings.syncIntervalMinutes)) return;
      if (!force && expedited && activeMode && (await checkIfLeaseLost(() => clearDestinationJobs(key)))) return;
      if (!force && activeMode && (isDeviceStandby() || isDeviceTakingOver())) return;
      await chrome.storage.local.set({ [rateKey]: Date.now() });
      if (key !== (await syncDestinationKey())) return;
      sent = await getActiveJobs(key);
      if (!Object.keys(sent).length) return;

      uploadBatch = { key, jobs: sent };
      await autoSyncStatusStorage.update({ phase: 'uploading', lastAttempt: Date.now() });
      const rules = await readSiteRules();
      const result = await pushMultipleDomainCookies(Object.values(sent), (cookie, host) =>
        cookieAllowed(cookie, host, rules),
      );
      if (!result.success) {
        throw new Error('自动同步上传失败');
      }

      const adoptedDomains = new Set(result.adopted.map(item => item.domain));
      const acknowledged = Object.fromEntries(Object.entries(sent).filter(([host]) => !adoptedDomains.has(host)));
      const writtenHashes = Object.fromEntries(
        await Promise.all(
          Object.entries(acknowledged).map(async ([host, job]) => [
            host,
            (await getSyncBaseline(host)) || (await domainContentHash(job)),
          ]),
        ),
      );
      await editSyncJobs(key, jobs => acknowledgeJobs(jobs, acknowledged, writtenHashes));

      if (!result.unchanged && Object.keys(acknowledged).length > 0) {
        await publishDataWriteLease();
      }

      await autoSyncStatusStorage.update({
        phase: 'idle',
        lastSuccess: Date.now(),
        error: '',
        note: adoptedDomains.size
          ? `云端较新，已保留 ${[...adoptedDomains].join('、')} 的云端数据，稍后自动应用`
          : undefined,
        pendingCount: Object.keys(await getActiveJobs(key)).length,
      });
    } catch (error) {
      const message = syncErrorMessage(error);
      uploadBatch = undefined;
      if (Object.keys(sent).length) {
        await editSyncJobs(key, jobs =>
          Object.fromEntries(
            Object.entries(jobs).map(([host, job]) => [
              host,
              sent[host]?.revision === job.revision ? { ...job, retryError: message } : job,
            ]),
          ),
        ).catch(() => {});
      }
      await autoSyncStatusStorage.update({
        phase: 'idle',
        lastAttempt: Date.now(),
        error: message,
        pendingCount: Object.keys(await getActiveJobs(key)).length,
      });
    }
  })().finally(() => {
    uploadBatch = undefined;
    uploadInFlight = undefined;
  });
  return uploadInFlight;
}

bindCaptureFlush(async expedited => {
  // A timer expiring during another upload must still drain the newer revision.
  while (uploadInFlight) await uploadInFlight.catch(() => {});
  await flushAutomaticSync(false, expedited);
}, isUploadInFlight);

export async function restoreAtStartup(periodic = false, force = false): Promise<void> {
  if (reconcileInFlight) {
    await reconcileInFlight;
    if (force) return restoreAtStartup(periodic, true);
    return;
  }

  reconcileInFlight = (async () => {
    const settings = await settingsStorage.get();

    // On periodic ticks, an always-on PC checks whether the other PC took over the lease.
    if (periodic && !force && settings.activeDeviceSync !== false) {
      if (isDeviceStandby()) {
        // Stay completely quiet while standby — only verify lease ownership for UI/tab-guard.
        await checkIfLeaseLost(() => clearDestinationJobs());
        return;
      }
      const lost = await checkIfLeaseLost(() => clearDestinationJobs());
      if (lost) return;
    }

    if (periodic ? settings.backgroundSync === false : settings.startupPull === false) {
      try {
        await syncWebdavConfig();
      } catch (error) {
        await autoSyncStatusStorage.update({ error: syncErrorMessage(error) });
      }
      return;
    }

    await domainConfigStorage.ensureDefaults();
    await autoSyncStatusStorage.update({ phase: 'checking', lastCheck: Date.now(), error: '' });
    const adoptedRemote: string[] = [];

    try {
      try {
        await syncWebdavConfig();
      } catch (configError) {
        await autoSyncStatusStorage.update({ error: syncErrorMessage(configError) });
      }

      const rules = await readSiteRules();
      await discoverOpenSites();

      const beforeRead = await domainConfigStorage.get();
      for (const [domain, item] of Object.entries(beforeRead.domainMap)) {
        if (isSiteAllowed(domain, rules) && item.autoPush !== false && (await getSyncBaseline(domain))) {
          await captureAutomaticSync(domain, undefined, true);
        }
      }

      const remote = await pullCookies();
      const config = await domainConfigStorage.get();
      const allDomains = new Set([...Object.keys(remote.domainCookieMap || {}), ...Object.keys(config.domainMap)]);
      await autoSyncStatusStorage.update({ phase: 'comparing' });

      for (const domain of allDomains) {
        if (!isSiteAllowed(domain, rules)) continue;
        const item = config.domainMap[domain];
        await waitCapture(domain);
        const pending = await getJobs(await syncDestinationKey());
        await domainConfigStorage.updateItem(domain, {
          autoPull: item?.autoPull ?? true,
          autoPush: item?.autoPush ?? true,
        });

        try {
          const remoteEntry = remote.domainCookieMap?.[domain];
          if (!remoteEntry) {
            if (pending[domain]) continue;
            await setSyncBaseline(domain, await domainContentHash());
            await captureAutomaticSync(domain, undefined, true);
            continue;
          }

          const pendingJob = pending[domain];
          const adoptRemote =
            !!pendingJob &&
            item?.autoPull !== false &&
            typeof pendingJob.capturedAt === 'number' &&
            Number.isFinite(pendingJob.capturedAt) &&
            (Number(remoteEntry.updateTime) || 0) > pendingJob.capturedAt;

          if (adoptRemote) {
            await editSyncJobs(await syncDestinationKey(), jobs => {
              const next = { ...jobs };
              delete next[domain];
              return next;
            });
            adoptedRemote.push(domain);
          } else if (pendingJob || item?.autoPull === false) {
            if (item?.autoPush !== false && !(await getSyncBaseline(domain))) {
              await setSyncBaseline(domain, await domainContentHash(remoteEntry));
              await captureAutomaticSync(domain, undefined, true);
            }
            continue;
          }

          await pullAndSetCookies(item?.sourceUrl || `https://${domain}`, domain, false, remote, undefined, cookie =>
            cookieAllowed(cookie, domain, rules),
          );
          await syncRuntimeStorage.markPulled(domain);

          const profile = siteProfileFor(domain);
          if (profile?.healthCheck) {
            const missing = missingLoginKeys(profile, remoteEntry.cookies);
            if (missing.length) {
              await siteHealthStorage.updateDomain(profile.domain, {
                state: 'invalid',
                userName: undefined,
                loginKeysMissing: false,
                message: `云端快照缺少登录要素（${missing.join('、')}），请在已登录电脑重新推送`,
              });
            } else {
              const uaHint = profile.uaSensitive
                ? uaMismatchHint(remoteEntry.userAgent, navigator.userAgent)
                : undefined;
              await siteHealthStorage.updateDomain(profile.domain, { loginKeysMissing: false, message: uaHint });
              if (!isDeviceStandby()) {
                void checkSiteHealth(domain);
              }
            }
          }
        } catch (error) {
          await autoSyncStatusStorage.update({ error: syncErrorMessage(error) });
        }
      }

      if (settings.backgroundSync !== false) {
        await flushAutomaticSync(force || !periodic);
      }

      const finalStatus: { phase: 'idle'; pendingCount: number; note?: string } = {
        phase: 'idle',
        pendingCount: Object.keys(await getActiveJobs(await syncDestinationKey())).length,
      };
      if (adoptedRemote.length) {
        finalStatus.note = `本机修改较早，已采用 ${adoptedRemote.join('、')} 的云端数据`;
      }
      await autoSyncStatusStorage.update(finalStatus);
    } catch (error) {
      await autoSyncStatusStorage.update({ phase: 'idle', error: syncErrorMessage(error) });
    }
  })().finally(() => {
    reconcileInFlight = undefined;
  });

  return reconcileInFlight;
}
