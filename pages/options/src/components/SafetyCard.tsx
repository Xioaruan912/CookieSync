import { useStorageSuspense } from '@sync-your-cookie/shared';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { snapshotStorage } from '@sync-your-cookie/storage/lib/snapshotStorage';
import { syncFeedbackStorage } from '@sync-your-cookie/storage/lib/syncFeedbackStorage';
import { Button } from '@sync-your-cookie/ui';
import { ArchiveRestore, Download, HardDriveDownload, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

interface BackupSlot {
  slot: number;
  exists: boolean;
  bytes: number;
}

const reasonLabel: Record<string, string> = {
  'pull-all': '拉取全部前',
  'push-all': '全部上传前',
  'pull-site': '单站拉取前',
  'push-site': '单站推送前',
};

const size = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

export function SafetyCard() {
  const snapshots = useStorageSuspense(snapshotStorage);
  const settings = useStorageSuspense(settingsStorage);
  const feedback = useStorageSuspense(syncFeedbackStorage);
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [backups, setBackups] = useState<BackupSlot[]>();

  useEffect(() => () => setConfirm(''), []);

  const act = async (key: string, run: () => Promise<void>) => {
    if (confirm !== key) {
      setConfirm(key);
      return;
    }
    setConfirm('');
    setBusy(key);
    setError('');
    setMessage('');
    try {
      await run();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy('');
    }
  };

  const rollback = (id: string, local: boolean) =>
    act(`rollback:${id}`, async () => {
      const response = await chrome.runtime.sendMessage({ type: 'CookieSyncRollback', id });
      if (!response?.isOk) throw new Error(response?.msg || '回滚失败');
      setMessage(
        local
          ? `已把 ${response.result?.sites ?? 0} 个网站恢复为快照中的本机状态，并刷新对应页面`
          : `已把 ${response.result?.sites ?? 0} 个网站的快照重新上传到云端`,
      );
    });

  const exportDiagnostics = async () => {
    setBusy('diagnostics');
    setError('');
    setMessage('');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CookieSyncDiagnostics' });
      if (!response?.isOk) throw new Error(response?.msg || '导出诊断失败');
      const blob = new Blob([JSON.stringify(response.result, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `cookiesync-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage('诊断文件已导出：只包含名称、长度和值的前两位，不含完整 Cookie 或密码');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导出诊断失败');
    } finally {
      setBusy('');
    }
  };

  const loadBackups = async () => {
    setBusy('backups');
    setError('');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CookieSyncBackupInfo' });
      if (!response?.isOk) throw new Error(response?.msg || '读取备份失败');
      setBackups(response.result as BackupSlot[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取备份失败');
    } finally {
      setBusy('');
    }
  };

  const restore = (slot: number) =>
    act(`backup:${slot}`, async () => {
      const response = await chrome.runtime.sendMessage({ type: 'CookieSyncRestoreBackup', slot });
      if (!response?.isOk) throw new Error(response?.msg || '恢复备份失败');
      setMessage(`已用槽位 ${slot} 覆盖云端文件；当前内容已转入槽位 1，可再次恢复`);
      await loadBackups();
    });

  return (
    <div className="safety-card" aria-label="回滚与诊断">
      <h3>回滚与诊断</h3>
      <p className="text-muted-foreground text-sm">
        批量拉取或上传前会自动保留一个回滚点；回滚点只保存在本机，最多 4 个，不会上传到 WebDAV。
      </p>
      {snapshots.length ? (
        <ul className="safety-snapshots">
          {snapshots.map(snapshot => (
            <li key={snapshot.id}>
              <div>
                <strong>
                  {reasonLabel[snapshot.reason] || snapshot.reason} ·{' '}
                  {snapshot.kind === 'remote' ? '云端副本' : '本机状态'}
                </strong>
                <span>
                  {new Date(snapshot.at).toLocaleString('zh-CN')} · {Object.keys(snapshot.sites).length} 个网站
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy}
                onClick={() => void rollback(snapshot.id, snapshot.kind === 'local')}>
                {busy === `rollback:${snapshot.id}` ? <Loader2 size={13} className="mr-1 animate-spin" /> : <ArchiveRestore size={14} className="mr-1" />}
                {confirm === `rollback:${snapshot.id}` ? '确认恢复' : '恢复'}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="safety-empty">还没有回滚点。执行一次「拉取全部」或「全部上传」后会自动创建。</p>
      )}

      <div className="safety-actions">
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void exportDiagnostics()}>
          {busy === 'diagnostics' ? <Loader2 size={14} className="mr-1 animate-spin" /> : <Download size={14} className="mr-1" />}
          导出脱敏诊断
        </Button>
        <span className="text-muted-foreground">
          用于排查同步问题：包含 Cookie 名称与值长度，不含完整值、密码或 WebDAV 凭据。
        </span>
      </div>

      <div className="safety-backups">
        <div className="safety-backup-head">
          <div>
            <strong>云端历史备份</strong>
            <p>每天首次真实上传前，把旧文件转到同一目录下的 .bak.1～3。</p>
          </div>
          <label className="safety-toggle">
            <input
              type="checkbox"
              checked={settings.rollingBackup !== false}
              onChange={event => void settingsStorage.update({ rollingBackup: event.target.checked })}
            />
            自动保留
          </label>
        </div>
        {feedback.backupWarning ? (
          <p className="safety-warning" role="alert">
            {feedback.backupWarning.message}
          </p>
        ) : null}
        <div className="safety-backup-slots">
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void loadBackups()}>
            {busy === 'backups' ? <Loader2 size={14} className="mr-1 animate-spin" /> : <HardDriveDownload size={14} className="mr-1" />}
            读取备份信息
          </Button>
          {(backups || []).map(backup => (
            <div key={backup.slot} className="safety-slot" data-empty={!backup.exists}>
              <span>
                槽位 {backup.slot} · {backup.exists ? size(backup.bytes) : '空'}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={!backup.exists || !!busy}
                onClick={() => void restore(backup.slot)}>
                {confirm === `backup:${backup.slot}` ? '确认覆盖云端' : '恢复'}
              </Button>
            </div>
          ))}
        </div>
      </div>

      {message ? <p role="status">{message}</p> : null}
      {error ? (
        <p role="alert" className="text-destructive break-words">
          {error}
        </p>
      ) : null}
    </div>
  );
}
