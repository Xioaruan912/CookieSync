import { useStorageSuspense } from '@sync-your-cookie/shared';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { Cloud, HardDrive, Ban } from 'lucide-react';

const channels = [
  {
    key: 'chrome-sync',
    title: 'Chrome 账号同步',
    hint: '设置与网站名单随 Chrome 账号传递；WebDAV 应用密码需在下方主动开启后才会包含。',
    icon: Cloud,
  },
  {
    key: 'webdav',
    title: 'WebDAV 配置文件',
    hint: '在 Cookie 文件旁生成 CookieSync-config-v1.json，同步网站名单与偏好；不包含 WebDAV 凭据和加密密码。',
    icon: HardDrive,
  },
  {
    key: 'off',
    title: '关闭配置同步',
    hint: '名单与偏好仅保存在本机，每台电脑单独设置。',
    icon: Ban,
  },
] as const;

export function ConfigChannelSettings() {
  const settings = useStorageSuspense(settingsStorage);
  const webdav = useStorageSuspense(webdavStorage);
  const selected = settings.configChannel || 'chrome-sync';

  return (
    <div className="grid gap-2" aria-label="配置同步通道">
      <h3 className="font-medium leading-none">配置同步通道</h3>
      <p className="text-sm text-muted-foreground">
        Cookie 与 LocalStorage 始终只走 WebDAV；这里选择网站名单、同步偏好等配置如何传递。
      </p>
      <div className="grid gap-2" role="radiogroup" aria-label="选择配置同步通道">
        {channels.map(channel => {
          const active = selected === channel.key;
          const Icon = channel.icon;
          return (
            <label
              key={channel.key}
              className="config-channel"
              data-active={active || undefined}>
              <input
                type="radio"
                name="config-channel"
                value={channel.key}
                checked={active}
                onChange={() => void settingsStorage.update({ configChannel: channel.key })}
              />
              <span className="config-channel-main">
                <Icon size={16} aria-hidden="true" />
                <span className="config-channel-title">{channel.title}</span>
              </span>
              <span className="config-channel-hint">
                {channel.key === 'webdav' && !webdav.url ? '需要先保存 WebDAV 连接后生效。' : channel.hint}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
