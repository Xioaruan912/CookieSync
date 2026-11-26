import { useGSAP } from '@gsap/react';
import { RuntimeMessageType, useLocale, useStorageSuspense, type OverviewRow } from '@sync-your-cookie/shared';
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
import { OverviewSiteDetails, SiteState, siteNeedsAttention } from './OverviewSiteDetails';

gsap.registerPlugin(useGSAP);

interface OverviewPayload {
  rows: OverviewRow[];
  schemaWarning?: { message: string };
}

const filters = [
  ['all', '全部', 'All'],
  ['attention', '待处理', 'Attention'],
  ['paused', '已暂停', 'Paused'],
] as const;
type Filter = (typeof filters)[number][0];
type Operation = { direction: TransferDirection; domain?: string };
type Dialog = { kind: 'site'; domain: string } | { kind: 'bulk'; direction?: TransferDirection } | { kind: 'notice' };
const narrowLayout = '(max-width: 820px), (max-height: 560px)';

export function OverviewPanel() {
  const { isEn, t } = useLocale();
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
  const [pageSize, setPageSize] = useState(6);
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
      const rowHeight = Number.parseFloat(getComputedStyle(element).getPropertyValue('--overview-row-height')) || 54;
      setPageSize(Math.max(1, Math.floor((element.clientHeight - 2) / rowHeight)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const sites = data?.rows || [];
  const attentionCount = sites.filter(siteNeedsAttention).length;
  const pausedCount = sites.filter(site => site.paused).length;
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

  // Smooth horizontal slide when flipping pages
  useGSAP(
    () => {
      const direction = pageMotion.current;
      pageMotion.current = 0;
      if (!direction || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      gsap.fromTo(
        '.overview-site-list',
        { x: direction * 34, opacity: 0 },
        {
          x: 0,
          opacity: 1,
          duration: 0.28,
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
        <section ref={listCard} className="overview-list-card" aria-label={t('网站列表', 'Site list')}>
          <div className="overview-list-controls">
            <div className="overview-segment" role="group" aria-label={t('筛选网站', 'Filter sites')}>
              {filters.map(([key, name, enName]) => {
                const badgeCount =
                  !data
                    ? 0
                    : key === 'all'
                      ? sites.length
                      : key === 'attention'
                        ? attentionCount
                        : pausedCount;
                return (
                  <button
                    type="button"
                    key={key}
                    aria-pressed={filter === key}
                    onClick={() => {
                      selectMotion.current = false;
                      setFilter(key);
                      setPage(0);
                    }}>
                    {isEn ? enName : name}
                    {badgeCount > 0 ? ` ${badgeCount}` : ''}
                  </button>
                );
              })}
            </div>

            <div className="ov-right-tools">
              <label className="overview-query">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  aria-label={t('搜索网站', 'Search sites')}
                  placeholder={t('搜索网站', 'Search sites')}
                  value={query}
                  onChange={event => {
                    selectMotion.current = false;
                    setQuery(event.target.value);
                    setPage(0);
                  }}
                />
              </label>

              {notices.length > 0 ? (
                <button
                  type="button"
                  className="ov-text-btn"
                  data-tone="warn"
                  onClick={() => setDialog({ kind: 'notice' })}>
                  <CircleAlert size={14} aria-hidden="true" />
                  <span>{t('提示', 'Notices')}</span>
                </button>
              ) : null}

              <button
                type="button"
                className="ov-text-btn"
                disabled={loading}
                onClick={() => {
                  setLoading(true);
                  void load();
                }}>
                {loading ? (
                  <Loader2 size={14} className="overview-spinner" aria-hidden="true" />
                ) : (
                  <RefreshCw size={14} aria-hidden="true" />
                )}
                <span>{t('刷新', 'Refresh')}</span>
              </button>
            </div>
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
                  ? t('正在读取网站…', 'Loading sites…')
                  : readError
                    ? t('读取失败，请刷新。', 'Failed to load. Please refresh.')
                    : sites.length
                      ? t('没有匹配的网站。', 'No matching sites.')
                      : t('暂无已登记网站。', 'No synced sites yet.')}
              </p>
            )}
          </div>

          <div className="overview-list-footer">
            <button type="button" className="ov-text-btn" onClick={() => setDialog({ kind: 'bulk' })}>
              <MoreHorizontal size={15} aria-hidden="true" />
              <span>{t('批量操作', 'Bulk actions')}</span>
            </button>

            <div className="overview-pager" role="group" aria-label={t('网站分页', 'Pagination')}>
              <button
                type="button"
                className="ov-arrow-btn"
                aria-label={t('上一页', 'Previous page')}
                disabled={activePage === 0}
                onClick={event => changePage(-1, event.detail > 0)}>
                <ChevronLeft size={15} aria-hidden="true" />
              </button>
              <output aria-live="polite">
                {String(activePage + 1).padStart(2, '0')} / {String(pages).padStart(2, '0')}
              </output>
              <button
                type="button"
                className="ov-arrow-btn"
                aria-label={t('下一页', 'Next page')}
                disabled={activePage + 1 === pages}
                onClick={event => changePage(1, event.detail > 0)}>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
        </section>

        <aside className="overview-inspector" aria-label={t('站点详情', 'Site details')}>
          {selected ? (
            renderDetails(selected, selectMotion.current)
          ) : (
            <p className="overview-list-empty">{loading ? t('正在读取…', 'Loading…') : t('当前没有可查看的站点。', 'Select a site to inspect.')}</p>
          )}
        </aside>
      </div>

      {dialog?.kind === 'site' ? (
        <OverviewDialog title={t('站点详情', 'Site Details')} sheet onClose={() => setDialog(undefined)}>
          {modalSite ? renderDetails(modalSite) : <p>{t('该站点已从列表移除。', 'This site has been removed.')}</p>}
        </OverviewDialog>
      ) : null}

      {dialog?.kind === 'notice' ? (
        <OverviewDialog title={t('同步提示', 'Sync Notices')} onClose={() => setDialog(undefined)}>
          <ul className="overview-issues">
            {notices.length ? notices.map(notice => <li key={notice}>{notice}</li>) : <li>{t('当前没有提示。', 'No notices.')}</li>}
          </ul>
        </OverviewDialog>
      ) : null}

      {dialog?.kind === 'bulk' ? (
        <OverviewDialog title={t('批量操作', 'Bulk Actions')} onClose={() => setDialog(undefined)}>
          <p className="overview-dialog-copy" role="status">
            {bulkDirection === 'pull'
              ? t('云端数据将覆盖名单内开启自动拉取的网站，本机未上传的改动会被放弃。', 'Cloud snapshots will overwrite local sessions for all sites with auto-pull enabled.')
              : bulkDirection === 'push'
                ? t('本机数据将覆盖名单内开启自动推送的网站，云端较新的改动会被覆盖。', 'Local sessions will overwrite cloud snapshots for all sites with auto-push enabled.')
                : connected
                  ? t('批量操作适用于名单内已开启相应同步方向的网站。', 'Bulk actions apply to all listed sites with the selected sync direction enabled.')
                  : t('连接 WebDAV 后即可批量操作。', 'Connect WebDAV to use bulk actions.')}
          </p>
          <div className="overview-inspector-actions">
            {bulkDirection ? (
              <>
                <Button
                  ref={bulkConfirmButton}
                  size="sm"
                  className="ov-btn-primary"
                  disabled={!connected || blocked}
                  onClick={() => void transfer({ direction: bulkDirection })}>
                  {operation ? t('处理中…', 'Working…') : bulkDirection === 'push' ? t('确认全部上传', 'Confirm Push All') : t('确认拉取全部', 'Confirm Pull All')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="ov-btn-outline"
                  disabled={!!operation}
                  onClick={() => setDialog({ kind: 'bulk' })}>
                  {t('返回', 'Back')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="ov-btn-outline"
                  disabled={!connected || blocked}
                  onClick={() => setDialog({ kind: 'bulk', direction: 'pull' })}>
                  <ArrowDownToLine size={14} aria-hidden="true" />
                  {t('拉取全部', 'Pull All')}
                </Button>
                <Button
                  size="sm"
                  className="ov-btn-primary"
                  disabled={!connected || blocked}
                  onClick={() => setDialog({ kind: 'bulk', direction: 'push' })}>
                  <ArrowUpFromLine size={14} aria-hidden="true" />
                  {t('全部上传', 'Push All')}
                </Button>
              </>
            )}
          </div>
        </OverviewDialog>
      ) : null}
    </div>
  );
}
