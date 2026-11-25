import { useGSAP } from '@gsap/react';
import { useStorageSuspense, useTheme, withErrorBoundary, withSuspense } from '@sync-your-cookie/shared';
import { accountStorage, isLegacyProvider } from '@sync-your-cookie/storage/lib/accountStorage';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { Button, CardContent, ThemeDropdown, Toaster } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import { Activity, Cable, Globe2, Info, LayoutDashboard, SlidersVertical, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AboutSettings } from './components/AboutSettings';
import { AutoSyncStatus } from './components/AutoSyncStatus';
import { ConfigChannelSettings } from './components/ConfigChannelSettings';
import { ConnectionGuide } from './components/ConnectionGuide';
import { ContinuityHeroStage } from './components/ContinuityHeroStage';
import { OverviewPanel } from './components/OverviewPanel';
import { SafetyCard } from './components/SafetyCard';
import { SettingsPopover } from './components/SettingsPopover';
import { SiteHealthSettings } from './components/SiteHealthSettings';
import { SitePolicySettings } from './components/SitePolicySettings';
import { WebdavSettings } from './components/WebdavSettings';

gsap.registerPlugin(useGSAP);

const sections = {
  overview: '双机总览',
  connection: '同步连接',
  automation: '自动与 115',
  sites: '网站名单',
  about: '关于与更新',
} as const;

type SectionKey = keyof typeof sections;

const sectionIcons: Record<SectionKey, typeof LayoutDashboard> = {
  overview: LayoutDashboard,
  connection: Cable,
  automation: Activity,
  sites: Globe2,
  about: Info,
};

const sectionCopy: Record<SectionKey, { title: string; lede: string }> = {
  overview: {
    title: '站点同步总览',
    lede: '所有已登记网站一屏掌控：最近推拉、待上传队列、115 登录有效性与页面存储数量。逐站操作只影响对应网站。',
  },
  connection: {
    title: 'WebDAV 同步连接',
    lede: 'Cookie 与页面存储全部经私人 WebDAV 传输；搭配端到端 AES-256 加密，配置可随 Chrome 账号或 WebDAV 配置文件同步。',
  },
  automation: {
    title: '自动交接与 115 护航',
    lede: '自动识别当前活跃电脑并单主推送；115 配备只读会话检测、残缺防降级拦截、闲置休眠防互踢与一键扫码修复。',
  },
  sites: {
    title: '自动同步网站名单',
    lede: '内置 300 个常用站点，可自由搜索、增补或单独停用；名单外站点暂停自动收发但保留历史数据。',
  },
  about: {
    title: '关于与版本更新',
    lede: '自动检查 GitHub Releases 新版本与新构建号，下载校验后按三步覆盖重载即可。',
  },
};

const currentSection = (): SectionKey => {
  const key = window.location.hash.slice(1) as SectionKey;
  return key in sections ? key : 'overview';
};

