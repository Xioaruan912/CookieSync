import { useGSAP } from '@gsap/react';
import { useStorageSuspense } from '@sync-your-cookie/shared';
import { commonSites, isSiteAllowed } from '@sync-your-cookie/storage/lib/commonSites';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { sitePolicyStorage } from '@sync-your-cookie/storage/lib/sitePolicyStorage';
import { Switch } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

gsap.registerPlugin(useGSAP);

type SitesSlide = 'builtin' | 'custom' | 'paused';
const PAGE_SIZE = 15;

export function SitePolicySettings() {
  const rules = useSyncExternalStore(sitePolicyStorage.subscribe, sitePolicyStorage.getSnapshot) || {};
  const config = useStorageSuspense(domainConfigStorage);
  const settings = useStorageSuspense(settingsStorage);

  const [slide, setSlide] = useState<SitesSlide>('builtin');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('全部');
  const [page, setPage] = useState(1);
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pendingRule, setPendingRule] = useState<{ host: string; enabled: boolean }>();

  const stageRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);

  const builtinSet = useMemo(() => new Set(commonSites.map(site => site.domain)), []);
  const custom = useMemo(() => Object.keys(rules).filter(host => !builtinSet.has(host)), [rules, builtinSet]);
  const paused = useMemo(
    () => Object.keys(config.domainMap).filter(host => !isSiteAllowed(host, rules)),
    [config.domainMap, rules],
  );

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const site of commonSites) {
      counts.set(site.category, (counts.get(site.category) || 0) + 1);
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name]) => name);
    return ['全部', ...top];
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return commonSites.filter(site => {
      if (category !== '全部' && site.category !== category) return false;
      if (!q) return true;
      return `${site.name} ${site.domain} ${site.category}`.toLowerCase().includes(q);
    });
  }, [search, category]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  );

  useEffect(() => {
    setPage(1);
  }, [search, category]);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.from('.sites-wordmark', {
          yPercent: 105,
          duration: 0.72,
          ease: 'power4.out',
          clearProps: 'transform',
        });
      });
    },
    { scope: stageRef },
  );

  useGSAP(
    () => {
      if (!slideRef.current) return;
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.fromTo(
          slideRef.current,
          { opacity: 0, x: 18 },
          { opacity: 1, x: 0, duration: 0.32, ease: 'power3.out', clearProps: 'transform,opacity' },
        );
      });
    },
    { dependencies: [slide, safePage] },
  );

  const channel =
    settings.configChannel === 'webdav'
      ? '名单随 Chrome 账号同步，并经私人网盘在双机间合并'
      : settings.configChannel === 'off'
        ? '配置同步已关闭，名单仅保存在本机'
        : '名单随 Chrome 账号自动同步';

  const save = async (host: string, enabled: boolean, added = false) => {
    setPendingRule({ host, enabled });
    setBusy(true);
    setMessage('');
    try {
      await sitePolicyStorage.setRule(host, enabled);
      if (added) setDomain('');
      setMessage(`已保存 ${host.trim()}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '名单保存失败');
    } finally {
      setBusy(false);
      setPendingRule(undefined);
    }
  };

  const slidesOrder: SitesSlide[] = ['builtin', 'custom', 'paused'];
  const slideIndex = slidesOrder.indexOf(slide);

  return (
    <section ref={stageRef} className="sites-stage" aria-label="自动同步网站名单">
      <div className="sites-top-bar">
        <div className="sites-wordmark-wrap">
          <h1 id="settings-title" className="sites-wordmark">
            Sites
          </h1>
        </div>
        <div className="sites-deck-tabs" role="tablist" aria-label="名单视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={slide === 'builtin'}
            className="sites-deck-tab"
            onClick={() => setSlide('builtin')}>
            <span className="sites-deck-tab-num">01</span>
            <span>内置名单</span>
            <span className="sites-deck-tab-count">{commonSites.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={slide === 'custom'}
            className="sites-deck-tab"
            onClick={() => setSlide('custom')}>
            <span className="sites-deck-tab-num">02</span>
            <span>自定义规则</span>
            <span className="sites-deck-tab-count">{custom.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={slide === 'paused'}
            className="sites-deck-tab"
            onClick={() => setSlide('paused')}>
            <span className="sites-deck-tab-num">03</span>
            <span>已暂停</span>
            <span className="sites-deck-tab-count">{paused.length}</span>
          </button>
        </div>
      </div>

      <div className="sites-viewport">
        <div ref={slideRef} className="sites-slide" role="tabpanel">
          {slide === 'builtin' ? (
            <>
              <div className="sites-toolbar">
                <div className="sites-search-wrap">
                  <Search size={15} className="sites-search-icon" aria-hidden="true" />
                  <input
                    type="text"
                    className="sites-search-input"
                    aria-label="搜索内置网站"
                    placeholder="搜索名称、域名或分类…"
                    value={search}
                    onChange={event => setSearch(event.target.value)}
                  />
                </div>
                <div className="sites-cat-pills" role="group" aria-label="网站分类筛选">
                  {categories.map(cat => (
                    <button
                      key={cat}
                      type="button"
                      className="sites-cat-pill"
                      aria-pressed={category === cat}
                      onClick={() => setCategory(cat)}>
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {pageItems.length > 0 ? (
                <div className="sites-grid" aria-label="内置网站列表">
                  {pageItems.map(site => {
                    const enabled =
                      pendingRule?.host === site.domain ? pendingRule.enabled : isSiteAllowed(site.domain, rules);
                    return (
                      <div key={site.domain} className="sites-row">
                        <div className="sites-row-main">
                          <span className="sites-row-name">{site.name}</span>
                          <span className="sites-row-meta">
                            {site.domain} · {site.category}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="sites-toggle-btn"
                          aria-pressed={enabled}
                          disabled={busy}
                          onClick={() => void save(site.domain, !enabled)}>
                          <span className="sites-dot" data-on={enabled} aria-hidden="true" />
                          {enabled ? '已启用' : '已停用'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="sites-empty">
                  没有匹配网站，可切到「02 自定义规则」添加任意域名。
                </div>
              )}
            </>
          ) : null}

          {slide === 'custom' ? (
            <div className="sites-split">
              <div className="sites-col-left">
                <h2 className="sites-lead">添加自定义同步域名</h2>
                <p className="sites-desc">
                  输入根域名后会自动覆盖其子域名，更具体的规则优先。取消勾选即可停用，记录会保留以便在双机间同步。
                </p>
                <form
                  className="sites-add-form"
                  onSubmit={event => {
                    event.preventDefault();
                    void save(domain, true, true);
                  }}>
                  <input
                    type="text"
                    className="sites-add-input"
                    aria-label="自定义自动同步域名"
                    placeholder="例如 example.com 或粘贴完整网址"
                    value={domain}
                    onChange={event => setDomain(event.target.value)}
                  />
                  <button type="submit" className="sites-pill-primary" disabled={busy || !domain.trim()}>
                    <Plus size={15} aria-hidden="true" />
                    添加网站
                  </button>
                </form>
              </div>

              <div className="sites-col-right" aria-label="自定义网站">
                {custom.length > 0 ? (
                  custom.map(host => {
                    const enabled = pendingRule?.host === host ? pendingRule.enabled : isSiteAllowed(host, rules);
                    return (
                      <div key={host} className="sites-row">
                        <div className="sites-row-main">
                          <span className="sites-row-name">{host}</span>
                          <span className="sites-row-meta">{enabled ? '自动同步中' : '已停用（保留跨机记录）'}</span>
                        </div>
                        <Switch
                          aria-label={`切换 ${host} 自动同步`}
                          checked={enabled}
                          disabled={busy}
                          onCheckedChange={checked => void save(host, checked)}
                        />
                      </div>
                    );
                  })
                ) : (
                  <div className="sites-empty">暂无自定义域名，在左侧输入域名即可添加。</div>
                )}
              </div>
            </div>
          ) : null}

          {slide === 'paused' ? (
            <div className="sites-split">
              <div className="sites-col-left">
                <h2 className="sites-lead">名单外已暂停站点</h2>
                <p className="sites-desc">
                  不在内置 300 站点与自定义规则内的旧站点会自动暂停后台收发，但本地与云端数据都会安全保留，你随时可以一键恢复。
                </p>
              </div>

              <div className="sites-col-right" aria-label="名单外已暂停网站">
                {paused.length > 0 ? (
                  paused.map(host => (
                    <div key={host} className="sites-row">
                      <div className="sites-row-main">
                        <span className="sites-row-name">{host}</span>
                        <span className="sites-row-meta">仅暂停自动同步 · 手动推拉仍可用</span>
                      </div>
                      <button
                        type="button"
                        className="sites-toggle-btn"
                        disabled={busy}
                        onClick={() => void save(host, true)}>
                        恢复自动同步
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="sites-empty">当前没有已暂停的名单外站点。</div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="sites-rail">
        <p className="sites-rail-note" role="status">
          {message ? `${message} · ${channel}` : `${channel} · 共 ${filtered.length} 个匹配站点`}
        </p>

        {slide === 'builtin' ? (
          <div className="sites-pager" aria-label="名单翻页">
            <button
              type="button"
              className="sites-pager-btn"
              aria-label="上一页"
              disabled={safePage <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}>
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            <span className="sites-pager-num">
              {String(safePage).padStart(2, '0')} / {String(totalPages).padStart(2, '0')}
            </span>
            <button
              type="button"
              className="sites-pager-btn"
              aria-label="下一页"
              disabled={safePage >= totalPages}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className="sites-pager" aria-label="切换页面">
            <button
              type="button"
              className="sites-pager-btn"
              aria-label="上一视图"
              disabled={slideIndex <= 0}
              onClick={() => setSlide(slidesOrder[Math.max(0, slideIndex - 1)])}>
              <ChevronLeft size={15} aria-hidden="true" />
            </button>
            <span className="sites-pager-num">
              {String(slideIndex + 1).padStart(2, '0')} / 03
            </span>
            <button
              type="button"
              className="sites-pager-btn"
              aria-label="下一视图"
              disabled={slideIndex >= slidesOrder.length - 1}
              onClick={() => setSlide(slidesOrder[Math.min(slidesOrder.length - 1, slideIndex + 1)])}>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
