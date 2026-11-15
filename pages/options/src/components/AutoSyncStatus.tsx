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
    <div className="mx-6 mb-4 rounded border p-3 text-xs grid gap-2" aria-label="自动同步状态">
      <p>
        自动同步：{enabled ? `已开启 · ${phase}` : '已关闭'} · 待上传 {status.pendingCount || 0} 个网站
      </p>
      <p>最近检查：{time(status.lastCheck)}</p>
      <p>最近上传成功：{time(status.lastSuccess)}</p>
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