const Options = () => {
  const [section, setSection] = useState<SectionKey>(currentSection);
  const [docked, setDocked] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const navigate = useCallback((next: SectionKey) => {
    setSection(next);
    if (window.location.hash !== `#${next}`) {
      window.history.replaceState(null, '', `#${next}`);
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => setSection(currentSection());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const accountInfo = useStorageSuspense(accountStorage);
  const syncStatus = useStorageSuspense(autoSyncStatusStorage);
  const { setTheme } = useTheme();
  const version = chrome.runtime.getManifest().version;

  // Interruptible GSAP sliding indicator for the Titanium segmented nav
  useLayoutEffect(() => {
    const nav = navRef.current;
    const pill = pillRef.current;
    if (!nav || !pill) return;
    const active = nav.querySelector<HTMLButtonElement>(`button[data-key="${section}"]`);
    if (!active) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    gsap.to(pill, {
      x: active.offsetLeft,
      width: active.offsetWidth,
      opacity: 1,
      duration: reduce ? 0 : 0.34,
      ease: 'power3.out',
      overwrite: 'auto',
    });
  }, [section, syncStatus.pendingCount]);

  // Single-container crisp entrance when switching section decks
  useGSAP(
    () => {
      const panel = panelRef.current;
      if (!panel) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      gsap.fromTo(
        panel,
        { y: 10, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.28, ease: 'power3.out', clearProps: 'transform' },
      );
    },
    { dependencies: [section] },
  );

  const isStandby = syncStatus.deviceRole === 'standby';

  return (
    <main className="titanium-shell">
      <header className="titanium-header" data-docked={docked}>
        <div className="titanium-header-inner">
          <div className="titanium-brand">
            <img src={chrome.runtime.getURL('options/logo.png')} className="size-7 rounded-lg object-contain" alt="" />
            <div>
              <strong>CookieSync</strong>
              <small>v{version}</small>
            </div>
          </div>

          <nav ref={navRef} className="titanium-segmented" aria-label="主导航">
            <span ref={pillRef} className="segmented-pill" aria-hidden="true" />
            {(Object.keys(sections) as SectionKey[]).map(key => {
              const Icon = sectionIcons[key];
              return (
                <button
                  key={key}
                  type="button"
                  data-key={key}
                  aria-current={section === key ? 'page' : undefined}
                  onClick={() => navigate(key)}>
                  <Icon size={14} aria-hidden="true" />
                  <span>{sections[key]}</span>
                  {key === 'overview' && syncStatus.pendingCount ? (
                    <em className="seg-badge" aria-label={`${syncStatus.pendingCount} 个网站待上传`}>
                      {syncStatus.pendingCount}
                    </em>
                  ) : null}
                </button>
              );
            })}
          </nav>

          <div className="titanium-header-right">
            <div className="docked-status-pill" data-visible={docked} aria-live="polite">
              <span className="live-orb" data-state={isStandby ? 'standby' : 'live'} aria-hidden="true" />
              <span>{isStandby ? '待机护航' : '本机当家'}</span>
            </div>
            <SettingsPopover
              trigger={
                <Button variant="outline" size="sm" className="rounded-full">
                  <SlidersVertical size={14} className="mr-1.5" />
                  高级设置
                </Button>
              }
            />
            <ThemeDropdown setTheme={setTheme} />
          </div>
        </div>
      </header>

      <div className="titanium-container">
        {/* Scene 1 & 2: Apple Titanium Bento Hero Stage */}
        <ContinuityHeroStage onNavigate={navigate} onDockChange={setDocked} />

        {/* Scene 3: Active Workspace Deck */}
        <div ref={panelRef} className="titanium-workspace">
          <div className="workspace-head">
            <h2>{sectionCopy[section].title}</h2>
            <p>{sectionCopy[section].lede}</p>
          </div>

          {section === 'overview' ? (
            <div className="titanium-panel-card">
              <OverviewPanel />
            </div>
          ) : null}

          {section === 'connection' ? (
            <div className="titanium-stack">
              {isLegacyProvider(accountInfo) ? (
                <CardContent className="titanium-panel-card legacy-migration" role="alert">
                  <TriangleAlert size={18} aria-hidden="true" />
                  <div>
                    <p className="font-semibold">检测到旧版同步后端</p>
                    <p className="text-muted-foreground text-sm">
                      GitHub Gist、Cloudflare KV 与 Google Drive 后端已移除，云端旧数据仍在原服务上未动。请在下方配置 WebDAV 完成迁移。
                    </p>
                  </div>
                </CardContent>
              ) : null}
              <div className="titanium-panel-card">
                <ConnectionGuide />
              </div>
              <div className="titanium-panel-card">
                <WebdavSettings />
              </div>
              <div className="titanium-panel-card">
                <ConfigChannelSettings />
              </div>
            </div>
          ) : null}

          {section === 'automation' ? (
            <div className="titanium-stack">
              <div className="titanium-panel-card">
                <AutoSyncStatus />
              </div>
              <div className="titanium-panel-card">
                <SiteHealthSettings />
              </div>
              <div className="titanium-panel-card">
                <SafetyCard />
              </div>
            </div>
          ) : null}

          {section === 'sites' ? (
            <div className="titanium-panel-card">
              <SitePolicySettings />
            </div>
          ) : null}

          {section === 'about' ? (
            <div className="titanium-panel-card">
              <AboutSettings />
            </div>
          ) : null}
        </div>
      </div>

      <footer className="titanium-footer">
        <a href="https://github.com/Xioaruan912/CookieSync" target="_blank" rel="noreferrer">
          CookieSync 项目仓库 ↗
        </a>
        <span>
          原作者{' '}
          <a href="https://github.com/jackluson" target="_blank" rel="noreferrer">
            jackluson
          </a>
          {' · '}
          <a href="https://github.com/jackluson/sync-your-cookie" target="_blank" rel="noreferrer">
            原项目
          </a>
        </span>
      </footer>

      <Toaster position="top-center" richColors visibleToasts={1} toastOptions={{ duration: 2200 }} />
    </main>
  );
};

export default withErrorBoundary(withSuspense(Options, <div className="p-8 text-center">加载中…</div>), <div className="p-8 text-center">页面加载失败，请重新打开</div>);
