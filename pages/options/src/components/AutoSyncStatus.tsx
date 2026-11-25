import { useStorageSuspense } from '@sync-your-cookie/shared';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { syncFeedbackStorage } from '@sync-your-cookie/storage/lib/syncFeedbackStorage';
import { Button } from '@sync-your-cookie/ui';
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { useEffect, useState } from 'react';

interface BulkSummary {
  domains: number;
  cookies: number;
  localStorageItems: number;
  sessionStorageItems?: number;
  skipped: number;
}

type ConfirmMode = 'pull' | 'push';

export function AutoSyncStatus() {
  const status = useStorageSuspense(autoSyncStatusStorage);
  const settings = useStorageSuspense(settingsStorage);
  const feedback = useStorageSuspense(syncFeedbackStorage);
  const [truncated, setTruncated] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmMode>();
  const [message, setMessage] = useState('');
  const enabled = settings.backgroundSync !== false;
  const phase = status.phase === 'uploading' ? '正在上传' : status.phase === 'checking' ? '正在比对' : '等待变化';
  const truncatedCount = Object.values(truncated).filter(count => count > 0).length;
  useEffect(() => {
    void chrome.storage.local
      .get('cookiesync-storage-truncated')
      .then(value => setTruncated((value['cookiesync-storage-truncated'] || {}) as Record<string, number>))
      .catch(() => {});
  }, [status.lastCheck, status.lastSuccess, status.note]);
  const time = (value?: number) => (value ? new Date(value).toLocaleString() : '尚无记录');
  const sync = async () => {
    setBusy(true);
    setMessage('');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CookieSyncRunAutomaticSync' });
      if (!response?.isOk) throw new Error('同步任务未启动，请重新加载插件后重试');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '同步任务未启动');
    } finally {
      setBusy(false);
    }
  };

  const runBulk = async (mode: ConfirmMode) => {
    setBulkBusy(true);
    setMessage('');
    try {
      const response = await chrome.runtime.sendMessage({
        type: mode === 'pull' ? 'CookieSyncPullAll' : 'CookieSyncPushAll',
      });
      if (!response?.isOk) throw new Error(response?.msg || (mode === 'pull' ? '拉取全部失败' : '全部上传失败'));
      const result = response.result as BulkSummary;
      const storage = [
        result.localStorageItems ? `${result.localStorageItems} 项本地存储` : '',
        result.sessionStorageItems ? `${result.sessionStorageItems} 项会话存储` : '',
      ].filter(Boolean);
      setMessage(
        mode === 'pull'
          ? `已从云端拉取 ${result.domains} 个网站（${result.cookies} 个 Cookie${storage.length ? '、' + storage.join('、') : ''}），跳过 ${result.skipped} 个名单外或已暂停的网站`
          : `已向云端上传 ${result.domains} 个网站（${result.cookies} 个 Cookie${storage.length ? '、' + storage.join('、') : ''}），跳过 ${result.skipped} 个名单外或已暂停的网站`,
      );
      setConfirm(undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : mode === 'pull' ? '拉取全部失败' : '全部上传失败');
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="mx-6 mb-6 grid gap-3 text-sm" aria-label="自动同步状态">
      <div className="grid gap-2.5 rounded-2xl bg-muted/60 p-4 border border-border/70">
        <label className="flex items-start gap-2.5 font-medium">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={settings.activeDeviceSync !== false}
            onChange={event => void settingsStorage.update({ activeDeviceSync: event.target.checked })}
          />
          <span>
            双机活跃自动交接（默认开启 · 推荐）
            <small className="block font-normal text-muted-foreground mt-0.5">
              自动识别你正在使用哪台电脑：关键登录 5 秒上云，离开 90 秒传完即静默；换到另一台电脑一用就自动接班拉取。
            </small>
          </span>
        </label>
        <label className="flex items-start gap-2.5 font-medium">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={settings.discardIdleSingleSessionTabs !== false}
            onChange={event => void settingsStorage.update({ discardIdleSingleSessionTabs: event.target.checked })}
          />
          <span>
            不关机电脑待机/失租时自动休眠 115 后台标签页（默认开启）
            <small className="block font-normal text-muted-foreground mt-0.5">
              绝不关闭标签页、不打扰正在用的电脑；仅在离开锁屏或另一台电脑接班后暂停闲置机上的 115 后台心跳，彻底防互踢。
            </small>
          </span>
        </label>
      </div>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={settings.autoDiscoverSites !== false}
          onChange={event => void settingsStorage.update({ autoDiscoverSites: event.target.checked })}
        />
        自动发现名单内新访问的网站（默认开启）
      </label>
      <p className="text-muted-foreground">
        名单内的网站存在 Cookie 或 LocalStorage
        时自动登记。关闭此开关仅停止发现新站点，已登记站点仍受网站名单和逐站开关控制。
      </p>
      <p>
        自动同步：{enabled ? `已开启 · ${phase}` : '已关闭'} · 待上传 {status.pendingCount || 0} 个网站
      </p>
      <dl className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg bg-muted p-3">
          <dt className="text-muted-foreground text-xs">最近检查</dt>
          <dd>{time(status.lastCheck)}</dd>
        </div>
        <div className="rounded-lg bg-muted p-3">
          <dt className="text-muted-foreground text-xs">最近上传成功</dt>
          <dd>{time(status.lastSuccess)}</dd>
        </div>
      </dl>
      {status.note ? <p role="status">{status.note}</p> : null}
      {feedback.schemaWarning ? (
        <p role="alert" className="rounded-lg bg-muted p-3 break-words">
          {feedback.schemaWarning.message}
        </p>
      ) : null}
      {truncatedCount > 0 ? (
        <p className="text-muted-foreground">
          有 {truncatedCount} 个网站的存储项超出同步上限（单项 128 KB／每站点 2 MB），超出的键未上传，以免云端文件失控。
        </p>
      ) : null}
      {(status.error || message) && (
        <p role="alert" className="text-destructive break-words">
          {message || status.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!enabled || busy || status.phase === 'checking' || status.phase === 'uploading'}
          onClick={sync}>
          {busy ? '检查中…' : '立即检查并同步'}
        </Button>
        {confirm === 'pull' ? (
          <>
            <Button size="sm" disabled={!enabled || bulkBusy} onClick={() => void runBulk('pull')}>
              {bulkBusy ? '拉取中…' : '确认用云端覆盖'}
            </Button>
            <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={() => setConfirm(undefined)}>
              取消
            </Button>
          </>
        ) : confirm === 'push' ? (
          <>
            <Button size="sm" disabled={!enabled || bulkBusy} onClick={() => void runBulk('push')}>
              {bulkBusy ? '上传中…' : '确认用本机覆盖'}
            </Button>
            <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={() => setConfirm(undefined)}>
              取消
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" disabled={!enabled || bulkBusy} onClick={() => setConfirm('pull')}>
              <ArrowDownToLine size={15} className="mr-1" aria-hidden="true" />
              拉取全部
            </Button>
            <Button size="sm" variant="outline" disabled={!enabled || bulkBusy} onClick={() => setConfirm('push')}>
              <ArrowUpFromLine size={15} className="mr-1" aria-hidden="true" />
              全部上传
            </Button>
          </>
        )}
      </div>
      {confirm === 'pull' ? (
        <p className="text-muted-foreground">
          将从云端覆盖名单内所有开启自动拉取的网站；本机这些网站尚未上传的改动会被放弃，名单外或已暂停的网站不受影响。
        </p>
      ) : confirm === 'push' ? (
        <p className="text-muted-foreground">
          将把名单内所有开启自动推送网站的本机数据覆盖云端对应网站；云端这些网站较新的改动会被覆盖，名单外或已暂停的网站不受影响。
        </p>
      ) : (
        <p className="text-muted-foreground">
          连接后自动检查，随后每 {settings.syncIntervalMinutes || 2} 分钟比对；内容一致跳过上传，两端都变化时保留较新一侧。
        </p>
      )}
    </div>
  );
}
