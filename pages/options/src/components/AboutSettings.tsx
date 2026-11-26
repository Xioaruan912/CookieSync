import {
  checkLatestRelease,
  downloadRelease,
  installedBuildNumber,
  isUpdateForInstalledRelease,
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

const versionLabel = (version: string, build?: number) =>
  build === undefined ? version : `${version} (build ${build})`;

export function AboutSettings() {
  const status = useStorageSuspense(updateStatusStorage);
  const settings = useStorageSuspense(settingsStorage);
  const [busy, setBusy] = useState<'check' | 'download'>();
  const currentVersion = chrome.runtime.getManifest().version;
  const currentBuild = installedBuildNumber();
  const latestVersion = status.latestVersion;
  const sameVersionWithoutBuild =
    latestVersion === currentVersion && currentBuild === undefined && status.latestBuild !== undefined;
  const hasUpdate = isUpdateForInstalledRelease(latestVersion, status.latestBuild);
  const downloading = hasUpdate && status.state === 'downloading';
  const ready = hasUpdate && status.state === 'ready';

  const check = async () => {
    setBusy('check');
    try {
      await checkLatestRelease();
    } finally {
      setBusy(undefined);
    }
  };

  const download = async () => {
    setBusy('download');
    try {
      await downloadRelease();
      toast.success('安装包已保存到下载文件夹');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '下载更新失败');
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section className="about-panel" aria-label="版本与更新">
      <div className="settings-section-head">
        <h2>版本</h2>
        <Button size="sm" variant="outline" disabled={!!busy || downloading} onClick={() => void check()}>
          {busy === 'check' ? (
            <Loader2 size={16} className="mr-1.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={16} className="mr-1.5" aria-hidden="true" />
          )}
          {busy === 'check' ? '正在检查…' : '检查更新'}
        </Button>
      </div>
      <dl className="settings-facts about-versions">
        <div>
          <dt>当前版本</dt>
          <dd>{versionLabel(currentVersion, currentBuild)}</dd>
        </div>
        <div>
          <dt>GitHub 最新发布</dt>
          <dd>{latestVersion ? versionLabel(latestVersion, status.latestBuild) : '尚未获取'}</dd>
        </div>
      </dl>
      {status.error ? (
        <p role="alert" className="text-destructive break-words">
          {status.error}
        </p>
      ) : null}
      <p role="status" className="about-status">
        {busy === 'check'
          ? '正在从 GitHub 检查更新'
          : ready
            ? '安装包已下载，等待重新加载'
            : downloading
              ? '正在下载并校验'
              : hasUpdate
                ? '有可用更新'
                : status.error
                  ? '暂时无法确认最新发布'
                  : sameVersionWithoutBuild
                    ? '版本号一致，本机未标注构建号'
                    : latestVersion
                      ? '已是最新版本'
                      : '等待检查'}
      </p>

      {hasUpdate && (ready || status.state === 'available' || downloading) ? (
        <div className="about-update">
          {status.state === 'available' ? (
            <Button size="sm" disabled={!!busy} onClick={() => void download()}>
              <Download size={16} className="mr-1.5" aria-hidden="true" />
              下载并校验更新
            </Button>
          ) : null}
          {ready ? (
            <>
              <ol className="list-decimal space-y-2 pl-5">
                <li>解压下载的 ZIP，覆盖原安装目录。</li>
                <li>打开扩展管理页，点击重新加载。</li>
                <li>刷新已打开的网页。</li>
              </ol>
              <Button size="sm" onClick={() => void openExtensionsPage()}>
                <ExternalLink size={16} className="mr-1.5" aria-hidden="true" />
                打开扩展管理页
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="settings-row">
        <Label htmlFor="auto-update-download">自动下载已确认的更新</Label>
        <Switch
          id="auto-update-download"
          checked={settings.autoUpdateDownload !== false}
          onCheckedChange={checked => void settingsStorage.update({ autoUpdateDownload: checked })}
        />
      </div>
      <Button size="sm" variant="ghost" className="justify-self-start" asChild>
        <a href={releasesPageUrl} target="_blank" rel="noreferrer">
          GitHub 发布页 <ExternalLink size={14} className="ml-1.5" aria-hidden="true" />
        </a>
      </Button>
    </section>
  );
}
