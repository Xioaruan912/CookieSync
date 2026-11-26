import { useLocale, useTheme, withErrorBoundary, withSuspense } from '@sync-your-cookie/shared';
import { Button, ThemeDropdown, Toaster } from '@sync-your-cookie/ui';
import { Activity, Cable, Globe2, Info, Languages, LayoutDashboard, Puzzle, SlidersVertical } from 'lucide-react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { AboutSettings } from './components/AboutSettings';
import { AutoSyncStatus } from './components/AutoSyncStatus';
import { OverviewPanel } from './components/OverviewPanel';
import { SettingsPopover } from './components/SettingsPopover';
import { SiteHealthSettings } from './components/SiteHealthSettings';
import { SitePolicySettings } from './components/SitePolicySettings';
import { WebdavSettings } from './components/WebdavSettings';

const sections = {
  overview: { label: '总览', enLabel: 'Overview', icon: LayoutDashboard },
  connection: { label: '同步连接', enLabel: 'Connection', icon: Cable },
  automation: { label: '自动', enLabel: 'Automation', icon: Activity },
  adaptations: { label: '适配', enLabel: 'Adaptations', icon: Puzzle },
  sites: { label: '网站名单', enLabel: 'Sites', icon: Globe2 },
  about: { label: '关于', enLabel: 'About', icon: Info },
} as const;

type SectionKey = keyof typeof sections;

const currentSection = (): SectionKey => {
  const key = window.location.hash.slice(1) as SectionKey;
  return Object.prototype.hasOwnProperty.call(sections, key) ? key : 'overview';
};

const Options = () => {
  const [section, setSection] = useState<SectionKey>(currentSection);
  const { theme, setTheme } = useTheme();
  const { isEn, t, toggleLanguage } = useLocale();

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

          <nav className="titanium-segmented" aria-label={t('设置导航', 'Settings navigation')}>
            {(Object.keys(sections) as SectionKey[]).map(key => {
              const { label, enLabel, icon: Icon } = sections[key];
              return (
                <a key={key} href={`#${key}`} aria-current={section === key ? 'page' : undefined}>
                  <Icon size={16} aria-hidden="true" />
                  {isEn ? enLabel : label}
                </a>
              );
            })}
          </nav>

          <div className="titanium-header-right">
            <SettingsPopover
              trigger={
                <Button variant="outline" size="sm" className="rounded-full">
                  <SlidersVertical size={15} className="mr-1.5" aria-hidden="true" />
                  {t('高级设置', 'Advanced')}
                </Button>
              }
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full px-2.5 text-xs font-medium"
              onClick={() => void toggleLanguage()}
              aria-label={t('切换到英文', 'Switch to Chinese')}
              title={t('切换语言 / Switch Language', 'Switch Language / 切换语言')}>
              <Languages size={14} className="mr-1" aria-hidden="true" />
              {isEn ? '中文' : 'EN'}
            </Button>
            <ThemeDropdown setTheme={setTheme} />
          </div>
        </div>
      </header>

      <main className="titanium-container titanium-workspace" aria-labelledby="settings-title">
        {section === 'overview' ? <OverviewPanel /> : null}

        {section === 'connection' ? <WebdavSettings /> : null}

        {section === 'automation' ? <AutoSyncStatus /> : null}

        {section === 'adaptations' ? <SiteHealthSettings /> : null}

        {section === 'sites' ? <SitePolicySettings /> : null}

        {section === 'about' ? <AboutSettings /> : null}
      </main>
      <Toaster theme={theme} position="top-center" richColors visibleToasts={1} toastOptions={{ duration: 2200 }} />
    </div>
  );
};

export default withErrorBoundary(
  withSuspense(Options, <div className="p-8 text-center">加载中…</div>),
  <div className="p-8 text-center">页面加载失败，请重新打开</div>,
);
