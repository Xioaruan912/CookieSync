import { useStorageSuspense } from '@sync-your-cookie/shared';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { Button } from '@sync-your-cookie/ui';
import { useState } from 'react';

export function AutoSyncStatus() {
  const status = useStorageSuspense(autoSyncStatusStorage);
  const settings = useStorageSuspense(settingsStorage);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const enabled = settings.backgroundSync !== false;
  const phase = status.phase === 'uploading' ? '正在上传' : status.phase === 'checking' ? '正在比对' : '等待变化';
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
  return (
    <div className="mx-6 mb-6 grid gap-3 text-sm" aria-label="自动同步状态">
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
      {(status.error || message) && (
        <p role="alert" className="text-destructive break-words">
          {message || status.error}
        </p>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={!enabled || busy || status.phase === 'checking' || status.phase === 'uploading'}
        onClick={sync}>
        {busy ? '检查中…' : '立即检查并同步'}
      </Button>
      <p className="text-muted-foreground">
        连接后自动检查，随后每 {settings.syncIntervalMinutes || 2} 分钟比对。SHA-256 内容一致时跳过上传。
      </p>
    </div>
  );
}
