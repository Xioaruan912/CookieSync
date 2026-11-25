import {
  check,
  collectSitePayload,
  editSyncJobs,
  missingLoginKeys,
  pullAndSetCookies,
  pullCookies,
  pushCookies,
  pushMultipleDomainCookies,
  sessionStorageEnabled,
  siteProfileFor,
  syncDestinationKey,
  uaMismatchHint,
  waitSyncJobEdits,
  type ReloadMode,
} from '@sync-your-cookie/shared';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { isAutomaticCookieAllowed, isSiteAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { domainStatusStorage } from '@sync-your-cookie/storage/lib/domainStatusStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { siteHealthStorage } from '@sync-your-cookie/storage/lib/siteHealthStorage';
import { readSiteRules } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import { syncFeedbackStorage } from '@sync-your-cookie/storage/lib/syncFeedbackStorage';
import { syncRuntimeStorage } from '@sync-your-cookie/storage/lib/syncRuntimeStorage';
import { publishDataWriteLease } from '../activeDevice/leaseManager';
import { checkSiteHealth } from '../healthCheck';
import { snapshotLocal, snapshotRemote } from '../safety';
import { clearDestinationJobs, getActiveJobs, waitCapture } from './capture';
import { readPageStorage } from './pageBridge';
import { syncErrorMessage } from './reconciler';

export interface PullAllSummary {
  domains: number;
  cookies: number;
  localStorageItems: number;
  sessionStorageItems: number;
  skipped: number;
}

export interface SiteTransferSummary {
  domain: string;
  cookies: number;
  localStorageItems: number;
  sessionStorageItems: number;
  indexedDBRecords: number;
}

export interface PushSiteOptions {
  sourceUrl?: string;
  favIconUrl?: string;
  /** Overview/shortcuts enforce site allowlist; explicit popup manual push may push any site. */
  requireListed?: boolean;
  /** Create a remote rollback snapshot before overwriting. Default true. */
  createSnapshot?: boolean;
}

export interface PullSiteOptions {
  activeTabUrl?: string;
  reload?: ReloadMode;
  requireListed?: boolean;
  createSnapshot?: boolean;
}

/**
 * Unified single-site push used by Popup, SidePanel, Overview, and Shortcuts.
 */
export async function pushSingleSite(domain: string, options: PushSiteOptions = {}): Promise<SiteTransferSummary> {
  await check();
  const rules = await readSiteRules();
  if (options.requireListed && !isSiteAllowed(domain, rules)) {
    throw new Error('该网站不在同步名单内');
  }
  const previousConfig = (await domainConfigStorage.get()).domainMap[domain];
  if (options.requireListed && !previousConfig) {
    throw new Error('该网站尚未登记，请先打开网站页面');
  }

  await domainConfigStorage.updateItem(domain, {
    autoPush: previousConfig?.autoPush ?? true,
    autoPull: previousConfig?.autoPull ?? true,
    ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
    ...(options.favIconUrl ? { favIconUrl: options.favIconUrl } : {}),
  });
  await domainStatusStorage.updateItem(domain, { pushing: true }).catch(() => {});

  try {
    if (options.createSnapshot !== false) {
      await snapshotRemote(await pullCookies(), 'push-site').catch(() => {});
    }

    const observed = await readPageStorage(domain);
    const collected = await collectSitePayload(domain, {
      sourceUrl: options.sourceUrl || previousConfig?.sourceUrl || `https://${domain}`,
      observed,
      rules,
      applyRules: !!options.requireListed,
      enforceLoginGuard: false,
    });

    if (collected.isEmpty) {
      throw new Error('未找到 Cookie 或 LocalStorage，请先确认已登录');
    }

    const result = await pushCookies(
      domain,
      collected.cookies,
      collected.localStorageItems,
      navigator?.userAgent || '',
      collected.sessionStorageItems,
      collected.indexedDBRecords,
    );
    if (!result?.success) {
      throw new Error('推送失败，请检查连接和加密设置');
    }

    const key = await syncDestinationKey();
    await editSyncJobs(key, jobs => {
      if (!jobs[domain]) return jobs;
      const next = { ...jobs };
      delete next[domain];
      return next;
    });
    await autoSyncStatusStorage.update({ pendingCount: Object.keys(await getActiveJobs(key)).length });

    if (!result.unchanged) {
      await publishDataWriteLease();
    }

    void syncFeedbackStorage
      .update({ lastPush: { ok: true, host: domain, message: '推送成功', at: Date.now() } })
      .catch(() => {});

    return {
      domain,
      cookies: collected.cookies.length,
      localStorageItems: collected.localStorageItems.length,
      sessionStorageItems: collected.sessionStorageItems.length,
      indexedDBRecords: collected.indexedDBRecords.length,
    };
  } catch (error) {
    void syncFeedbackStorage
      .update({
        lastPush: { ok: false, host: domain, message: syncErrorMessage(error), at: Date.now() },
      })
      .catch(() => {});
    throw error;
  } finally {
    await domainStatusStorage.togglePushingState(domain, false).catch(() => {});
  }
}

/**
 * Unified single-site pull used by Popup, SidePanel, Overview, and Shortcuts.
 */
export async function pullSingleSite(domain: string, options: PullSiteOptions = {}): Promise<{ domain: string }> {
  await check();
  const rules = await readSiteRules();
  if (options.requireListed && !isSiteAllowed(domain, rules)) {
    throw new Error('该网站不在同步名单内');
  }
  const previousConfig = (await domainConfigStorage.get()).domainMap[domain];
  if (options.requireListed && !previousConfig) {
    throw new Error('该网站尚未登记，请先打开网站页面');
  }

  const url = options.activeTabUrl || previousConfig?.sourceUrl || `https://${domain}`;
  await domainStatusStorage.togglePullingState(domain, true).catch(() => {});

  try {
    if (options.createSnapshot !== false) {
      await snapshotLocal('pull-site', [domain]).catch(() => {});
    }
    await pullAndSetCookies(
      url,
      domain,
      options.reload ?? true,
      undefined,
      undefined,
      options.requireListed ? cookie => isAutomaticCookieAllowed(cookie, domain, rules) : undefined,
    );
    await syncRuntimeStorage.markPulled(domain);
    await domainConfigStorage.updateItem(domain, {
      autoPull: previousConfig?.autoPull ?? true,
      autoPush: previousConfig?.autoPush ?? true,
      sourceUrl: url,
    });
    const key = await syncDestinationKey();
    await editSyncJobs(key, jobs => {
      if (!jobs[domain]) return jobs;
      const next = { ...jobs };
      delete next[domain];
      return next;
    });
    await autoSyncStatusStorage.update({ pendingCount: Object.keys(await getActiveJobs(key)).length });
    return { domain };
  } finally {
    await domainStatusStorage.togglePullingState(domain, false).catch(() => {});
  }
}

/**
 * Manual "push everything": local wins for every allowed site with autoPush enabled.
 */
export async function pushAllToCloud(): Promise<PullAllSummary> {
  await check();
  const rules = await readSiteRules();
  const config = await domainConfigStorage.get();
  const key = await syncDestinationKey();

  const remoteNow = await pullCookies();
  await snapshotRemote(remoteNow, 'push-all');

  const summary: PullAllSummary = { domains: 0, cookies: 0, localStorageItems: 0, sessionStorageItems: 0, skipped: 0 };
  const jobs: Parameters<typeof pushMultipleDomainCookies>[0] = [];

  for (const [domain, item] of Object.entries(config.domainMap)) {
    if (!isSiteAllowed(domain, rules) || item.autoPush === false) {
      summary.skipped++;
      continue;
    }
    try {
      const collected = await collectSitePayload(domain, {
        sourceUrl: item.sourceUrl || `https://${domain}`,
        observed: await readPageStorage(domain),
        rules,
        applyRules: true,
        enforceLoginGuard: false,
      });
      if (collected.isEmpty) {
        summary.skipped++;
        continue;
      }
      jobs.push({
        domain,
        cookies: collected.cookies,
        localStorageItems: collected.localStorageItems,
        sessionStorageItems: collected.sessionStorageItems,
        indexedDBRecords: collected.indexedDBRecords,
        userAgent: navigator.userAgent,
      });
      summary.cookies += collected.cookies.length;
      summary.localStorageItems += collected.localStorageItems.length;
      summary.sessionStorageItems += collected.sessionStorageItems.length;
    } catch (error) {
      summary.skipped++;
      await autoSyncStatusStorage.update({ error: syncErrorMessage(error) });
    }
  }

  if (jobs.length) {
    await waitSyncJobEdits();
    const result = await pushMultipleDomainCookies(jobs, (cookie, host) => isAutomaticCookieAllowed(cookie, host, rules));
    if (!result.success) throw new Error('全部上传失败，请检查连接和加密设置');
    await editSyncJobs(key, current => {
      const next = { ...current };
      for (const job of jobs) delete next[job.domain];
      return next;
    });
    if (!result.unchanged) {
      await publishDataWriteLease();
    }
    summary.domains = jobs.length;
  }

  await autoSyncStatusStorage.update({
    phase: 'idle',
    lastSuccess: jobs.length ? Date.now() : undefined,
    note: `已向云端上传 ${summary.domains} 个网站（跳过 ${summary.skipped} 个）`,
    pendingCount: Object.keys(await getActiveJobs(key)).length,
    error: '',
  });
  return summary;
}

/**
 * Pulls all allowed cloud sites onto this computer.
 * Used both by manual "pull all" and by automatic active-device takeover!
 */
export async function pullAllFromCloud(options: {
  reason?: 'pull-all' | 'takeover';
  reloadMode?: ReloadMode;
} = {}): Promise<PullAllSummary> {
  await check();
  const settings = await settingsStorage.get();
  const rules = await readSiteRules();
  const config = await domainConfigStorage.get();
  const key = await syncDestinationKey();
  const reason = options.reason || 'pull-all';
  const reloadMode: ReloadMode = options.reloadMode ?? (reason === 'takeover' ? 'smart' : true);

  await snapshotLocal(reason);
  if (reason === 'takeover') {
    // Discard stale local queue on takeover so old PC data never bounces back.
    await clearDestinationJobs(key);
  }

  const remote = await pullCookies();
  const summary: PullAllSummary = { domains: 0, cookies: 0, localStorageItems: 0, sessionStorageItems: 0, skipped: 0 };

  for (const [domain, entry] of Object.entries(remote.domainCookieMap || {})) {
    if (!isSiteAllowed(domain, rules) || config.domainMap[domain]?.autoPull === false) {
      summary.skipped++;
      continue;
    }
    await waitCapture(domain);
    try {
      await pullAndSetCookies(
        config.domainMap[domain]?.sourceUrl || `https://${domain}`,
        domain,
        reloadMode,
        remote,
        undefined,
        cookie => isAutomaticCookieAllowed(cookie, domain, rules),
      );
      await syncRuntimeStorage.markPulled(domain);
      await domainConfigStorage.updateItem(domain, {
        autoPull: config.domainMap[domain]?.autoPull ?? true,
        autoPush: config.domainMap[domain]?.autoPush ?? true,
      });
      await editSyncJobs(key, jobs => {
        if (!jobs[domain]) return jobs;
        const next = { ...jobs };
        delete next[domain];
        return next;
      });

      const profile = siteProfileFor(domain);
      if (profile?.healthCheck) {
        const missing = missingLoginKeys(profile, entry.cookies);
        if (missing.length) {
          await siteHealthStorage.updateDomain(profile.domain, {
            state: 'invalid',
            userName: undefined,
            loginKeysMissing: false,
            message: `云端快照缺少登录要素（${missing.join('、')}），请在已登录电脑重新推送`,
          });
        } else {
          const uaHint = profile.uaSensitive ? uaMismatchHint(entry.userAgent, navigator.userAgent) : undefined;
          await siteHealthStorage.updateDomain(profile.domain, { loginKeysMissing: false, message: uaHint });
          void checkSiteHealth(domain);
        }
      }

      summary.domains++;
      summary.cookies += entry.cookies?.length || 0;
      summary.localStorageItems +=
        settings.includeLocalStorage === false ? 0 : entry.localStorageItems?.length || 0;
      summary.sessionStorageItems += sessionStorageEnabled(
        settings.includeSessionStorage,
        config.domainMap[domain]?.includeSessionStorage,
      )
        ? entry.sessionStorageItems?.length || 0
        : 0;
    } catch (error) {
      summary.skipped++;
      await autoSyncStatusStorage.update({ error: syncErrorMessage(error) });
    }
  }

  if (reason === 'pull-all') {
    await autoSyncStatusStorage.update({
      phase: 'idle',
      lastCheck: Date.now(),
      note: `已从云端拉取 ${summary.domains} 个网站（跳过 ${summary.skipped} 个）`,
      pendingCount: Object.keys(await getActiveJobs(key)).length,
    });
  }
  return summary;
}
