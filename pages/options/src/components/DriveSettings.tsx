import { connectDrive, disconnectDrive, isDriveConfigured, useStorageSuspense } from '@sync-your-cookie/shared';
import { accountStorage } from '@sync-your-cookie/storage/lib/accountStorage';
import { driveAccountStorage } from '@sync-your-cookie/storage/lib/driveStorage';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { Button, CardContent } from '@sync-your-cookie/ui';
import { useState } from 'react';
import { toast } from 'sonner';

export function DriveSettings() {
  const profile = useStorageSuspense(driveAccountStorage);
  const [busy, setBusy] = useState(false);
  const configured = isDriveConfigured();
  const run = async (disconnect = false) => {
    setBusy(true);
    try {
      if (disconnect) await disconnectDrive();
      else {
        await connectDrive();
        await cookieStorage.reset();
        await accountStorage.update({ selectedProvider: 'google-drive' });
      }
      toast.success(disconnect ? '已断开 Google Drive，云端文件保留' : '已连接 Google Drive，自动同步已就绪');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Google Drive 连接失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <CardContent className="grid gap-4">
      <p className="text-sm">
        使用 Google 账号同步到自己的云端硬盘。仅访问 CookieSync 的隐藏应用数据目录，不能读取其他云盘文件。
      </p>
      {!configured && (
        <p role="status" className="text-sm">
          此安装包尚未由维护者开通 Google 登录。请暂用 WebDAV；开通后的安装包只需点击登录，无需填写客户端 ID。
        </p>
      )}
      {profile.connected && <p className="text-sm">已连接：{profile.email || 'Google 账号'}</p>}
      <Button disabled={busy || !configured} onClick={() => run()}>
        {busy ? '处理中…' : profile.connected ? '重新连接并使用 Google Drive' : '使用 Google 登录'}
      </Button>
      {profile.connected && (
        <Button variant="outline" disabled={busy} onClick={() => run(true)}>
          断开 Google Drive
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        首次授权由你点击发起，之后后台静默获取和更新令牌；授权撤销或 Google
        要求重新验证时，会提示重新连接。每台电脑首次连接一次，并使用同一 Google
        账号。建议开启数据加密；断开连接不会删除云端文件。
      </p>
    </CardContent>
  );
}
