import { WebdavSettings } from './components/WebdavSettings';
import {
  useStorageSuspense,
  useTheme,
  verifyCloudflareToken,
  withErrorBoundary,
  withSuspense,
} from '@sync-your-cookie/shared';
import { accountStorage } from '@sync-your-cookie/storage/lib/accountStorage';
import { initStorageKey } from '@sync-your-cookie/storage/lib/settingsStorage';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  SyncTooltip,
  ThemeDropdown,
  Toaster,
} from '@sync-your-cookie/ui';
import { Eye, EyeOff, Info, Loader2, LogOut, SlidersVertical } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { SettingsPopover } from './components/SettingsPopover';
import { useGithub } from './hooks/useGithub';

const Options = () => {
  const accountInfo = useStorageSuspense(accountStorage);
  const [token, setToken] = useState(accountInfo.token);
  const [accountId, setAccountId] = useState(accountInfo.accountId);
  const [namespaceId, setNamespaceId] = useState(accountInfo.namespaceId);
  const [openEye, setOpenEye] = useState(false);
  const [providerTab, setProviderTab] = useState(accountInfo.selectedProvider === 'webdav' ? 'webdav' : 'legacy');
  const { loading, handleLaunchAuth } = useGithub();
  const [loadingSave, setLoadingSave] = useState(false);

  const { setTheme } = useTheme();

  const handleTokenInput: React.ChangeEventHandler<HTMLInputElement> = evt => {
    setToken(evt.target.value);
  };

  const handleAccountInput: React.ChangeEventHandler<HTMLInputElement> = evt => {
    setAccountId(evt.target.value);
  };

  const handleNamespaceInput: React.ChangeEventHandler<HTMLInputElement> = evt => {
    setNamespaceId(evt.target.value);
  };

  const handleSave = async () => {
    if (!accountId?.trim() || !token?.trim()) {
      toast.warning('请填写账号 ID 和令牌');
      return;
    } else if (!namespaceId?.trim()) {
      toast.warning('请填写命名空间 ID');
      return;
    }
    try {
      setLoadingSave(true);
      const res = await verifyCloudflareToken(accountId.trim(), token.trim());
      if (res.success === true) {
        const [message] = res.messages;
        if (message?.message) {
          toast.success('保存成功 (' + message.message.replace('API', '') + ')');
        } else {
          toast.success('保存成功');
        }
        accountStorage.update({
          selectedProvider: 'cloudflare',
          accountId: accountId,
          namespaceId: namespaceId,
          token: token,
        });
      } else {
        const [error] = res.errors;
        if (error?.message) {
          toast.error('验证失败：' + error.message);
        } else {
          toast.error('验证失败：未知错误');
        }
      }
    } catch (err: any) {
      const [error] = err?.errors || [];
      if (error?.message) {
        toast.error('验证失败：' + error.message);
      } else {
        toast.error('验证失败：未知错误');
      }
    } finally {
      setLoadingSave(false);
    }
  };

  const handleToggleEye = () => {
    setOpenEye(!openEye);
  };

  const handleLogout = () => {
    accountStorage.update({
      githubAccessToken: '',
      selectedProvider: 'cloudflare',
      name: '',
      avatarUrl: '',
      bio: '',
      email: '',
    });
    toast.success('已退出 GitHub');
    initStorageKey();
  };

  const renderAccount = () => {
    if (accountInfo.selectedProvider === 'github' && accountInfo.githubAccessToken) {
      return (
        <CardContent className="w-full">
          <div>
            <div className="flex relative items-center">
              <img className="size-12 rounded-full" src={accountInfo.avatarUrl} alt="" />
              <div className="flex  flex-col flex-1 ml-4">
                <SyncTooltip
                  title={
                    <div>
                      <p>
                        githubAccessToken: <span className="text-orange-500">已保存（隐藏）</span>
                      </p>
                      <p>原版 GitHub 凭据保存在 Chrome 同步存储中，请妥善保管。</p>
                    </div>
                  }>
                  <p className="text-base flex items-center font-medium">
                    <span className="mr-2">{accountInfo.name}</span>
                    <Info className="" size={16} />
                  </p>
                </SyncTooltip>
                <p className="text-xs">{accountInfo.email || accountInfo.bio}</p>
              </div>
            </div>
            <Button onClick={handleLogout} type="submit" variant="outline" className="w-full mt-4">
              <LogOut size={16} className="mr-2" />
              退出 GitHub
            </Button>
          </div>
        </CardContent>
      );
    }
    return (
      <>
        <CardContent>
          <CardDescription className="mt-[-16px] mb-4">配置 Cloudflare 账号或使用 GitHub Gist</CardDescription>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex justify-between items-center ">
                <Label htmlFor="token">授权令牌</Label>
                <p className="flex items-center text-center text-xs">
                  <a
                    href="https://github.com/jackluson/sync-your-cookie/blob/main/how-to-use.md"
                    target="_blank"
                    className=" cursor-pointer underline mx-2"
                    rel="noreferrer">
                    如何获取？
                  </a>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => handleToggleEye()}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        handleToggleEye();
                      }
                    }}
                    className="cursor-pointer">
                    {openEye ? <EyeOff size={18} /> : <Eye size={18} />}
                  </span>
                </p>
              </div>
              <Input
                id="token"
                value={token}
                onChange={handleTokenInput}
                className="w-full mb-2"
                type={openEye ? 'text' : 'password'}
                placeholder="请输入 Cloudflare 令牌"
                required
              />
            </div>
            <div className="grid gap-2">
              <div className="flex justify-between items-center ">
                <Label htmlFor="accountId">账号 ID</Label>
                <p className="flex items-center text-center text-xs">
                  还没有 Cloudflare 账号？
                  <a
                    href="https://dash.cloudflare.com/sign-up"
                    target="_blank"
                    className=" cursor-pointer underline ml-2"
                    rel="noreferrer">
                    注册
                  </a>
                </p>
              </div>
              <Input
                id="accountId"
                value={accountId}
                onChange={handleAccountInput}
                className="w-full mb-2"
                type="text"
                placeholder="请输入 Cloudflare 账号 ID"
                required
              />
            </div>
            <div className="grid gap-2">
              <div className="flex justify-between items-center ">
                <Label htmlFor="namespaceId">命名空间 ID</Label>
                {namespaceId?.trim() && accountId?.trim() ? (
                  <a
                    href={`https://dash.cloudflare.com/${accountId.trim()}/workers/kv/namespaces/${namespaceId.trim()}`}
                    target="_blank"
                    className=" cursor-pointer underline ml-2"
                    rel="noreferrer">
                    打开命名空间
                  </a>
                ) : null}

                {/* {namespaceId ? null : (
                      <div className="text-center ml-16 text-sm">
                        Don’t have an ID yet?
                        <span className=" cursor-pointer underline ml-2">Create</span>
                      </div>
                    )} */}
              </div>
              <Input
                id="namespaceId"
                value={namespaceId}
                onChange={handleNamespaceInput}
                className="w-full mb-4"
                type="text"
                placeholder="请输入命名空间 ID"
              />
            </div>
            <Button disabled={loadingSave} onClick={handleSave} type="submit" className="w-full">
              {loadingSave ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </CardContent>
        <div className="after:border-border relative text-center text-sm after:absolute after:inset-0 after:top-1/2 after:z-0 after:flex after:items-center after:border-t">
          <span className="bg-background text-muted-foreground relative z-10 px-2">或使用以下方式</span>
        </div>
        <CardContent>
          <Button disabled={loading} onClick={handleLaunchAuth} className="w-full mt-6" variant="outline" size="sm">
            <img
              src={chrome.runtime.getURL('popup/github.svg')}
              className="ml-1 h-4 w-4 overflow-hidden object-contain "
              alt="logo"
            />
            <span className="ml-2">使用 GitHub Gist</span>
          </Button>
        </CardContent>
      </>
    );
  };

  return (
    <div className="w-full min-h-screen flex flex-col items-center justify-start py-12 px-4 bg-background ">
      <div className="fixed right-8 top-8 ">
        <ThemeDropdown setTheme={setTheme} />
      </div>
      <div className="w-full flex justify-center flex-col items-center">
        <img
          src={chrome.runtime.getURL('options/logo.png')}
          className="size-16 overflow-hidden object-contain mb-4"
          alt="logo"
        />
        <div className="w-full">
          <Card className="mx-auto w-full max-w-lg">
            <CardHeader className="relative">
              <div className="flex justify-between">
                <CardTitle className="text-xl">设置</CardTitle>
              </div>
              <SettingsPopover
                trigger={
                  <Button variant="secondary" size="icon" className="size-6 absolute right-4 top-4">
                    <SlidersVertical size={18} />
                  </Button>
                }
              />
            </CardHeader>
            <div className="px-6 pb-4 flex gap-2">
              <Button
                variant={providerTab === 'webdav' ? 'default' : 'outline'}
                onClick={() => setProviderTab('webdav')}>
                WebDAV
              </Button>
              <Button
                variant={providerTab === 'legacy' ? 'default' : 'outline'}
                onClick={() => setProviderTab('legacy')}>
                Cloudflare / GitHub
              </Button>
            </div>
            <p className="px-6 pb-4 text-sm">
              当前后端：
              {accountInfo.selectedProvider === 'webdav'
                ? 'WebDAV'
                : accountInfo.selectedProvider === 'github'
                  ? 'GitHub Gist'
                  : 'Cloudflare KV'}
            </p>
            {providerTab === 'webdav' ? <WebdavSettings /> : renderAccount()}
          </Card>
        </div>
      </div>

      <div className="mt-2 text-sm">
        原作者：
        <a
          className="mx-0.5 font-bold text-primary "
          target="_blank"
          href="https://github.com/jackluson"
          rel="noreferrer">
          jackluson
        </a>
        。原项目源码：{' '}
        <a
          className="font-bold inline-flex items-center "
          href="https://github.com/jackluson/sync-your-cookie"
          target="_blank"
          rel="noopener noreferrer">
          GitHub
          <img
            src={chrome.runtime.getURL('popup/github.svg')}
            className="ml-1 h-4 w-4 overflow-hidden object-contain "
            alt="logo"
          />
        </a>
        .
      </div>

      <Toaster
        position="top-center"
        richColors
        visibleToasts={1}
        toastOptions={{
          duration: 2000,
        }}
      />
    </div>
  );
};

export default withErrorBoundary(withSuspense(Options, <div> 加载中… </div>), <div> 页面加载失败，请重新打开 </div>);
