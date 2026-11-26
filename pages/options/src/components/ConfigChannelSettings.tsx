import { useStorageSuspense } from '@sync-your-cookie/shared';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';

const channels = [
  {
    key: 'chrome-sync',
    title: 'Chrome 账号',
    hint: '网站名单与同步偏好随 Chrome 账号跨机传递，不含 WebDAV 密码。',
  },
  {
    key: 'webdav',
    title: 'WebDAV 文件',
    hint: '在 Cookie 文件旁生成 CookieSync-config-v1.json 同步名单与偏好，不含凭据与加密密码。',
  },
  {
    key: 'off',
    title: '仅本机',
    hint: '网站名单与偏好仅保留在当前电脑，互不影响。',
  },
] as const;

export function ConfigChannelSettings() {
  const settings = useStorageSuspense(settingsStorage);
  const webdav = useStorageSuspense(webdavStorage);
  const selected = settings.configChannel || 'chrome-sync';
  const current = channels.find(item => item.key === selected) || channels[0];

  return (
    <>
      <div className="sbo-channel-group" role="radiogroup" aria-label="选择配置同步通道">
        {channels.map(channel => {
          const active = selected === channel.key;
          return (
            <label key={channel.key} className="sbo-channel-pill" data-active={active || undefined}>
              <input
                type="radio"
                name="config-channel"
                value={channel.key}
                checked={active}
                onChange={() => void settingsStorage.update({ configChannel: channel.key })}
              />
              <span>{channel.title}</span>
            </label>
          );
        })}
      </div>

      <p className="sbo-channel-caption">
        {current.key === 'webdav' && !webdav.url ? '需先保存上方 WebDAV 连接后生效。' : current.hint}
      </p>
    </>
  );
}
