import { useStorageSuspense } from '@sync-your-cookie/shared';
import { commonSites, isSiteAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { sitePolicyStorage } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { driveAccountStorage } from '@sync-your-cookie/storage/lib/driveStorage';
import { Button, Input } from '@sync-your-cookie/ui';
import { useState, useSyncExternalStore } from 'react';

export function SitePolicySettings() {
  const rules = useSyncExternalStore(sitePolicyStorage.subscribe, sitePolicyStorage.getSnapshot) || {};
  const config = useStorageSuspense(domainConfigStorage);
  const drive = useStorageSuspense(driveAccountStorage);
  const [search, setSearch] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pendingRule, setPendingRule] = useState<{ host: string; enabled: boolean }>();
  const builtin = new Set(commonSites.map(site => site.domain));
  const custom = Object.keys(rules).filter(host => !builtin.has(host));
  const paused = Object.keys(config.domainMap).filter(host => !isSiteAllowed(host, rules));
  const filtered = commonSites.filter(site =>
    `${site.name} ${site.domain} ${site.category}`.toLowerCase().includes(search.toLowerCase()),
  );
  const save = async (host: string, enabled: boolean, added = false) => {
    setPendingRule({ host, enabled });
    setBusy(true);
    setMessage('');
    try {
      await sitePolicyStorage.setRule(host, enabled);
      if (added) setDomain('');
      setMessage('名单已保存，Chrome 配置同步已提交；已连接 Google Drive 时会自动合并同步。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '名单保存失败');
    } finally {
      setBusy(false);
      setPendingRule(undefined);
    }
  };
  return (
    <section className="grid gap-3 text-sm" aria-label="自动同步网站名单">
      <h2 className="section-title">网站名单</h2>
      <p>
        默认仅自动同步内置 {commonSites.length}{' '}
        个站点及你添加的域名。根域名包含其子域名，更具体的规则优先；同步管理中手动关闭的推送、拉取开关仍然有效。
      </p>
      <p className="text-muted-foreground">
        无法准确识别登录状态，名单内的未登录站点数据也可能同步。精选名单不是流量排名，也不保证网站登录状态可以跨设备恢复。
      </p>
      <p>
        {drive.connected
          ? 'Google Drive 已连接：名单随自动检查合并同步。'
          : '名单随 Chrome 账号同步；连接 Google Drive 后，也会在两台电脑间同步。'}
      </p>
      <form
        className="flex gap-2"
        onSubmit={event => {
          event.preventDefault();
          void save(domain, true, true);
        }}>
        <Input
          aria-label="自定义自动同步域名"
          placeholder="例如 example.com 或网站网址"
          value={domain}
          onChange={event => setDomain(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy || !domain.trim()}>
          添加网站
        </Button>
      </form>
      {message && (
        <p role="status" className="break-words">
          {message}
        </p>
      )}
      {custom.length > 0 && (
        <div className="grid gap-2" aria-label="自定义网站">
          <p className="font-medium">自定义网站（取消勾选即停用，记录保留用于跨设备同步）</p>
          {custom.map(host => (
            <label key={host} className="flex items-center gap-2 break-all">
              <input
                type="checkbox"
                checked={pendingRule?.host === host ? pendingRule.enabled : isSiteAllowed(host, rules)}
                disabled={busy}
                onChange={event => void save(host, event.target.checked)}
              />
              {host}
            </label>
          ))}
        </div>
      )}
      <details>
        <summary className="cursor-pointer">查看和编辑内置 {commonSites.length} 个网站</summary>
        <div className="grid gap-3 pt-3">
          <Input
            aria-label="搜索内置网站"
            placeholder="搜索名称、域名或分类"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
          <div className="grid gap-2 sm:grid-cols-2 max-h-80 overflow-y-auto" aria-label="内置网站列表">
            {filtered.map(site => (
              <label key={site.domain} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={pendingRule?.host === site.domain ? pendingRule.enabled : isSiteAllowed(site.domain, rules)}
                  disabled={busy}
                  onChange={event => void save(site.domain, event.target.checked)}
                />
                <span>
                  {site.name}
                  <span className="block text-muted-foreground break-all">
                    {site.domain} · {site.category}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {filtered.length === 0 && <p>没有匹配网站，可在上方添加自定义域名。</p>}
        </div>
      </details>
      {paused.length > 0 && (
        <details>
          <summary className="cursor-pointer">名单外已暂停自动同步：{paused.length} 个网站</summary>
          <p className="pt-2 break-words">{paused.join('、')}</p>
          <p className="text-muted-foreground">
            本地和云端数据保留，手动推送、拉取仍可使用。添加到名单后可恢复自动同步。
          </p>
        </details>
      )}
    </section>
  );
}
