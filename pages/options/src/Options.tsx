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
const sectionEyebrows = {
  connection: '连接与传输',
  automation: '同步行为',
  sites: '自动同步范围',
  about: '版本与发布',
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
  const version = chrome.runtime.getManifest().version;

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <div className="settings-brand">
          <img src={chrome.runtime.getURL('options/logo.png')} className="size-8 object-contain" alt="" />
          <div>
            <strong>CookieSync</strong>
            <small>登录状态同步</small>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="version-chip" title="当前版本">
            v{version}
          </span>
          <SettingsPopover
            trigger={
              <Button variant="outline" size="sm">
                <SlidersVertical size={15} className="mr-1.5" />
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
                  <Icon size={16} aria-hidden="true" />
                  <span>{sections[key]}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </a>
              );
            })}
          </nav>
        </aside>
        <div className="settings-content">
          <section hidden={section !== 'connection'} aria-label={sections.connection}>
            <p className="section-eyebrow">{sectionEyebrows.connection}</p>
            <h2 className="section-title">同步连接</h2>
            <p className="section-lede">
              Cookie 与 LocalStorage 只通过 WebDAV 传输；配置可随 Chrome 账号或 WebDAV 配置文件传递，凭据始终不进入配置快照。
            </p>
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
            <p className="section-eyebrow">{sectionEyebrows.automation}</p>
            <h2 className="section-title">自动同步</h2>
            <p className="section-lede">
              两端自动比对，单端变化自动收发；同时变化时采用较新一侧。站点会话状态由只读接口验证，不在同步轮询中打扰站点。
            </p>
            <AutoSyncStatus />
            <CardContent className="pt-6">
              <SiteHealthSettings />
            </CardContent>
          </section>
          <section hidden={section !== 'sites'} aria-label={sections.sites}>
            <p className="section-eyebrow">{sectionEyebrows.sites}</p>
            <h2 className="section-title">网站名单</h2>
            <CardContent className="pt-6">
              <SitePolicySettings />
            </CardContent>
          </section>
          <section hidden={section !== 'about'} aria-label={sections.about}>
            <p className="section-eyebrow">{sectionEyebrows.about}</p>
            <h2 className="section-title">关于与更新</h2>
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
