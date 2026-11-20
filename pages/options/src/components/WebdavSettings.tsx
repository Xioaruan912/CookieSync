import { buildWebdavUrl, testWebdavConnection, useStorageSuspense } from '@sync-your-cookie/shared';
import { accountStorage } from '@sync-your-cookie/storage/lib/accountStorage';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { webdavStorage, webdavCloudStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { Button, CardContent, Input, Label } from '@sync-your-cookie/ui';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

export function WebdavSettings() {
  const saved = useStorageSuspense(webdavStorage);
  const cloud = useStorageSuspense(webdavCloudStorage);
  const [syncConfig, setSyncConfig] = useState(cloud.enabled);
  const [config, setConfig] = useState(saved);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) {
      setConfig(saved);
      setSyncConfig(cloud.enabled);
    }
  }, [saved, cloud.enabled, dirty]);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const update = (key: keyof typeof config, value: string) => {
    setDirty(true);
    setConfig(current => ({ ...current, [key]: value }));
  };

  const run = async (save: boolean) => {
    setBusy(true);
    try {
      const normalized = {
        ...config,
        url: config.url.trim(),
        username: config.username.trim(),
        path: config.path.trim(),
      };
      buildWebdavUrl(normalized);
      if (save) {
        await webdavStorage.update(normalized, syncConfig);
        setDirty(false);
        await cookieStorage.reset();
        await accountStorage.update({ selectedProvider: 'webdav' });
        await chrome.storage.local.set({ 'cookiesync-webdav-probe-ok': Date.now() });
        toast.success('WebDAV 配置已保存');
      } else {
        await testWebdavConnection(normalized);
        await chrome.storage.local.set({ 'cookiesync-webdav-probe-ok': Date.now() });
        toast.success('连接测试成功：已验证临时文件的创建、覆盖、读取和删除');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'WebDAV 操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <CardContent className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Cookie 与 LocalStorage 仅通过 WebDAV 同步。填写 WebDAV 目录的最终 HTTPS 地址，远程路径相对于此目录，父目录需提前创建。
      </p>
      <div className="grid gap-2">
        <Label htmlFor="webdav-url">WebDAV URL</Label>
        <Input
          id="webdav-url"
          type="url"
          value={config.url}
          onChange={e => update('url', e.target.value)}
          placeholder="https://dav.example.com/remote.php/dav/files/user/"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="webdav-username">用户名</Label>
        <Input
          id="webdav-username"
          autoComplete="off"
          value={config.username}
          onChange={e => update('username', e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="webdav-password">密码／应用密码</Label>
        <Input
          id="webdav-password"
          type={showPassword ? 'text' : 'password'}
          autoComplete="off"
          value={config.password}
          onChange={e => update('password', e.target.value)}
        />
        <label className="text-sm flex gap-2 items-center">
          <input type="checkbox" checked={showPassword} onChange={e => setShowPassword(e.target.checked)} />
          显示密码
        </label>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="webdav-path">远程文件路径</Label>
        <Input
          id="webdav-path"
          value={config.path}
          onChange={e => update('path', e.target.value)}
          placeholder="CookieSync/cookies.txt"
        />
        <p className="text-xs text-muted-foreground">两台电脑填写相同路径；配置文件会生成在同目录下。</p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void run(false)}>
          测试连接
        </Button>
        <Button disabled={busy} onClick={() => void run(true)}>
          {busy ? '处理中…' : '保存并使用 WebDAV'}
        </Button>
      </div>
      <label className="text-xs flex gap-2 items-start">
        <input
          type="checkbox"
          checked={syncConfig}
          onChange={e => {
            setDirty(true);
            setSyncConfig(e.target.checked);
          }}
        />
        使用 Chrome / Google 账号同步此 WebDAV 配置（包含应用密码）。两台电脑需登录同一 Chrome
        账号并开启同步；此配置不会额外加密，不同步 Cookie 内容。
      </label>
      <label className="text-xs flex gap-2 items-start">
        <input
          type="checkbox"
          checked={!!config.allowUnsafeWrites}
          onChange={e => {
            setDirty(true);
            setConfig(current => ({ ...current, allowUnsafeWrites: e.target.checked }));
          }}
        />
        AList / OpenList 等网关兼容模式（停用条件写入；上传前检查内容，但无法防止并发覆盖，请勿两台电脑同时推送）
      </label>
      <p className="text-xs text-muted-foreground">
        未开启配置同步时，凭据仅保存在本机。关闭后会移除云端配置记录，保留各电脑已保存的本机副本。Cookie
        可代表登录身份，请使用私人目录和专用应用密码；建议在高级设置开启 Protobuf
        与端到端加密，并在两台电脑设置相同的加密密码。
      </p>
    </CardContent>
  );
}
