import { automaticStatusStorage } from '@sync-your-cookie/storage/lib/automaticStatusStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import {
  extractDomainAndPort,
  syncCookieDomain,
  useStorageSuspense,
  useTheme,
  withErrorBoundary,
  withSuspense,
} from '@sync-your-cookie/shared';

import { Button, Image, Spinner, Toaster } from '@sync-your-cookie/ui';
import { CloudDownload, CloudUpload, Copyright, PanelRightOpen, RotateCw, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';

import { AutoSwitch } from './components/AutoSwtich';
import { useDomainConfig } from './hooks/useDomainConfig';

const Popup = () => {
  const { theme } = useTheme();
  const automaticStatus = useStorageSuspense(automaticStatusStorage);
  const [activeTabUrl, setActiveTabUrl] = useState('');
  const [favIconUrl, setFavIconUrl] = useState('');

  const {
    pushing,
    toggleAutoPushState,
    toggleAutoPullState,
    domain,
    setDomain,
    domainItemConfig,
    domainItemStatus,
    handlePush,
    handlePull,
  } = useDomainConfig();

  useEffect(() => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, async function (tabs) {
      if (tabs.length > 0) {
        const activeTab = tabs[0];
        if (activeTab.url && activeTab.url.startsWith('http')) {
          setFavIconUrl(activeTab?.favIconUrl || '');
          setActiveTabUrl(activeTab.url);
          const [domain, tempPort] = await extractDomainAndPort(activeTab.url);
          setDomain(domain + `${tempPort ? ':' + tempPort : ''}`);
        }
      }
    });
  }, []);

  const isPushingOrPulling = domainItemStatus.pushing || domainItemStatus.pulling;

  const handleAndReload = () => {
    handlePull(activeTabUrl, domain, true);
  };

  return (
    <div className="flex flex-col items-center min-w-[400px] justify-center bg-background ">
      <header className=" p-2 flex w-full justify-between items-center bg-card/50 shadow-md border-b border-border ">
        <div className="flex items-center">
          <img
            src={chrome.runtime.getURL('options/logo.png')}
            className="h-10 w-10 overflow-hidden object-contain "
            alt="logo"
          />
          <h2 className="text-base text-foreground	font-bold">SyncYourCookie</h2>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            chrome.runtime.openOptionsPage();
          }}
          className="cursor-pointer text-sm mr-[-8px] ">
          <Settings size={20} />
        </Button>
      </header>
      <main className="p-4 ">
        <Spinner show={false}>
          {domain ? (
            <div className="flex justify-center items-center mb-2  ">
              <Image src={favIconUrl} />
              <h3 className="text-center whitespace-nowrap text-xl text-primary font-bold">{domain}</h3>
            </div>
          ) : null}

          {['xiaohongshu.com', 'douyin.com', '115.com'].includes(syncCookieDomain(domain)) ? (
            <div className="mb-4 max-w-[350px] text-xs space-y-2">
              <p>已启用主域及子域 Cookie 同步。建议一台发送、一台接收，减少旧登录覆盖。</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPushingOrPulling}
                  onClick={() => domainConfigStorage.updateItem(domain, { autoPush: true, autoPull: false })}>
                  此电脑主要发送
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPushingOrPulling}
                  onClick={() => domainConfigStorage.updateItem(domain, { autoPush: false, autoPull: true })}>
                  此电脑主要接收
                </Button>
              </div>
              <p>首次先手动推送／拉取；之后默认自动收发，可按角色调整。过期或被撤销的登录仍需验证。</p>
            </div>
          ) : null}
          <div className=" flex flex-col">
            {/* <Button title={cloudflareAccountId} className="mb-2" onClick={handleUpdateToken}>
            Update Token
          </Button> */}
            <div className="flex items-center mb-2 ">
              <Button
                disabled={!activeTabUrl || isPushingOrPulling || pushing}
                className=" mr-2 w-[160px] justify-start"
                onClick={() => handlePush(domain, activeTabUrl, favIconUrl)}>
                {domainItemStatus.pushing ? (
                  <RotateCw size={16} className="mr-2 animate-spin" />
                ) : (
                  <CloudUpload size={16} className="mr-2" />
                )}
                推送并合并 Cookie
              </Button>
              <AutoSwitch
                disabled={!activeTabUrl}
                onChange={() => toggleAutoPushState(domain)}
                id="autoPush"
                value={!!domainItemConfig.autoPush}
              />
            </div>

            <div className="flex items-center mb-2 ">
              <Button
                disabled={!activeTabUrl || isPushingOrPulling}
                className=" w-[160px] mr-2 justify-start"
                onClick={() => handleAndReload()}>
                {domainItemStatus?.pulling ? (
                  <RotateCw size={16} className="mr-2 animate-spin" />
                ) : (
                  <CloudDownload size={16} className="mr-2" />
                )}
                拉取并应用 Cookie
              </Button>

              <AutoSwitch
                disabled={!activeTabUrl}
                onChange={() => toggleAutoPullState(domain)}
                id="autoPull"
                value={!!domainItemConfig.autoPull}
              />
            </div>

            <Button
              className="mb-2 justify-start"
              onClick={async () => {
                chrome.windows.getCurrent(async currentWindow => {
                  // const res = await chrome.sidePanel.getOptions({
                  //   tabId: currentWindow.id,
                  // });
                  chrome.sidePanel
                    .open({ windowId: currentWindow.id! })
                    .then(() => {})
                    .catch(error => {});
                });
              }}>
              <PanelRightOpen size={16} className="mr-2" />
              打开同步管理
            </Button>
          </div>
          <p className="mt-3 max-w-[350px] text-xs text-muted-foreground">
            {automaticStatus.error
              ? `后台同步待重试：${automaticStatus.error}`
              : automaticStatus.lastSuccess
                ? `最近后台同步：${new Date(automaticStatus.lastSuccess).toLocaleString('zh-CN')}`
                : '首次推送后启用无感同步；浏览器启动自动拉取，运行期间后台保存。'}
          </p>
          <Toaster
            theme={theme}
            closeButton
            toastOptions={{
              duration: 1500,
              style: {
                // width: 'max-content',
                // margin: '0 auto',
              },
              // className: 'w-[240px]',
            }}
            visibleToasts={1}
            richColors
            position="top-center"
          />
        </Spinner>
      </main>
      <footer className="w-full text-center justify-center p-4 flex items-center border-t border-border/90 ">
        <span>
          <Copyright size={16} />
        </span>
        <a
          className=" inline-flex items-center mx-1 text-sm underline "
          href="https://github.com/jackluson"
          target="_blank"
          rel="noopener noreferrer">
          jackluson
        </a>
        <a href="https://github.com/jackluson/sync-your-cookie" target="_blank" rel="noopener noreferrer">
          <img
            src={chrome.runtime.getURL('popup/github.svg')}
            className="h-4 w-4 overflow-hidden object-contain "
            alt="logo"
          />
        </a>
      </footer>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Popup, <div> 加载中… </div>), <div> 页面加载失败，请重新打开 </div>);
