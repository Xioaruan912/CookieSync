import {
  checkLatestRelease,
  downloadRelease,
  installedBuildNumber,
  openExtensionsPage,
  releasesPageUrl,
  useStorageSuspense,
} from '@sync-your-cookie/shared';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { updateStatusStorage } from '@sync-your-cookie/storage/lib/updateStatusStorage';
import { Button, Label, Switch } from '@sync-your-cookie/ui';
import { Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

const time = (value?: number) => (value ? new Date(value).toLocaleString() : '尚无记录');

export function AboutSettings() {
  const status = useStorageSuspense(updateStatusStorage);
  const settings = useStorageSuspense(settingsStorage);
  const [busy, setBusy] = useState<'check' | 'download' | undefined>();
  const currentVersion = chrome.runtime.getManifest().version;
  const currentBuild = installedBuildNumber();
  const versionLabel = (version?: string, build?: number) =>
    version ? `${version}${build ? `（build ${build}）` : ''}` : '';
  const hasUpdate = status.state === 'available' || status.state === 'downloading' || status.state === 'ready';

  const check = async () => {
    setBusy('check');
    try {
      await checkLatestRelease();
      const latest = await updateStatusStorage.get();
      if (latest.state === 'available')
        toast.success(`发现新版本 ${versionLabel(latest.latestVersion, latest.latestBuild)}`);
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
      <div className="settings-subcard grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="grid gap-1">
            <p className="font-medium">更新检查</p>
            <p className="text-muted-foreground text-xs">
              <span className="text-foreground">当前版本 {versionLabel(currentVersion, currentBuild)}</span>
              {status.checkedAt ? ` · 最近检查 ${time(status.checkedAt)}` : ''}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== undefined || status.state === 'downloading'}
            onClick={() => void check()}>
            {busy === 'check' ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={15} className="mr-1" aria-hidden="true" />
            )}
            立即检查更新
          </Button>
        </div>

        {status.error ? (
          <p role="alert" className="text-destructive break-words">
            {status.error}
          </p>
        ) : null}

        {hasUpdate ? (
          <div className="grid gap-3 rounded-md border border-border bg-muted p-3">
            <div className="grid gap-1">
              <p className="flex items-center gap-2 font-medium">
                <span className="version-dot" aria-hidden="true" />
                新版本 {versionLabel(status.latestVersion, status.latestBuild)} 已发布
              </p>
              <p className="text-muted-foreground">
                {status.state === 'ready'
                  ? `安装包已校验并保存到下载文件夹：${status.downloadName || 'CookieSync-chrome-*.zip'}。继续以下三步完成更新：`
                  : '安装包将自动下载并校验 SHA-256；完成后按以下三步更新：'}
              </p>
            </div>
            <ol className="grid gap-1.5 pl-5 text-muted-foreground" style={{ listStyle: 'decimal' }}>
              <li>解压新版 ZIP，覆盖原安装目录（不要卸载，保留本机配置）</li>
              <li>在 chrome://extensions 点击“重新加载”</li>
              <li>刷新已打开的网页，让内容脚本生效</li>
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              {status.state === 'available' ? (
                <Button size="sm" disabled={busy !== undefined} onClick={() => void download()}>
                  {busy === 'download' ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Download size={15} className="mr-1" aria-hidden="true" />
                  )}
                  下载并校验更新
                </Button>
              ) : status.state === 'ready' ? (
                <Button size="sm" onClick={() => void openExtensionsPage()}>
                  <ExternalLink size={15} className="mr-1" aria-hidden="true" />
                  打开 chrome://extensions
                </Button>
              ) : null}
              {status.state !== 'ready' ? (
                <Button size="sm" variant="outline" onClick={() => void openExtensionsPage()}>
                  <ExternalLink size={15} className="mr-1" aria-hidden="true" />
                  打开 chrome://extensions
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" asChild>
                <a href={releasesPageUrl} target="_blank" rel="noreferrer">
                  查看发布页 ↗
                </a>
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground">
            未发现新版本。扩展每天及启动时自动检查；网络受限时可手动打开发布页下载。
          </p>
        )}

        <p className="text-muted-foreground text-xs">
          Chrome 不会自动替换解压加载的扩展：下载与校验自动完成，覆盖安装与重新加载需要你手动操作。
        </p>
      </div>

      <div className="settings-subcard flex items-center justify-between gap-4">
        <div className="grid gap-1">
          <Label htmlFor="auto-update-download">发现新版本时自动下载并校验</Label>
          <p className="text-muted-foreground text-xs">校验失败的安装包不会保存；关闭后仍会提示新版本。</p>
        </div>
        <Switch
          id="auto-update-download"
          checked={settings.autoUpdateDownload !== false}
          onCheckedChange={checked => void settingsStorage.update({ autoUpdateDownload: checked })}
        />
      </div>
    </section>
  );
}
