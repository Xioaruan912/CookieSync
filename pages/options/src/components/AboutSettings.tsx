import {
  checkLatestRelease,
  downloadRelease,
  openExtensionsPage,
  releasesPageUrl,
  useStorageSuspense,
} from '@sync-your-cookie/shared';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { updateStatusStorage } from '@sync-your-cookie/storage/lib/updateStatusStorage';
import { Button, Label, Switch } from '@sync-your-cookie/ui';
import { BadgeCheck, Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

const time = (value?: number) => (value ? new Date(value).toLocaleString() : '尚无记录');

export function AboutSettings() {
  const status = useStorageSuspense(updateStatusStorage);
  const settings = useStorageSuspense(settingsStorage);
  const [busy, setBusy] = useState<'check' | 'download' | undefined>();
  const currentVersion = chrome.runtime.getManifest().version;
  const hasUpdate = status.state === 'available' || status.state === 'downloading' || status.state === 'ready';

  const check = async () => {
    setBusy('check');
    try {
      await checkLatestRelease();
      const latest = await updateStatusStorage.get();
      if (latest.state === 'available') toast.success(`发现新版本 ${latest.latestVersion}`);
      else if (latest.state === 'ready') toast.info('安装包已下载，按下方步骤完成更新');
      else if (latest.error) toast.error(latest.error);
      else toast.success('已是最新版本');
    } finally {
      setBusy(undefined);
    }
  };

  const download = async () => {
    setBusy('download');
    try {
      await downloadRelease();
      toast.success('已下载并校验安装 ZIP，见下载文件夹');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '下载更新失败');
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="grid gap-4 text-sm" aria-label="关于与更新">
      <div className="grid gap-1">
        <h2 className="section-title">关于与更新</h2>
        <p className="text-muted-foreground">
          当前版本 {currentVersion}
          {status.latestVersion && status.latestVersion !== currentVersion ? ` · 最新发布 ${status.latestVersion}` : ''}
        </p>
      </div>

      <div className="grid gap-2 rounded-lg bg-muted p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">检查更新</span>
          <span>{time(status.checkedAt)}</span>
        </div>
        {status.error ? (
          <p role="alert" className="text-destructive break-words">
            {status.error}
          </p>
        ) : null}
        {hasUpdate ? (
          <div className="grid gap-2">
            <p className="flex items-center gap-2 font-medium">
              <BadgeCheck size={16} aria-hidden="true" />
              新版本 {status.latestVersion} 已发布
            </p>
            {status.state === 'ready' ? (
              <p className="text-muted-foreground">
                安装包已校验并保存到下载文件夹：{status.downloadName}。继续以下三步完成更新：
              </p>
            ) : (
              <p className="text-muted-foreground">下载校验通过的安装包，然后按三步完成更新。</p>
            )}
            <ol className="grid gap-1 list-decimal pl-5 text-muted-foreground">
              <li>解压新版 ZIP，覆盖原安装目录（不要先卸载，保留本机配置）</li>
              <li>在 chrome://extensions 点击“重新加载”</li>
              <li>刷新已打开的网页，让内容脚本生效</li>
            </ol>
            <div className="flex flex-wrap gap-2">
              {status.state === 'available' ? (
                <Button size="sm" disabled={busy !== undefined} onClick={() => void download()}>
                  {busy === 'download' ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Download size={15} className="mr-1" aria-hidden="true" />
                  )}
                  下载并校验更新
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={() => void openExtensionsPage()}>
                <ExternalLink size={15} className="mr-1" aria-hidden="true" />
                打开 chrome://extensions
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href={releasesPageUrl} target="_blank" rel="noreferrer">
                  查看发布页
                </a>
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground">未发现新版本。扩展每天自动检查一次，也仅对版本号升级提示。</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy !== undefined || status.state === 'downloading'} onClick={() => void check()}>
            {busy === 'check' ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={15} className="mr-1" aria-hidden="true" />
            )}
            立即检查更新
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Chrome 不会自动替换解压加载的扩展；此页负责检查、下载与校验，最后一步覆盖与重新加载需要你完成。
        </p>
      </div>

      <div className="flex items-center justify-between gap-2 rounded-lg bg-muted p-3">
        <Label htmlFor="auto-update-download">发现新版本时自动下载并校验</Label>
        <Switch
          id="auto-update-download"
          checked={settings.autoUpdateDownload !== false}
          onCheckedChange={checked => void settingsStorage.update({ autoUpdateDownload: checked })}
        />
      </div>
    </section>
  );
}
