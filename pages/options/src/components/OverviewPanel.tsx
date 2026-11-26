import { useGSAP } from '@gsap/react';
import { RuntimeMessageType, useStorageSuspense, type OverviewRow } from '@sync-your-cookie/shared';
import { accountStorage, isLegacyProvider } from '@sync-your-cookie/storage/lib/accountStorage';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { Button } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DeviceStatus, type TransferDirection } from './DeviceStatus';
import { OverviewDialog } from './OverviewDialog';
import { OverviewSiteDetails, SiteMark, SiteState, siteNeedsAttention } from './OverviewSiteDetails';

gsap.registerPlugin(useGSAP);

interface OverviewPayload {
  rows: OverviewRow[];
  schemaWarning?: { message: string };
}

const filters = [
  ['all', '全部'],
  ['attention', '待处理'],
  ['paused', '已暂停'],
] as const;
type Filter = (typeof filters)[number][0];
type Operation = { direction: TransferDirection; domain?: string };
type Dialog = { kind: 'site'; domain: string } | { kind: 'bulk'; direction?: TransferDirection } | { kind: 'notice' };
const narrowLayout = '(max-width: 820px), (max-height: 540px)';

export function OverviewPanel() {
  const account = useStorageSuspense(accountStorage);
  const status = useStorageSuspense(autoSyncStatusStorage);
  const webdav = useStorageSuspense(webdavStorage);
  const connected =
    !isLegacyProvider(account) && !!webdav.url?.trim() && !!webdav.username?.trim() && !!webdav.password;
  const [data, setData] = useState<OverviewPayload>();
  const [readError, setReadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(5);
  const [selectedDomain, setSelectedDomain] = useState<string>();
  const [dialog, setDialog] = useState<Dialog>();
  const [operation, setOperation] = useState<Operation>();
  const operationRef = useRef<Operation>();
  const viewport = useRef<HTMLDivElement>(null);
  const listCard = useRef<HTMLElement>(null);
  const requestNumber = useRef(0);
  const pageMotion = useRef(0);
  const selectMotion = useRef(false);
  const bulkConfirmButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const request = ++requestNumber.current;
    try {
      const response = await chrome.runtime.sendMessage({ type: RuntimeMessageType.Overview });
      if (request !== requestNumber.current) return;
      if (!response?.isOk) throw new Error(response?.msg || '读取总览失败');
      setData(response.result as OverviewPayload);
      setReadError('');
    } catch (error) {
      if (request === requestNumber.current) setReadError(error instanceof Error ? error.message : '读取总览失败');
    } finally {
      if (request === requestNumber.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void load(), 30000);
    let debounce: number | undefined;
    const onLocalChange: Parameters<typeof chrome.storage.local.onChanged.addListener>[0] = changes => {
      if (
        !Object.keys(changes).some(
          key => key === 'cookiesync-storage-truncated' || /^cookiesync-pending-[a-f0-9]{64}$/.test(key),
        )
      )
        return;
      if (debounce !== undefined) return;
      debounce = window.setTimeout(() => {
        debounce = undefined;
        void load();
      }, 120);
    };
    chrome.storage.local.onChanged.addListener(onLocalChange);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(debounce);
      chrome.storage.local.onChanged.removeListener(onLocalChange);
      requestNumber.current += 1;
    };
  }, [load]);

  useEffect(() => {
    void load();
  }, [load, connected, status.phase, status.pendingCount, status.lastCheck, status.lastSuccess]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const rowHeight = Number.parseFloat(getComputedStyle(element).getPropertyValue('--overview-row-height')) || 48;
      setPageSize(Math.max(1, Math.floor(element.clientHeight / rowHeight)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const sites = data?.rows || [];
  const search = query.trim().toLowerCase();
  const filtered = sites.filter(
    site =>
      (!search || site.domain.toLowerCase().includes(search)) &&
      (filter === 'all' || (filter === 'attention' ? siteNeedsAttention(site) : site.paused)),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const activePage = Math.min(page, pages - 1);
  const visible = filtered.slice(activePage * pageSize, (activePage + 1) * pageSize);
  const selected = visible.find(site => site.domain === selectedDomain) || visible[0];
  const modalSite = dialog?.kind === 'site' ? sites.find(site => site.domain === dialog.domain) : undefined;
  const bulkDirection = dialog?.kind === 'bulk' ? dialog.direction : undefined;
  const notices = Array.from(
    new Set([readError, data?.schemaWarning?.message, connected ? status.error : ''].filter(Boolean)),
  );
  const blocked = !!operation || status.phase === 'taking-over' || status.deviceRole === 'taking-over';

  useLayoutEffect(() => {
    if (bulkDirection) bulkConfirmButton.current?.focus({ preventScroll: true });
  }, [bulkDirection]);

  useGSAP(
    () => {
      const direction = pageMotion.current;
      pageMotion.current = 0;
      if (!direction || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      gsap.fromTo(
        '.overview-site-list',
        { x: direction * 14, opacity: 0.65 },
        {
          x: 0,
          opacity: 1,
          duration: 0.21,
          ease: 'power3.out',
          clearProps: 'transform,opacity',
          overwrite: 'auto',
        },
      );
    },
    { scope: listCard, dependencies: [activePage], revertOnUpdate: true },
  );

  const transfer = async ({ direction, domain }: Operation) => {
    if (
      !connected ||
      operationRef.current ||
      status.phase === 'taking-over' ||
      status.deviceRole === 'taking-over' ||
      (domain && !sites.some(site => site.domain === domain && site.listed))
    )
      return;

    const current = { direction, domain };
    operationRef.current = current;
    setOperation(current);
    const fallback = direction === 'push' ? '推送失败' : '拉取失败';
    try {
      const type = domain
        ? direction === 'push'
          ? RuntimeMessageType.PushSite
          : RuntimeMessageType.PullSite
        : direction === 'push'
          ? RuntimeMessageType.PushAll
          : RuntimeMessageType.PullAll;
      const result = await chrome.runtime.sendMessage(domain ? { type, domain } : { type });
      if (!result?.isOk) throw new Error(result?.msg || fallback);
      if (domain) {
        toast.success(direction === 'push' ? `已推送 ${domain}` : `已拉取 ${domain}`);
      } else {
        const summary = result.result as { domains: number; skipped: number };
        toast.success(
          `${direction === 'push' ? '已上传' : '已拉取'} ${summary.domains} 个网站，跳过 ${summary.skipped} 个`,
        );
        setDialog(value => (value?.kind === 'bulk' ? undefined : value));
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : fallback);
    } finally {
      operationRef.current = undefined;
      setOperation(undefined);
    }
  };

  const renderDetails = (site: OverviewRow, animate = false) => (
    <OverviewSiteDetails
      key={site.domain}
      site={site}
      connected={connected}
      blocked={blocked}
      working={operation?.domain === site.domain ? operation.direction : undefined}
      animate={animate}
      onTransfer={direction => transfer({ direction, domain: site.domain })}
    />
  );

  const changePage = (direction: number, animated: boolean) => {
    const next = Math.min(pages - 1, Math.max(0, activePage + direction));
    if (next === activePage) return;
    pageMotion.current = animated ? direction : 0;
    selectMotion.current = false;
    setPage(next);
  };

  return (
    <div className="overview-console">
      <DeviceStatus connected={connected} busy={!!operation} operation={operation?.direction} onSync={load} />
      <div className="overview-desk">
        <section ref={listCard} className="overview-card overview-list-card" aria-label="网站列表">
          <div className="overview-card-head">
            <h2>
              网站 <span className="overview-count">{data ? filtered.length : '—'}</span>
            </h2>
            <div className="overview-list-actions">
              {notices.length > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="overview-control overview-notice"
                  onClick={() => setDialog({ kind: 'notice' })}>
                  <CircleAlert size={16} aria-hidden="true" /> <span>查看提示</span>
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                className="overview-control"
                disabled={loading}
                onClick={() => {
                  setLoading(true);
                  void load();
                }}>
                {loading ? (
                  <Loader2 size={15} className="overview-spinner" aria-hidden="true" />
                ) : (
                  <RefreshCw size={15} aria-hidden="true" />
                )}
                刷新
              </Button>
            </div>
          </div>
          <div className="overview-list-controls">
            <div className="overview-segment" role="group" aria-label="筛选网站">
              {filters.map(([key, name]) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={filter === key}
                  onClick={() => {
                    selectMotion.current = false;
                    setFilter(key);
                    setPage(0);
                  }}>
                  {name}
                </button>
              ))}
            </div>
            <label className="overview-query">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索网站"
                placeholder="搜索网站"
                value={query}
                onChange={event => {
                  selectMotion.current = false;
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
            </label>
          </div>

          <div ref={viewport} className="overview-list-viewport" aria-busy={loading}>
            {visible.length ? (
              <ul className="overview-site-list">
                {visible.map(site => (
                  <li key={site.domain}>
                    <button
                      type="button"
                      className="overview-site-button"
                      aria-pressed={selected?.domain === site.domain}
                      onClick={event => {
                        selectMotion.current = event.detail > 0;
                        setSelectedDomain(site.domain);
                        if (window.matchMedia(narrowLayout).matches) setDialog({ kind: 'site', domain: site.domain });
                      }}>
                      <SiteMark domain={site.domain} />
                      <strong title={site.domain}>{site.domain}</strong>
                      <SiteState site={site} connected={connected} />
                      <ChevronRight size={15} className="overview-chevron" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="overview-list-empty" role="status">
                {loading
                  ? '正在读取网站…'
                  : readError
                    ? '读取失败，请刷新。'
                    : sites.length
                      ? '没有匹配的网站。'
                      : '暂无已登记网站。'}
              </p>
            )}
          </div>

          <div className="overview-list-footer">
            <Button size="sm" variant="ghost" className="overview-control" onClick={() => setDialog({ kind: 'bulk' })}>
              <MoreHorizontal size={16} aria-hidden="true" />
              批量操作
            </Button>
            <div className="overview-pager" role="group" aria-label="网站分页">
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label="上一页"
                disabled={activePage === 0}
                onClick={event => changePage(-1, event.detail > 0)}>
                <ChevronLeft size={16} aria-hidden="true" />
              </Button>
              <output aria-live="polite">
                {activePage + 1} / {pages}
              </output>
              <Button
                type="button"
                size="icon"
                variant="outline"
                aria-label="下一页"
                disabled={activePage + 1 === pages}
                onClick={event => changePage(1, event.detail > 0)}>
                <ChevronRight size={16} aria-hidden="true" />
              </Button>
            </div>
          </div>
        </section>

        <aside className="overview-card overview-inspector" aria-label="站点详情">
          <h2>站点详情</h2>
          {selected ? (
            renderDetails(selected, selectMotion.current)
          ) : (
            <p className="overview-list-empty">{loading ? '正在读取…' : '当前没有可查看的站点。'}</p>
          )}
        </aside>
      </div>

      {dialog?.kind === 'site' ? (
        <OverviewDialog title="站点详情" sheet onClose={() => setDialog(undefined)}>
          {modalSite ? renderDetails(modalSite) : <p>该站点已从列表移除。</p>}
        </OverviewDialog>
      ) : null}

      {dialog?.kind === 'notice' ? (
        <OverviewDialog title="同步提示" onClose={() => setDialog(undefined)}>
          <ul className="overview-dialog-copy overview-issues">
            {notices.length ? notices.map(notice => <li key={notice}>{notice}</li>) : <li>当前没有提示。</li>}
          </ul>
        </OverviewDialog>
      ) : null}

      {dialog?.kind === 'bulk' ? (
        <OverviewDialog title="批量操作" onClose={() => setDialog(undefined)}>
          <p className="overview-dialog-copy" role="status">
            {bulkDirection === 'pull'
              ? '云端数据将覆盖名单内开启自动拉取的网站，本机未上传的改动会被放弃。'
              : bulkDirection === 'push'
                ? '本机数据将覆盖名单内开启自动推送的网站，云端较新的改动会被覆盖。'
                : connected
                  ? '批量操作适用于名单内已开启相应同步方向的网站。'
                  : '连接 WebDAV 后即可批量操作。'}
          </p>
          <div className="overview-inspector-actions">
            {bulkDirection ? (
              <>
                <Button
                  ref={bulkConfirmButton}
                  size="sm"
                  className="overview-control rounded-full"
                  disabled={!connected || blocked}
                  onClick={() => void transfer({ direction: bulkDirection })}>
                  {operation ? '处理中…' : bulkDirection === 'push' ? '确认全部上传' : '确认拉取全部'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="overview-control rounded-full"
                  disabled={!!operation}
                  onClick={() => setDialog({ kind: 'bulk' })}>
                  返回
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="overview-control rounded-full"
                  disabled={!connected || blocked}
                  onClick={() => setDialog({ kind: 'bulk', direction: 'pull' })}>
                  <ArrowDownToLine size={15} aria-hidden="true" />
                  拉取全部
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="overview-control rounded-full"
                  disabled={!connected || blocked}
                  onClick={() => setDialog({ kind: 'bulk', direction: 'push' })}>
                  <ArrowUpFromLine size={15} aria-hidden="true" />
                  全部上传
                </Button>
              </>
            )}
          </div>
        </OverviewDialog>
      ) : null}
    </div>
  );
}
