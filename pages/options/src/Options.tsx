import { SitePolicySettings } from './components/SitePolicySettings';
import { WebdavSettings } from './components/WebdavSettings';
import { ConfigChannelSettings } from './components/ConfigChannelSettings';
import { AutoSyncStatus } from './components/AutoSyncStatus';
import { SiteHealthSettings } from './components/SiteHealthSettings';
import { AboutSettings } from './components/AboutSettings';
import { useStorageSuspense, useTheme, withErrorBoundary, withSuspense } from '@sync-your-cookie/shared';
import { accountStorage, isLegacyProvider } from '@sync-your-cookie/storage/lib/accountStorage';
import { Button, CardContent, ThemeDropdown, Toaster } from '@sync-your-cookie/ui';
import { Activity, Cable, ChevronRight, Globe2, Info, SlidersVertical, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SettingsPopover } from './components/SettingsPopover';

const sections = {
  connection: '同步连接',
  automation: '自动同步',
  sites: '网站名单',
  about: '关于与更新',
} as const;
const sectionIcons = { connection: Cable, automation: Activity, sites: Globe2, about: Info };
const currentSection = () => {
  const key = window.location.hash.slice(1);
  return Object.keys(sections).includes(key) ? key : 'connection';
};

const Options = () => {
  const [section, setSection] = useState(currentSection);
  useEffect(() => {
    const navigate = () => {
      setSection(currentSection());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  const accountInfo = useStorageSuspense(accountStorage);

  const { setTheme } = useTheme();

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <div className="flex items-center gap-3">
          <img src={chrome.runtime.getURL('options/logo.png')} className="size-9 object-contain" alt="" />
          <strong className="text-lg tracking-tight">CookieSync</strong>
        </div>
        <div className="flex items-center gap-2">
          <SettingsPopover
            trigger={
              <Button variant="outline" size="sm">
                <SlidersVertical size={16} className="mr-1.5" />
                高级设置
              </Button>
            }
          />
          <ThemeDropdown setTheme={setTheme} />
        </div>
      </header>
      <div className="settings-layout">
        <aside className="settings-navigation">
          <h1>同步设置</h1>
          <nav aria-label="设置导航">
            {(Object.keys(sections) as (keyof typeof sections)[]).map(key => {
              const Icon = sectionIcons[key];
              return (
                <a key={key} href={'#' + key} aria-current={section === key ? 'page' : undefined}>
                  <Icon size={18} aria-hidden="true" />
                  <span>{sections[key]}</span>
                  <ChevronRight size={15} aria-hidden="true" />
                </a>
              );
            })}
          </nav>
        </aside>
        <div className="settings-content">
          <section hidden={section !== 'connection'} aria-label={sections.connection}>
            <h2 className="section-title">同步连接</h2>
            {isLegacyProvider(accountInfo) ? (
              <CardContent className="legacy-migration" role="alert">
                <TriangleAlert size={18} aria-hidden="true" />
                <div>
                  <p className="font-medium">检测到旧版同步后端</p>
                  <p className="text-muted-foreground">
                    GitHub Gist、Cloudflare KV 与 Google Drive 的 Cookie 存储已在本版本移除，云端旧数据仍在原服务上未动。
                    请在下方配置 WebDAV 并手动推送／拉取一次完成迁移。
                  </p>
                </div>
              </CardContent>
            ) : null}
            <WebdavSettings />
            <CardContent className="pt-6">
              <ConfigChannelSettings />
            </CardContent>
          </section>
          <section hidden={section !== 'automation'} aria-label={sections.automation}>
            <h2 className="section-title">自动同步</h2>
            <AutoSyncStatus />
            <CardContent className="pt-6">
              <SiteHealthSettings />
            </CardContent>
          </section>
          <section hidden={section !== 'sites'} aria-label={sections.sites}>
            <CardContent className="pt-6">
              <SitePolicySettings />
            </CardContent>
          </section>
          <section hidden={section !== 'about'} aria-label={sections.about}>
            <AboutSettings />
          </section>
        </div>
      </div>

      <footer className="settings-footer">
        <a href="https://github.com/Xioaruan912/CookieSync" target="_blank" rel="noreferrer">CookieSync 项目仓库 ↗</a>
        <span>原作者 <a href="https://github.com/jackluson" target="_blank" rel="noreferrer">jackluson</a>
          {' · '}<a href="https://github.com/jackluson/sync-your-cookie" target="_blank" rel="noreferrer">原项目</a>
        </span>
      </footer>

      <Toaster
        position="top-center"
        richColors
        visibleToasts={1}
        toastOptions={{
          duration: 2000,
        }}
      />
    </main>
  );
};

export default withErrorBoundary(withSuspense(Options, <div> 加载中… </div>), <div> 页面加载失败，请重新打开 </div>);
