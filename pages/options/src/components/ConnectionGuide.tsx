import { useStorageSuspense } from '@sync-your-cookie/shared';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { siteActivityStorage } from '@sync-your-cookie/storage/lib/siteActivityStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { CardContent } from '@sync-your-cookie/ui';
import { Check } from 'lucide-react';
import { useEffect, useState } from 'react';

const probeKey = 'cookiesync-webdav-probe-ok';

/**
 * Three concrete steps instead of a wall of settings. The guide disappears once
 * all three are done, so it never becomes permanent furniture.
 */
export function ConnectionGuide() {
  const saved = useStorageSuspense(webdavStorage);
  const activity = useStorageSuspense(siteActivityStorage);
  const cookies = useStorageSuspense(cookieStorage);
  const [probeAt, setProbeAt] = useState(0);

  useEffect(() => {
    const read = () => {
      void chrome.storage.local
        .get(probeKey)
        .then(value => setProbeAt(Number(value[probeKey]) || 0))
        .catch(() => {});
    };
    read();
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[probeKey]) read();
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, []);

  const filled = !!saved.url.trim() && !!saved.username.trim() && !!saved.password;
  const pushed =
    Object.values(activity).some(entry => entry.lastPushAt) ||
    Object.keys(cookies.domainCookieMap || {}).length > 0;
  // Existing installs predate the probe marker; synced data already proves the
  // destination works, so the guide retires instead of nagging them.
  const tested = probeAt > 0 || pushed;
  if (filled && tested && pushed) return null;

  const steps = [
    {
      title: '填写地址、账号与应用密码',
      done: filled,
      hint: filled ? '配置已保存在本机' : '在下方表单填写，父目录需提前创建。',
    },
    {
      title: '测试连接',
      done: tested,
      hint: tested
        ? `上次验证成功：${new Date(probeAt).toLocaleString('zh-CN')}`
        : '点下方「测试连接」，验证创建、覆盖、读取和删除权限。',
    },
    {
      title: '推送第一个网站',
      done: pushed,
      hint: pushed
        ? '已开始同步'
        : '打开已登录的网站，点扩展图标并选择「推送到云端」；另一台电脑随后拉取即可。',
    },
  ];

  return (
    <CardContent className="connection-guide" aria-label="首次配置引导">
      <p className="section-eyebrow">首次配置</p>
      <h3>三步完成连接</h3>
      <p className="text-muted-foreground text-sm">
        不需要注册账号：一个 WebDAV 目录同时充当传输通道和冲突保护。完成后，两端自动收发。
      </p>
      <ol>
        {steps.map((step, index) => (
          <li key={step.title} data-done={step.done}>
            <span className="connection-step-index" aria-hidden="true">
              {step.done ? <Check size={13} /> : index + 1}
            </span>
            <div>
              <strong>{step.title}</strong>
              <p>{step.hint}</p>
            </div>
          </li>
        ))}
      </ol>
    </CardContent>
  );
}
