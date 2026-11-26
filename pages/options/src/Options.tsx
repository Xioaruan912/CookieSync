import { useTheme, withErrorBoundary, withSuspense } from '@sync-your-cookie/shared';
import { Button, ThemeDropdown, Toaster } from '@sync-your-cookie/ui';
import { Activity, Cable, Globe2, Info, LayoutDashboard, Puzzle, SlidersVertical } from 'lucide-react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { AboutSettings } from './components/AboutSettings';
import { AutoSyncStatus } from './components/AutoSyncStatus';
import { OverviewPanel } from './components/OverviewPanel';
import { SettingsPopover } from './components/SettingsPopover';
import { SiteHealthSettings } from './components/SiteHealthSettings';
import { SitePolicySettings } from './components/SitePolicySettings';
import { WebdavSettings } from './components/WebdavSettings';

const sections = {
  overview: { label: '总览', title: '同步总览', icon: LayoutDashboard },
  connection: { label: '同步连接', title: '同步连接', icon: Cable },
  automation: { label: '自动', title: '自动同步', icon: Activity },
  adaptations: { label: '适配', title: '网站适配', icon: Puzzle },
  sites: { label: '网站名单', title: '网站名单', icon: Globe2 },
  about: { label: '关于', title: '关于与更新', icon: Info },
} as const;

type SectionKey = keyof typeof sections;

const currentSection = (): SectionKey => {
  const key = window.location.hash.slice(1) as SectionKey;
  return Object.prototype.hasOwnProperty.call(sections, key) ? key : 'overview';
};

const Options = () => {
  const [section, setSection] = useState<SectionKey>(currentSection);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    const onHashChange = () => setSection(currentSection());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [section]);

  return (
    <div className="titanium-shell" data-section={section}>
      <header className="titanium-header">
        <div className="titanium-header-inner">
          <a href="#overview" className="titanium-brand">
            <img src={chrome.runtime.getURL('options/logo.png')} className="size-7 rounded-lg" alt="" />
            <strong>CookieSync</strong>
          </a>

          <nav className="titanium-segmented" aria-label="设置导航">
            {(Object.keys(sections) as SectionKey[]).map(key => {
              const { label, icon: Icon } = sections[key];
              return (
                <a key={key} href={`#${key}`} aria-current={section === key ? 'page' : undefined}>
                  <Icon size={16} aria-hidden="true" />
                  {label}
                </a>
              );
            })}
          </nav>

          <div className="titanium-header-right">
            <SettingsPopover
              trigger={
                <Button variant="outline" size="sm" className="rounded-full">
                  <SlidersVertical size={15} className="mr-1.5" aria-hidden="true" />
                  高级设置
                </Button>
              }
            />
            <ThemeDropdown setTheme={setTheme} />
          </div>
        </div>
      </header>

      <main className="titanium-container titanium-workspace" aria-labelledby="settings-title">
        {section !== 'automation' && section !== 'connection' && (
          <h1 id="settings-title" className="workspace-title">
            {sections[section].title}
          </h1>
        )}
        {section === 'overview' ? <OverviewPanel /> : null}

        {section === 'connection' ? <WebdavSettings /> : null}

        {section === 'automation' ? <AutoSyncStatus /> : null}

        {section === 'adaptations' ? <SiteHealthSettings /> : null}

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
      </main>

      {section === 'about' ? (
        <footer className="titanium-footer">
          <a href="https://github.com/Xioaruan912/CookieSync" target="_blank" rel="noreferrer">
            项目仓库
          </a>
          <a href="https://github.com/jackluson/sync-your-cookie" target="_blank" rel="noreferrer">
            原项目 · jackluson
          </a>
        </footer>
      ) : null}
      <Toaster theme={theme} position="top-center" richColors visibleToasts={1} toastOptions={{ duration: 2200 }} />
    </div>
  );
};

export default withErrorBoundary(
  withSuspense(Options, <div className="p-8 text-center">加载中…</div>),
  <div className="p-8 text-center">页面加载失败，请重新打开</div>,
);
