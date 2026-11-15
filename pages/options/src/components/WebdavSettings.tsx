import { buildWebdavUrl, testWebdavConnection, useStorageSuspense } from '@sync-your-cookie/shared';
import { accountStorage } from '@sync-your-cookie/storage/lib/accountStorage';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { Button, CardContent, Input, Label } from '@sync-your-cookie/ui';
import { useState } from 'react';
import { toast } from 'sonner';

export function WebdavSettings() {
  const saved = useStorageSuspense(webdavStorage);
  const [config, setConfig] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const update = (key: keyof typeof config, value: string) => setConfig(current => ({ ...current, [key]: value }));

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
        await webdavStorage.update(normalized);
        await cookieStorage.reset();
        await accountStorage.update({ selectedProvider: 'webdav' });
        toast.success('WebDAV 配置已保存，已切换同步后端');
      } else {
        await testWebdavConnection(normalized);
        toast.success('连接测试成功：已验证临时文件的写入、读取和删除');
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
        填写 WebDAV 目录的最终 HTTPS 地址。远程路径相对于此目录，父目录需提前创建。
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
        <p className="text-xs text-muted-foreground">两台电脑填写相同路径；此路径独立于高级设置中的存储键。</p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" disabled={busy} onClick={() => run(false)}>
          测试连接
        </Button>
        <Button disabled={busy} onClick={() => run(true)}>
          {busy ? '处理中…' : '保存并使用 WebDAV'}
        </Button>
      </div>
      <label className="text-xs flex gap-2 items-start">
        <input
          type="checkbox"
          checked={!!config.allowUnsafeWrites}
          onChange={e => setConfig(current => ({ ...current, allowUnsafeWrites: e.target.checked }))}
        />
        允许无强 ETag 的服务器覆盖写入（兼容模式，可能丢失另一台电脑的数据，请勿同时推送）
      </label>
      <p className="text-xs text-muted-foreground">
        凭据仅保存在本机扩展存储。Cookie 可代表登录身份，请使用私人目录和专用应用密码；建议在高级设置开启 Protobuf
        与端到端加密，并在两台电脑设置相同的加密密码。
      </p>
    </CardContent>
  );
}
