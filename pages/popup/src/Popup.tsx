import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { accountStorage } from '@sync-your-cookie/storage/lib/accountStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { driveAccountStorage } from '@sync-your-cookie/storage/lib/driveStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { isSiteAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { sitePolicyStorage } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import {
  extractDomainAndPort,
  useStorageSuspense,
  useTheme,
  withErrorBoundary,
  withSuspense,
} from '@sync-your-cookie/shared';
import { Button, Switch, Toaster } from '@sync-your-cookie/ui';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Cloud,
  Globe2,
  Laptop,
  PanelRightOpen,
  RefreshCw,
  Settings,
} from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useDomainConfig } from './hooks/useDomainConfig';

const Popup = () => {
  const { theme } = useTheme();
  const status = useStorageSuspense(autoSyncStatusStorage);
  const settings = useStorageSuspense(settingsStorage);
  const account = useStorageSuspense(accountStorage);
  const drive = useStorageSuspense(driveAccountStorage);
  const webdav = useStorageSuspense(webdavStorage);
  const policy = useSyncExternalStore(sitePolicyStorage.subscribe, sitePolicyStorage.getSnapshot);
  const config = useStorageSuspense(domainConfigStorage);
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<'push' | 'pull'>();
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

  const provider = account.selectedProvider;
  const connected =
    provider === 'google-drive'
      ? drive.connected
      : provider === 'webdav'
        ? !!webdav.url
        : provider === 'github'
          ? !!account.githubAccessToken
          : !!(account.accountId && account.namespaceId && account.token);
  const destination =
    provider === 'google-drive'
      ? 'Google Drive'
      : provider === 'webdav'
        ? 'WebDAV'
        : provider === 'github'
          ? 'GitHub Gist'
          : 'Cloudflare KV';
  const listed = !!domain && !!policy && isSiteAllowed(domain, policy);
  const background = settings.backgroundSync !== false;
  const registered = !!config.domainMap[domain];
  const autoPush = domainItemConfig.autoPush !== false;
  const autoPull = domainItemConfig.autoPull !== false;
  const busy = !!action || pushing || pulling || !!domainItemStatus.pushing || !!domainItemStatus.pulling;
  const siteState = !listed
    ? '未加入名单'
    : !connected
      ? '等待配置连接'
      : !background
        ? '后台同步已关闭'
        : !registered && settings.autoDiscoverSites === false
          ? '等待手动登记'
          : !autoPush && !autoPull
            ? '此站已暂停'
            : !registered
              ? '等待自动登记'
              : autoPush && autoPull
                ? '自动收发'
                : autoPush
                  ? '仅自动推送'
                  : '仅自动拉取';

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

  const openManager = async () => {
    try {
      // Use the current tab's window directly so Chrome retains the click gesture.
      if (tab?.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
      else await chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/index.html') });
    } catch {
      await chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/index.html') });
    }
  };

  return (
    <main className="sync-popup">
      <header className="popup-header">
        <div className="flex items-center gap-2">
          <img src={chrome.runtime.getURL('options/logo.png')} className="size-7 object-contain" alt="" />
          <span className="font-semibold tracking-tight">CookieSync</span>
        </div>
        <Button variant="ghost" size="icon" aria-label="打开设置" onClick={() => void chrome.runtime.openOptionsPage()}>
          <Settings size={17} aria-hidden />
        </Button>
      </header>
      <section className="signal-card" aria-labelledby="current-site">
        <div className="signal-top">
          <span>当前网站</span>
          <span>{connected ? destination : '尚未配置同步连接'}</span>
        </div>
        <h1 id="current-site">{loading ? '正在识别网站…' : domain || '当前页面不支持同步'}</h1>
        <div className="signal-route" aria-hidden="true">
          <Laptop size={18} />
          <span className="signal-line">
            <i
              data-moving={action}
              data-active={
                listed &&
                connected &&
                background &&
                (registered || settings.autoDiscoverSites !== false) &&
                (autoPush || autoPull)
              }
            />
          </span>
          <Cloud size={21} />
        </div>
        <div className="signal-bottom">
          <span>此电脑</span>
          <span>{domain ? (policy ? siteState : '正在读取名单…') : '同步目的地'}</span>
        </div>
      </section>
      {domain && policy && (
        <section className="popup-controls" aria-label="当前网站操作">
          {!listed ? (
            <div className="popup-note">
              <Globe2 size={17} aria-hidden />
              <span>加入名单后可为此网站开启自动同步。</span>
              <Button
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => void changeSite(() => sitePolicyStorage.setRule(domain, true))}>
                加入名单
              </Button>
            </div>
          ) : (
            <div className="popup-directions">
              <label>
                自动推送
                <Switch
                  aria-label="自动推送"
                  checked={autoPush}
                  disabled={saving || busy}
                  onCheckedChange={checked =>
                    void changeSite(() => domainConfigStorage.toggleAutoPushState(domain, checked))
                  }
                />
              </label>
              <label>
                自动拉取
                <Switch
                  aria-label="自动拉取"
                  checked={autoPull}
                  disabled={saving || busy}
                  onCheckedChange={checked =>
                    void changeSite(() => domainConfigStorage.toggleAutoPullState(domain, checked))
                  }
                />
              </label>
            </div>
          )}
          {listed && (
            <details className="popup-modes">
              <summary>设置此电脑的同步方向</summary>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving || busy}
                  onClick={() =>
                    void changeSite(() => domainConfigStorage.updateItem(domain, { autoPush: true, autoPull: false }))
                  }>
                  仅推送
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving || busy}
                  onClick={() =>
                    void changeSite(() => domainConfigStorage.updateItem(domain, { autoPush: false, autoPull: true }))
                  }>
                  仅拉取
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving || busy}
                  onClick={() =>
                    void changeSite(() => domainConfigStorage.updateItem(domain, { autoPush: true, autoPull: true }))
                  }>
                  双向同步
                </Button>
              </div>
            </details>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              aria-label="推送并合并 Cookie"
              disabled={busy || !connected}
              onClick={() => void transfer('push')}>
              {action === 'push' ? (
                <RefreshCw className="mr-2 animate-spin" size={15} />
              ) : (
                <ArrowUpFromLine className="mr-2" size={15} />
              )}
              {action === 'push' ? '正在推送…' : '推送到云端'}
            </Button>
            <Button
              variant="outline"
              aria-label="拉取并应用 Cookie"
              disabled={busy || !connected}
              onClick={() => void transfer('pull')}>
              {action === 'pull' ? (
                <RefreshCw className="mr-2 animate-spin" size={15} />
              ) : (
                <ArrowDownToLine className="mr-2" size={15} />
              )}
              {action === 'pull' ? '正在拉取…' : '拉取到此电脑'}
            </Button>
          </div>
        </section>
      )}
      {!connected && <Button onClick={() => void chrome.runtime.openOptionsPage()}>配置同步连接</Button>}
      <footer className="popup-footer">
        <div className="min-w-0" role="status">
          <div className="font-medium">
            {status.phase === 'uploading'
              ? '正在上传'
              : status.phase === 'checking'
                ? '正在检查'
                : status.error
                  ? '后台同步待重试'
                  : status.pendingCount
                    ? `${status.pendingCount} 个网站待上传`
                    : '后台同步记录'}
          </div>
          <div className="break-words text-muted-foreground">
            {status.error ||
              (status.lastSuccess
                ? `最近上传 ${new Date(status.lastSuccess).toLocaleString('zh-CN')}`
                : status.lastCheck
                  ? `最近检查 ${new Date(status.lastCheck).toLocaleString('zh-CN')}`
                  : '尚无记录')}
          </div>
        </div>
        <Button variant="ghost" size="sm" aria-label="打开同步管理" onClick={() => void openManager()}>
          <PanelRightOpen size={15} className="mr-1.5" aria-hidden />
          同步管理
        </Button>
      </footer>
      <Toaster theme={theme} closeButton visibleToasts={1} richColors position="top-center" />
    </main>
  );
};

export default withErrorBoundary(
  withSuspense(Popup, <div className="p-4">加载中…</div>),
  <div className="p-4">页面加载失败，请重新打开</div>,
);
