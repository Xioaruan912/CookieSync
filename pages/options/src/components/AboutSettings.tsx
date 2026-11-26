import { useGSAP } from '@gsap/react';
import {
  checkLatestRelease,
  downloadRelease,
  isUpdateForInstalledRelease,
  openExtensionsPage,
  releasesPageUrl,
  showDownloadedRelease,
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

const formatTime = (timestamp?: number) =>
  timestamp
    ? new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(timestamp)
    : '尚未检查';

export function AboutSettings() {
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
      ? '正在检查 GitHub 正式版本…'
      : ready
        ? `新版本 v${latestVersion} 已下载，等待覆盖刷新`
        : downloading
          ? `正在下载并校验 v${latestVersion}…`
          : hasUpdate
            ? `发现新版本 v${latestVersion}`
            : status.error
              ? '暂时无法连接 GitHub'
              : latestVersion
                ? '已是最新正式版本'
                : '等待检查更新';

  return (
    <section ref={stageRef} className="about-stage" aria-label="关于与更新">
      <div className="about-top-bar">
        <div className="about-wordmark-wrap">
          <h1 id="settings-title" className="about-wordmark">
            About
          </h1>
        </div>
        <div className="about-deck-tabs" role="tablist" aria-label="关于视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={slide === 'updates'}
            className="about-deck-tab"
            onClick={() => setSlide('updates')}>
            <span className="about-deck-tab-num">01</span>
            <span>版本与更新</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={slide === 'project'}
            className="about-deck-tab"
            onClick={() => setSlide('project')}>
            <span className="about-deck-tab-num">02</span>
            <span>项目与致谢</span>
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
                  仅监测 GitHub 正式版本号更新，自动校验安装包完整性。更新时直接覆盖原目录并刷新扩展，所有本机配置都会完整保留。
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
                        定位安装包
                      </button>
                      <button
                        type="button"
                        className="about-pill-ghost"
                        onClick={() => void copyOverwriteCommand()}>
                        <Copy size={14} aria-hidden="true" />
                        复制覆盖命令
                      </button>
                      <button
                        type="button"
                        className="about-pill-ghost"
                        onClick={() => void openExtensionsPage()}>
                        打开扩展管理页
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
                        下载 v{latestVersion}
                      </button>
                      <a href={releasesPageUrl} target="_blank" rel="noreferrer" className="about-pill-ghost">
                        查看发布说明
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
                        {busy === 'check' ? '正在检查…' : '检查更新'}
                      </button>
                      <a href={releasesPageUrl} target="_blank" rel="noreferrer" className="about-pill-ghost">
                        GitHub 发布页
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
                      <span>点击左侧「定位安装包」，解压 ZIP 并覆盖原安装目录</span>
                    </div>
                    <div className="about-step-row">
                      <span className="about-step-num">02</span>
                      <span>打开扩展管理页点击刷新图标（切勿先卸载，即可保留配置）</span>
                    </div>
                    <div className="about-step-row">
                      <span className="about-step-num">03</span>
                      <span>顺手刷新已打开的常用网页，立即生效</span>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="about-kicker">UPDATE MONITOR</p>
                    <div className="about-switch-row">
                      <div>
                        <span className="about-switch-title">自动下载新版本</span>
                        <span className="about-switch-desc">发现更高正式版本后后台自动下载并校验安装包</span>
                      </div>
                      <Switch
                        id="auto-update-download"
                        aria-label="自动下载新版本"
                        checked={settings.autoUpdateDownload !== false}
                        onCheckedChange={checked => void settingsStorage.update({ autoUpdateDownload: checked })}
                      />
                    </div>
                    <dl className="m-0">
                      <div className="about-spec-row">
                        <dt>GitHub 最新发布</dt>
                        <dd>{latestVersion ? `v${latestVersion}` : '尚未获取'}</dd>
                      </div>
                      <div className="about-spec-row">
                        <dt>最近检查时间</dt>
                        <dd>{formatTime(status.checkedAt)}</dd>
                      </div>
                      <div className="about-spec-row">
                        <dt>更新替换方式</dt>
                        <dd>解压覆盖原目录并刷新（保留全部配置）</dd>
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
                  专为双机交替使用、常不关机与单会话防掉线打造的私人网盘登录态同步扩展。所有数据全程保存在你自己的私人云端，无第三方中转服务器。
                </p>
                <p className="about-sub">
                  基于 <strong>jackluson/sync-your-cookie</strong> 二次开发，采用 MIT 开源许可证，完整保留原作者 Jack Lu 的版权声明。
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
                    项目仓库
                    <span className="block about-link-sub">github.com/Xioaruan912/CookieSync</span>
                  </span>
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
                <a href={releasesPageUrl} target="_blank" rel="noreferrer" className="about-link-row">
                  <span>
                    最新正式版发布页
                    <span className="block about-link-sub">查看版本更新说明与安装包校验</span>
                  </span>
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
                <a
                  href="https://github.com/jackluson/sync-your-cookie"
                  target="_blank"
                  rel="noreferrer"
                  className="about-link-row">
                  <span>
                    原项目致谢 · Jack Lu
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
