import { useGSAP } from '@gsap/react';
import {
  checkLatestRelease,
  downloadRelease,
  isUpdateForInstalledRelease,
  openExtensionsPage,
  releasesPageUrl,
  showDownloadedRelease,
  useLocale,
  useStorageSuspense,
} from '@sync-your-cookie/shared';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { updateStatusStorage } from '@sync-your-cookie/storage/lib/updateStatusStorage';
import { Switch } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import { ArrowUpRight, ChevronLeft, ChevronRight, Copy, Download, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

gsap.registerPlugin(useGSAP);

type AboutSlide = 'updates' | 'project';

const formatTime = (isEn: boolean, timestamp?: number) =>
  timestamp
    ? new Intl.DateTimeFormat(isEn ? 'en-US' : 'zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(timestamp)
    : isEn
      ? 'Not checked'
      : '尚未检查';

export function AboutSettings() {
  const { isEn, t } = useLocale();
  const status = useStorageSuspense(updateStatusStorage);
  const settings = useStorageSuspense(settingsStorage);
  const [slide, setSlide] = useState<AboutSlide>('updates');
  const [busy, setBusy] = useState<'check' | 'download'>();
  const stageRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);

  const currentVersion = chrome.runtime.getManifest().version;
  const latestVersion = status.latestVersion;
  const hasUpdate = isUpdateForInstalledRelease(latestVersion);
  const downloading = hasUpdate && status.state === 'downloading';
  const ready = hasUpdate && status.state === 'ready';

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.from('.about-wordmark', {
          yPercent: 105,
          duration: 0.72,
          ease: 'power4.out',
          clearProps: 'transform',
        });
      });
    },
    { scope: stageRef },
  );

  useGSAP(
    () => {
      if (!slideRef.current) return;
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.fromTo(
          slideRef.current,
          { opacity: 0, x: 18 },
          { opacity: 1, x: 0, duration: 0.32, ease: 'power3.out', clearProps: 'transform,opacity' },
        );
      });
    },
    { dependencies: [slide] },
  );

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
      toast.success('安装包已下载并通过完整性校验');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '下载更新失败');
    } finally {
      setBusy(undefined);
    }
  };

  const copyOverwriteCommand = async () => {
    const zipName = status.downloadName || `CookieSync-chrome-${latestVersion}.zip`;
    const cmd = `$d = (Read-Host '拖入原扩展解压目录并回车').Trim('"'); Expand-Archive -Force "$env:USERPROFILE\\Downloads\\${zipName}" -DestinationPath $d`;
    try {
      await navigator.clipboard.writeText(cmd);
      toast.success('已复制 PowerShell 一键覆盖命令');
    } catch {
      toast.error('复制失败，请手动解压覆盖');
    }
  };

  const statusTone = status.error ? 'err' : hasUpdate ? 'accent' : 'ok';
  const statusText =
    busy === 'check'
      ? t('正在检查 GitHub 正式版本…', 'Checking GitHub Releases…')
      : ready
        ? t(`新版本 v${latestVersion} 已下载，等待覆盖刷新`, `v${latestVersion} downloaded and ready to reload`)
        : downloading
          ? t(`正在下载并校验 v${latestVersion}…`, `Downloading & verifying v${latestVersion}…`)
          : hasUpdate
            ? t(`发现新版本 v${latestVersion}`, `New release v${latestVersion} available`)
            : status.error
              ? t('暂时无法连接 GitHub', 'Unable to reach GitHub')
              : latestVersion
                ? t('已是最新正式版本', 'Up to date')
                : t('等待检查更新', 'Ready to check updates');

  return (
    <section ref={stageRef} className="about-stage" aria-label={t('关于与更新', 'About & Updates')}>
      <div className="about-top-bar">
        <div className="about-wordmark-wrap">
          <h1 id="settings-title" className="about-wordmark">
            About
          </h1>
        </div>
        <div className="about-deck-tabs" role="tablist" aria-label={t('关于视图切换', 'About tabs')}>
          <button
            type="button"
            role="tab"
            aria-selected={slide === 'updates'}
            className="about-deck-tab"
            onClick={() => setSlide('updates')}>
            <span className="about-deck-tab-num">01</span>
            <span>{t('版本与更新', 'Updates')}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={slide === 'project'}
            className="about-deck-tab"
            onClick={() => setSlide('project')}>
            <span className="about-deck-tab-num">02</span>
            <span>{t('项目与致谢', 'Project & Credits')}</span>
          </button>
        </div>
      </div>

      <div className="about-viewport">
        <div ref={slideRef} className="about-split" role="tabpanel">
          {slide === 'updates' ? (
            <>
              <div className="about-left">
                <div className="about-status-line" role="status">
                  <span className="about-status-dot" data-tone={statusTone} aria-hidden="true" />
                  <span>{statusText}</span>
                </div>

                <h2 className="about-version-hero">v{currentVersion}</h2>

                <p className="about-sub">
                  {t(
                    '仅监测 GitHub 正式版本号更新，自动校验安装包完整性。更新时直接覆盖原目录并刷新扩展，所有本机配置都会完整保留。',
                    'Monitors official GitHub Releases with SHA-256 verification. Overwriting your unpacked folder and reloading preserves all local settings.',
                  )}
                </p>

                {status.error ? (
                  <p role="alert" className="about-error">
                    {status.error}
                  </p>
                ) : null}

                <div className="about-actions">
                  {ready ? (
                    <>
                      <button
                        type="button"
                        className="about-pill-primary"
                        onClick={() => showDownloadedRelease(status.downloadId)}>
                        <FolderOpen size={15} aria-hidden="true" />
                        {t('定位安装包', 'Show Package')}
                      </button>
                      <button
                        type="button"
                        className="about-pill-ghost"
                        onClick={() => void copyOverwriteCommand()}>
                        <Copy size={14} aria-hidden="true" />
                        {t('复制覆盖命令', 'Copy Update Command')}
                      </button>
                      <button
                        type="button"
                        className="about-pill-ghost"
                        onClick={() => void openExtensionsPage()}>
                        {t('打开扩展管理页', 'Open Extensions')}
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </button>
                    </>
                  ) : hasUpdate && status.state === 'available' ? (
                    <>
                      <button
                        type="button"
                        className="about-pill-primary"
                        disabled={!!busy}
                        onClick={() => void download()}>
                        {busy === 'download' ? (
                          <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                        ) : (
                          <Download size={15} aria-hidden="true" />
                        )}
                        {t(`下载 v${latestVersion}`, `Download v${latestVersion}`)}
                      </button>
                      <a href={releasesPageUrl} target="_blank" rel="noreferrer" className="about-pill-ghost">
                        {t('查看发布说明', 'Release Notes')}
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </a>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="about-pill-primary"
                        disabled={!!busy || downloading}
                        onClick={() => void check()}>
                        {busy === 'check' ? (
                          <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                        ) : (
                          <RefreshCw size={15} aria-hidden="true" />
                        )}
                        {busy === 'check' ? t('正在检查…', 'Checking…') : t('检查更新', 'Check Updates')}
                      </button>
                      <a href={releasesPageUrl} target="_blank" rel="noreferrer" className="about-pill-ghost">
                        {t('GitHub 发布页', 'GitHub Releases')}
                        <ArrowUpRight size={14} aria-hidden="true" />
                      </a>
                    </>
                  )}
                </div>
              </div>

              <div className="about-right">
                {ready ? (
                  <>
                    <p className="about-kicker">3-STEP REPLACE</p>
                    <div className="about-step-row">
                      <span className="about-step-num">01</span>
                      <span>{t('点击左侧「定位安装包」，解压 ZIP 并覆盖原安装目录', 'Click "Show Package" and extract the ZIP over your extension folder')}</span>
                    </div>
                    <div className="about-step-row">
                      <span className="about-step-num">02</span>
                      <span>{t('打开扩展管理页点击刷新图标（切勿先卸载，即可保留配置）', 'Open chrome://extensions and click Reload (do not uninstall)')}</span>
                    </div>
                    <div className="about-step-row">
                      <span className="about-step-num">03</span>
                      <span>{t('顺手刷新已打开的常用网页，立即生效', 'Refresh your open tabs to apply immediately')}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="about-kicker">UPDATE MONITOR</p>
                    <div className="about-switch-row">
                      <div>
                        <span className="about-switch-title">{t('自动下载新版本', 'Auto-Download Releases')}</span>
                        <span className="about-switch-desc">
                          {t('发现更高正式版本后后台自动下载并校验安装包', 'Automatically download and verify newer GitHub Releases in the background')}
                        </span>
                      </div>
                      <Switch
                        id="auto-update-download"
                        aria-label={t('自动下载新版本', 'Auto-Download Releases')}
                        checked={settings.autoUpdateDownload !== false}
                        onCheckedChange={checked => void settingsStorage.update({ autoUpdateDownload: checked })}
                      />
                    </div>
                    <dl className="m-0">
                      <div className="about-spec-row">
                        <dt>{t('GitHub 最新发布', 'Latest GitHub Release')}</dt>
                        <dd>{latestVersion ? `v${latestVersion}` : t('尚未获取', 'Unknown')}</dd>
                      </div>
                      <div className="about-spec-row">
                        <dt>{t('最近检查时间', 'Last Checked')}</dt>
                        <dd>{formatTime(isEn, status.checkedAt)}</dd>
                      </div>
                      <div className="about-spec-row">
                        <dt>{t('更新替换方式', 'Update Method')}</dt>
                        <dd>{t('解压覆盖原目录并刷新（保留全部配置）', 'Store auto-update or overwrite unpacked folder')}</dd>
                      </div>
                    </dl>
                  </>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="about-left">
                <p className="about-kicker">OPEN SOURCE</p>
                <h2 className="about-version-hero">CookieSync</h2>
                <p className="about-sub">
                  {t(
                    '专为双机交替使用、常不关机与单会话防掉线打造的私人网盘登录态同步扩展。所有数据全程保存在你自己的私人云端，无第三方中转服务器。',
                    'Private WebDAV browser session sync built for seamless dual-PC handover and single-session anti-kick protection. Zero third-party relay servers.',
                  )}
                </p>
                <p className="about-sub">
                  {t(
                    '基于 jackluson/sync-your-cookie 二次开发，采用 MIT 开源许可证，完整保留原作者 Jack Lu 的版权声明。',
                    'Forked from jackluson/sync-your-cookie under the MIT License with full attribution to original author Jack Lu.',
                  )}
                </p>
              </div>

              <div className="about-right">
                <p className="about-kicker">LINKS &amp; CREDITS</p>
                <a
                  href="https://github.com/Xioaruan912/CookieSync"
                  target="_blank"
                  rel="noreferrer"
                  className="about-link-row">
                  <span>
                    {t('项目仓库', 'Repository')}
                    <span className="block about-link-sub">github.com/Xioaruan912/CookieSync</span>
                  </span>
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
                <a href={releasesPageUrl} target="_blank" rel="noreferrer" className="about-link-row">
                  <span>
                    {t('最新正式版发布页', 'Official Releases')}
                    <span className="block about-link-sub">{t('查看版本更新说明与安装包校验', 'Changelogs and SHA-256 checksums')}</span>
                  </span>
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
                <a
                  href="https://github.com/jackluson/sync-your-cookie"
                  target="_blank"
                  rel="noreferrer"
                  className="about-link-row">
                  <span>
                    {t('原项目致谢 · Jack Lu', 'Original Project · Jack Lu')}
                    <span className="block about-link-sub">github.com/jackluson/sync-your-cookie</span>
                  </span>
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="about-rail">
        <p className="about-rail-note">CookieSync v{currentVersion} · MIT License</p>
        <div className="about-pager" aria-label="切换页面">
          <button
            type="button"
            className="about-pager-btn"
            aria-label="上一页"
            disabled={slide === 'updates'}
            onClick={() => setSlide('updates')}>
            <ChevronLeft size={15} aria-hidden="true" />
          </button>
          <span className="about-pager-num">{slide === 'updates' ? '01' : '02'} / 02</span>
          <button
            type="button"
            className="about-pager-btn"
            aria-label="下一页"
            disabled={slide === 'project'}
            onClick={() => setSlide('project')}>
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}
