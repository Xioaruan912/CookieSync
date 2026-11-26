import { useGSAP } from '@gsap/react';
import {
  extractDomainAndPort,
  RuntimeMessageType,
  siteProfileFor,
  useLocale,
  useStorageSuspense,
  useTheme,
  withErrorBoundary,
  withSuspense,
} from '@sync-your-cookie/shared';
import { accountStorage, isLegacyProvider } from '@sync-your-cookie/storage/lib/accountStorage';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { isSiteAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { siteHealthStorage } from '@sync-your-cookie/storage/lib/siteHealthStorage';
import { sitePolicyStorage } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { Switch, Toaster } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Globe2,
  PanelRightOpen,
  RefreshCw,
  Settings,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useDomainConfig } from './hooks/useDomainConfig';

gsap.registerPlugin(useGSAP);

const Popup = () => {
  const rootRef = useRef<HTMLElement>(null);
  const { theme } = useTheme();
  const { isEn, t, toggleLanguage } = useLocale();
  const status = useStorageSuspense(autoSyncStatusStorage);
  const settings = useStorageSuspense(settingsStorage);
  const account = useStorageSuspense(accountStorage);
  const webdav = useStorageSuspense(webdavStorage);
  const policy = useSyncExternalStore(sitePolicyStorage.subscribe, sitePolicyStorage.getSnapshot);
  const health = useStorageSuspense(siteHealthStorage);
  const config = useStorageSuspense(domainConfigStorage);
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<'push' | 'pull'>();
  const [takingOver, setTakingOver] = useState(false);
  const [saving, setSaving] = useState(false);
  const { domain, setDomain, handlePush, handlePull, pushing, pulling, domainItemStatus, domainItemConfig } =
    useDomainConfig();

  useEffect(() => {
    void chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then(async ([current]) => {
        if (!current?.url || !/^https?:\/\//.test(current.url) || current.incognito) return;
        const [host, port] = await extractDomainAndPort(current.url);
        setDomain(port ? host + ':' + port : host);
        setTab(current);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [setDomain]);

  useGSAP(
    () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      gsap.from('.cc-hero h1', { y: 10, opacity: 0, duration: 0.28, ease: 'power3.out', clearProps: 'transform,opacity' });
    },
    { scope: rootRef },
  );

  const legacy = isLegacyProvider(account);
  const connected = !legacy && !!webdav.url;
  const listed = !!domain && !!policy && isSiteAllowed(domain, policy);
  const healthProfile = domain ? siteProfileFor(domain) : undefined;
  const healthEntry = healthProfile ? health[healthProfile.domain] : undefined;
  const healthText = healthProfile
    ? healthProfile.healthCheck
      ? healthEntry?.state === 'ok'
        ? t('登录有效', 'Session Valid')
        : healthEntry?.state === 'invalid'
          ? t('登录已失效', 'Session Expired')
          : healthEntry?.state === 'unknown'
            ? t('验证未完成', 'Check Incomplete')
            : t('尚未验证', 'Not Verified')
      : healthEntry?.loginKeysMissing
        ? t('缺少登录凭证', 'Missing Cookies')
        : healthEntry
          ? t('登录要素齐全', 'Cookies OK')
          : t('未检查', 'Unchecked')
    : '';
  const healthBad = healthEntry?.state === 'invalid' || healthEntry?.loginKeysMissing === true;
  const background = settings.backgroundSync !== false;
  const registered = !!config.domainMap[domain];
  const autoPush = domainItemConfig.autoPush !== false;
  const autoPull = domainItemConfig.autoPull !== false;
  const sessionStorageOn = domainItemConfig.includeSessionStorage ?? settings.includeSessionStorage ?? false;
  const indexedDbOn = domainItemConfig.includeIndexedDB ?? settings.includeIndexedDB ?? false;
  const busy = !!action || pushing || pulling || !!domainItemStatus.pushing || !!domainItemStatus.pulling;
  const role = status.deviceRole || 'active';
  const isStandby = role === 'standby';

  const siteState = !listed
    ? t('未加入名单', 'Not in allowlist')
    : !connected
      ? t('等待配置网盘', 'WebDAV not set')
      : !background
        ? t('后台同步已关闭', 'Auto-sync paused')
        : !registered && settings.autoDiscoverSites === false
          ? t('等待手动登记', 'Manual sync only')
          : !autoPush && !autoPull
            ? t('此站已暂停', 'Paused')
            : !registered
              ? t('等待自动登记', 'Ready to auto-sync')
              : autoPush && autoPull
                ? t('双向无感同步', 'Two-way auto sync')
                : autoPush
                  ? t('仅自动推送', 'Auto-push only')
                  : t('仅自动拉取', 'Auto-pull only');

  const transfer = async (direction: 'push' | 'pull') => {
    if (!tab?.url || busy) return;
    setAction(direction);
    try {
      if (direction === 'push') await handlePush(domain, tab.url, tab.favIconUrl);
      else await handlePull(tab.url, domain, true);
    } finally {
      setAction(undefined);
    }
  };

  const takeoverNow = async () => {
    if (!connected || takingOver) return;
    setTakingOver(true);
    try {
      const res = await chrome.runtime.sendMessage({ type: RuntimeMessageType.TakeoverNow });
      if (!res?.isOk) throw new Error(res?.msg || '接班同步失败');
      toast.success(res.msg || '已完成双机接班同步');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '接班同步失败');
    } finally {
      setTakingOver(false);
    }
  };

  const changeSite = async (save: () => Promise<void>) => {
    setSaving(true);
    try {
      await save();
    } catch {
      toast.error('网站设置保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const joinCurrentSite = async () => {
    if (!domain || saving) return;
    setSaving(true);
    try {
      await sitePolicyStorage.setRule(domain, true);
      await domainConfigStorage.updateItem(domain, {
        autoPush: true,
        autoPull: true,
        ...(tab?.url ? { sourceUrl: tab.url } : {}),
        ...(tab?.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
      });
      toast.success(`已将 ${domain} 加入同步名单`);
    } catch {
      toast.error('加入同步名单失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const openManager = async () => {
    try {
      if (tab?.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
      else await chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/index.html') });
    } catch {
      await chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/index.html') });
    }
  };

  const routeActive =
    listed &&
    connected &&
    background &&
    (registered || settings.autoDiscoverSites !== false) &&
    (autoPush || autoPull);

  return (
    <main ref={rootRef} className="cc-popup">
      <header className="cc-header">
        <div className="cc-brand">
          <img
            src={chrome.runtime.getURL('options/logo.png')}
            className="size-6 shrink-0 rounded-md object-contain"
            alt=""
          />
          <div>
            <strong>CookieSync</strong>
            <small>{status.localDeviceName || t('双机无感同步', 'WebDAV Session Sync')}</small>
          </div>
        </div>
        <div className="cc-header-right">
          {connected ? (
            <button
              type="button"
              className="cc-role-pill"
              data-standby={isStandby}
              disabled={takingOver}
              title={t('点击立即检查并接班同步', 'Click to take over and sync now')}
              onClick={() => void takeoverNow()}>
              <span className="cc-dot" data-state={isStandby ? 'standby' : 'live'} aria-hidden="true" />
              <span>{takingOver ? t('接班中…', 'Syncing…') : isStandby ? t('待机中', 'Standby') : t('本机当家', 'Active')}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="cc-icon-btn text-[11px] font-medium"
            aria-label={t('切换到英文', 'Switch to Chinese')}
            title={t('切换中/英', 'Switch EN/ZH')}
            onClick={() => void toggleLanguage()}>
            {isEn ? '中' : 'EN'}
          </button>
          <button
            type="button"
            className="cc-icon-btn"
            aria-label={t('打开设置', 'Open settings')}
            onClick={() => void chrome.runtime.openOptionsPage()}>
            <Settings size={14} aria-hidden />
          </button>
        </div>
      </header>

      <section className="cc-hero" aria-labelledby="current-site">
        <div className="cc-hero-top">
          <span className="cc-live-tag">
            <span
              className="cc-dot"
              data-state={!connected ? 'warn' : healthBad ? 'warn' : isStandby ? 'standby' : listed ? 'live' : 'idle'}
              aria-hidden="true"
            />
            {domain ? (policy ? siteState : t('正在读取名单…', 'Loading allowlist…')) : t('当前页无需同步', 'No sync needed')}
          </span>
          <span className="cc-proto-tag">{legacy ? t('待迁移', 'Legacy') : connected ? 'WebDAV' : t('未连接', 'Offline')}</span>
        </div>

        <h1 id="current-site">{loading ? t('正在识别网站…', 'Detecting site…') : domain || t('非普通网页', 'System page')}</h1>

        <div className="cc-bridge" data-active={routeActive} data-moving={action} aria-hidden="true">
          <span>{t('本机', 'Local')}</span>
          <div className="cc-bridge-dots">
            <span className="cc-bridge-dot" />
            <span className="cc-bridge-dot" />
            <span className="cc-bridge-dot" />
            <span className="cc-bridge-dot" />
            <span className="cc-bridge-dot" />
            <span className="cc-bridge-dot" />
            <span className="cc-bridge-dot" />
          </div>
          <span>{t('云端', 'Cloud')}</span>
        </div>
      </section>

      {domain && policy ? (
        <section className="cc-controls" aria-label={t('当前网站操作', 'Current site actions')}>
          {!listed ? (
            <div className="cc-note">
              <span className="flex min-w-0 items-center gap-1.5">
                <Globe2 size={14} className="shrink-0" aria-hidden />
                <span className="truncate">{t('此站尚未加入自动同步名单', 'Not in auto-sync allowlist')}</span>
              </span>
              <button
                type="button"
                className="cc-note-btn"
                disabled={saving}
                onClick={() => void joinCurrentSite()}>
                {saving ? t('加入中…', 'Adding…') : t('一键加入', 'Add Site')}
              </button>
            </div>
          ) : null}

          <div className="cc-actions">
            <button
              type="button"
              className="cc-pill-primary"
              aria-label={t('推送并合并 Cookie', 'Push and merge cookies')}
              disabled={busy || !connected}
              onClick={() => void transfer('push')}>
              {action === 'push' ? <RefreshCw className="animate-spin" size={14} /> : <ArrowUpFromLine size={14} />}
              {action === 'push' ? t('推送中…', 'Pushing…') : t('推送到云端', 'Push to Cloud')}
            </button>
            <button
              type="button"
              className="cc-pill-ghost"
              aria-label={t('拉取并应用 Cookie', 'Pull and apply cookies')}
              disabled={busy || !connected}
              onClick={() => void transfer('pull')}>
              {action === 'pull' ? <RefreshCw className="animate-spin" size={14} /> : <ArrowDownToLine size={14} />}
              {action === 'pull' ? t('拉取中…', 'Pulling…') : t('拉取到本机', 'Pull to Device')}
            </button>
          </div>

          {listed ? (
            <div className="cc-switches">
              <label className="cc-switch-item">
                <span>{t('自动推送', 'Auto Push')}</span>
                <Switch
                  aria-label={t('自动推送', 'Auto Push')}
                  checked={autoPush}
                  disabled={saving || busy}
                  onCheckedChange={checked =>
                    void changeSite(() => domainConfigStorage.toggleAutoPushState(domain, checked))
                  }
                />
              </label>
              <label className="cc-switch-item">
                <span>{t('自动拉取', 'Auto Pull')}</span>
                <Switch
                  aria-label={t('自动拉取', 'Auto Pull')}
                  checked={autoPull}
                  disabled={saving || busy}
                  onCheckedChange={checked =>
                    void changeSite(() => domainConfigStorage.toggleAutoPullState(domain, checked))
                  }
                />
              </label>
            </div>
          ) : null}

          {listed ? (
            <details className="cc-details">
              <summary>{t('方向与高级存储选项', 'Direction & Storage Options')}</summary>
              <div className="cc-dir-pills">
                <button
                  type="button"
                  className="cc-dir-pill"
                  disabled={saving || busy}
                  onClick={() =>
                    void changeSite(() => domainConfigStorage.updateItem(domain, { autoPush: true, autoPull: false }))
                  }>
                  {t('仅推送', 'Push Only')}
                </button>
                <button
                  type="button"
                  className="cc-dir-pill"
                  disabled={saving || busy}
                  onClick={() =>
                    void changeSite(() => domainConfigStorage.updateItem(domain, { autoPush: false, autoPull: true }))
                  }>
                  {t('仅拉取', 'Pull Only')}
                </button>
                <button
                  type="button"
                  className="cc-dir-pill"
                  disabled={saving || busy}
                  onClick={() =>
                    void changeSite(() => domainConfigStorage.updateItem(domain, { autoPush: true, autoPull: true }))
                  }>
                  {t('双向同步', 'Two-Way')}
                </button>
              </div>
              <div className="cc-sub-switches">
                <label>
                  <span>{t('同步 sessionStorage', 'Sync sessionStorage')}</span>
                  <Switch
                    aria-label={t('同步此网站的 sessionStorage', 'Sync sessionStorage for this site')}
                    checked={sessionStorageOn}
                    disabled={saving || busy}
                    onCheckedChange={checked =>
                      void changeSite(() => domainConfigStorage.updateItem(domain, { includeSessionStorage: checked }))
                    }
                  />
                </label>
                <label>
                  <span>{t('同步 IndexedDB（实验）', 'Sync IndexedDB (Beta)')}</span>
                  <Switch
                    aria-label={t('同步此网站的 IndexedDB', 'Sync IndexedDB for this site')}
                    checked={indexedDbOn}
                    disabled={saving || busy}
                    onCheckedChange={checked =>
                      void changeSite(() => domainConfigStorage.updateItem(domain, { includeIndexedDB: checked }))
                    }
                  />
                </label>
              </div>
            </details>
          ) : null}
        </section>
      ) : null}

      {!connected ? (
        <div className="py-3 border-b border-[var(--sbo-line)]">
          <button
            type="button"
            className="cc-pill-primary w-full"
            onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('options/index.html#connection') })}>
            {legacy ? t('旧后端已移除，前往配置 WebDAV', 'Legacy backend removed — Set up WebDAV') : t('前往配置私人网盘连接', 'Connect Private WebDAV')}
          </button>
        </div>
      ) : null}

      {healthProfile ? (
        <button
          type="button"
          className="cc-link-row"
          data-state={healthBad ? 'warn' : healthEntry?.state}
          onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('options/index.html#adaptations') })}>
          <span className="flex items-center gap-2">
            {healthBad ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
            <span>
              {healthProfile.domain} · {healthText}
            </span>
          </span>
          {healthBad && healthProfile.qrLogin ? <strong>{t('去修复 →', 'Fix →')}</strong> : null}
        </button>
      ) : null}

      <footer className="cc-footer">
        <div className="min-w-0 flex-1 overflow-hidden" role="status">
          <div className="cc-footer-title">
            {status.phase === 'taking-over'
              ? t('正在自动接班同步…', 'Taking over & syncing…')
              : status.phase === 'uploading'
                ? t('正在上传改动…', 'Uploading changes…')
                : status.phase === 'comparing'
                  ? t('正在比对云端…', 'Comparing cloud…')
                  : status.phase === 'checking'
                    ? t('正在检查同步…', 'Checking sync…')
                    : status.error
                      ? t('后台同步待重试', 'Background retry pending')
                      : status.pendingCount
                        ? t(`${status.pendingCount} 个网站待上传`, `${status.pendingCount} site(s) queued`)
                        : isStandby
                          ? t('待机护航中', 'Standby guard active')
                          : t('全部同步就绪', 'All synced & ready')}
          </div>
          <div className="cc-footer-sub">
            {status.error ||
              status.note ||
              (status.lastSuccess
                ? `${t('最近上传', 'Last push')} ${new Date(status.lastSuccess).toLocaleTimeString(isEn ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' })}`
                : status.lastCheck
                  ? `${t('最近检查', 'Last check')} ${new Date(status.lastCheck).toLocaleTimeString(isEn ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' })}`
                  : t('尚无同步记录', 'No sync yet'))}
          </div>
        </div>
        <button type="button" className="cc-manage-btn" aria-label={t('打开同步管理', 'Open side panel')} onClick={() => void openManager()}>
          <PanelRightOpen size={13} aria-hidden />
          {t('管理', 'Manage')}
        </button>
      </footer>

      <Toaster theme={theme} closeButton visibleToasts={1} richColors position="top-center" />
    </main>
  );
};

export default withErrorBoundary(
  withSuspense(Popup, <div className="p-4">加载中…</div>),
  <div className="p-4">页面加载失败，请重新打开</div>,
);
