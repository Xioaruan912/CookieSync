import { useStorageSuspense } from '@sync-your-cookie/shared';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { Button } from '@sync-your-cookie/ui';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleAlert,
  Cloud,
  CloudOff,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface OverviewRow {
  domain: string;
  sourceUrl?: string;
  listed: boolean;
  autoPush: boolean;
  autoPull: boolean;
  paused: boolean;
  pending?: {
    capturedAt?: number;
    cookies: number;
    localStorageItems: number;
    sessionStorageItems: number;
    indexedDBRecords: number;
  };
  cached?: {
    updateTime?: number;
    cookies: number;
    localStorageItems: number;
    sessionStorageItems: number;
    indexedDBRecords: number;
  };
  health?: { state?: 'ok' | 'invalid' | 'unknown'; message?: string; checkedAt?: number; userName?: string };
  lastPushAt?: number;
  lastPullAt?: number;
  error?: string;
  truncated?: number;
  indexedDbSkipped?: string[];
  attention: string[];
}

interface OverviewPayload {
  rows: OverviewRow[];
  connected: boolean;
  sessionDefault: boolean;
  status?: { pendingCount?: number; error?: string; lastCheck?: number; lastSuccess?: number; note?: string };
  schemaWarning?: { at: number; message: string };
}

type Filter = 'all' | 'attention' | 'paused';
type BulkSummary = { domains: number; cookies: number; localStorageItems: number; skipped: number };

const time = (value?: number) =>
  value
    ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '尚无记录';

const stateLabel = (row: OverviewRow) => {
  if (!row.listed) return '名单外（暂停）';
  if (row.paused) return '已暂停';
  if (row.autoPush && row.autoPull) return '自动收发';
  return row.autoPush ? '仅自动推送' : '仅自动拉取';
};

const healthLabel = (row: OverviewRow) => {
  const state = row.health?.state;
  if (state === 'ok') return '会话有效';
  if (state === 'invalid') return '会话失效';
  if (state === 'unknown') return '未验证完成';
  return '未验证';
};

export function OverviewPanel() {
  const status = useStorageSuspense(autoSyncStatusStorage);
  const [data, setData] = useState<OverviewPayload>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkConfirm, setBulkConfirm] = useState<'pull' | 'push'>();
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CookieSyncOverview' });
      if (!response?.isOk) throw new Error(response?.msg || '读取总览失败');
      setData(response.result as OverviewPayload);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取总览失败，请重新加载扩展');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    void load();
  }, [status.pendingCount, status.lastCheck, status.lastSuccess, load]);

  useEffect(() => () => confirmTimer.current && clearTimeout(confirmTimer.current), []);

  const armConfirm = (key: string) => {
    setConfirm(key);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirm(''), 5000);
  };

  const act = async (row: OverviewRow, kind: 'push' | 'pull') => {
    const key = `${row.domain}:${kind}`;
    if (confirm !== key) {
      armConfirm(key);
      return;
    }
    setConfirm('');
    setBusy(key);
    setMessage('');
    try {
      const response = await chrome.runtime.sendMessage({
        type: kind === 'push' ? 'CookieSyncPushSite' : 'CookieSyncPullSite',
        domain: row.domain,
      });
      if (!response?.isOk) throw new Error(response?.msg || (kind === 'push' ? '推送失败' : '拉取失败'));
      setMessage(
        kind === 'push'
          ? `已上传 ${row.domain}（${response.result?.cookies ?? 0} 个 Cookie）`
          : `已从云端应用 ${row.domain}，已打开的页面已刷新`,
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : kind === 'push' ? '推送失败' : '拉取失败');
    } finally {
      setBusy('');
    }
  };

  const runBulk = async (mode: 'pull' | 'push') => {
    setBulkBusy(true);
    setMessage('');
    setError('');
    try {
      const response = await chrome.runtime.sendMessage({
        type: mode === 'pull' ? 'CookieSyncPullAll' : 'CookieSyncPushAll',
      });
      if (!response?.isOk) throw new Error(response?.msg || (mode === 'pull' ? '拉取全部失败' : '全部上传失败'));
      const result = response.result as BulkSummary;
      setMessage(
        `${mode === 'pull' ? '已从云端拉取' : '已向云端上传'} ${result.domains} 个网站（${result.cookies} 个 Cookie），跳过 ${result.skipped} 个`,
      );
      setBulkConfirm(undefined);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : mode === 'pull' ? '拉取全部失败' : '全部上传失败');
    } finally {
      setBulkBusy(false);
    }
  };

  const rows = data?.rows || [];
  const pendingCount = rows.filter(row => row.pending).length;
  const healthIssues = rows.filter(row => row.health?.state === 'invalid').length;
  const pausedCount = rows.filter(row => row.paused).length;
  const connected = data?.connected ?? false;
  const visible = rows.filter(row => {
    if (search && !row.domain.toLowerCase().includes(search.trim().toLowerCase())) return false;
    if (filter === 'attention')
      return row.pending || row.health?.state === 'invalid' || row.error || row.truncated || !row.listed;
    if (filter === 'paused') return row.paused;
    return true;
  });

  return (
    <div className="overview-panel" aria-label="同步总览">
      <div className="overview-summary">
        {[
          [String(rows.length), '已登记站点'],
          [String(pendingCount), '待上传'],
          [String(healthIssues), '会话失效'],
          [String(pausedCount), '已暂停'],
        ].map(([value, label]) => (
          <div className="overview-stat" key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>

      <p className="overview-statusline">
        最近检查 {time(data?.status?.lastCheck)} · 最近上传成功 {time(data?.status?.lastSuccess)}
        {data?.status?.note ? ` · ${data.status.note}` : ''}
      </p>

      {!connected ? (
        <p className="overview-banner" role="status">
          <CloudOff size={16} aria-hidden />
          尚未连接 WebDAV，站点操作不可用。请先在「同步连接」完成配置。
        </p>
      ) : null}
      {data?.schemaWarning ? (
        <p className="overview-banner" role="alert">
          <ShieldAlert size={16} aria-hidden />
          {data.schemaWarning.message}
        </p>
      ) : null}
      {error || data?.status?.error ? (
        <p className="overview-banner is-error" role="alert">
          <CircleAlert size={16} aria-hidden />
          {error || data?.status?.error}
        </p>
      ) : null}
      {message ? <p className="overview-message" role="status">{message}</p> : null}

      <div className="overview-toolbar">
        <label className="overview-search">
          <Search size={15} aria-hidden />
          <input
            type="search"
            value={search}
            placeholder="搜索网站"
            aria-label="搜索网站"
            onChange={event => setSearch(event.target.value)}
          />
        </label>
        <div className="overview-filters" role="group" aria-label="筛选网站">
          {(
            [
              ['all', '全部'],
              ['attention', '待处理'],
              ['paused', '已暂停'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
        </div>
        <div className="overview-toolbar-actions">
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 size={14} className="mr-1 animate-spin" /> : <RefreshCw size={14} className="mr-1" />}
            刷新
          </Button>
          {bulkConfirm ? (
            <>
              <Button size="sm" disabled={bulkBusy} onClick={() => void runBulk(bulkConfirm)}>
                {bulkBusy ? '处理中…' : bulkConfirm === 'pull' ? '确认用云端覆盖全部' : '确认用本机覆盖全部'}
              </Button>
              <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={() => setBulkConfirm(undefined)}>
                取消
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={!connected || bulkBusy}
                onClick={() => setBulkConfirm('pull')}>
                <ArrowDownToLine size={14} className="mr-1" />
                拉取全部
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!connected || bulkBusy}
                onClick={() => setBulkConfirm('push')}>
                <ArrowUpFromLine size={14} className="mr-1" />
                全部上传
              </Button>
            </>
          )}
        </div>
      </div>

      {bulkConfirm ? (
        <p className="overview-note">
          {bulkConfirm === 'pull'
            ? '将用云端覆盖名单内所有开启自动拉取的网站，并刷新已打开的对应页面；本机尚未上传的改动会被放弃。'
            : '将用本机数据覆盖云端名单内所有开启自动推送的网站；云端较新的改动会被覆盖。'}
        </p>
      ) : null}

      <div className="overview-table" role="table" aria-label="网站同步状态">
        <div className="overview-row overview-head" role="row">
          <span role="columnheader">站点</span>
          <span role="columnheader">状态</span>
          <span role="columnheader">数据</span>
          <span role="columnheader">最近同步</span>
          <span role="columnheader" className="overview-actions-head">
            操作
          </span>
        </div>
        {visible.map(row => {
          const pendingKey = `${row.domain}:push`;
          const pullingKey = `${row.domain}:pull`;
          return (
            <div className="overview-row" role="row" key={row.domain} data-paused={row.paused}>
              <div className="overview-site" role="cell">
                <span className="overview-domain">{row.domain}</span>
                <span className="overview-sub">
                  {row.health ? (
                    <span className="overview-chip" data-state={row.health.state}>
                      {healthLabel(row)}
                    </span>
                  ) : null}
                  {row.truncated ? (
                    <span className="overview-chip is-warn" title={`有 ${row.truncated} 项超出同步上限，未上传`}>
                      截断 {row.truncated} 项
                    </span>
                  ) : null}
                  {row.indexedDbSkipped?.length ? (
                    <span
                      className="overview-chip is-warn"
                      title={`IndexedDB 未同步：${row.indexedDbSkipped.slice(0, 6).join('、')}`}>
                      IDB 跳过 {row.indexedDbSkipped.length} 个仓库
                    </span>
                  ) : null}
                  {row.error ? (
                    <span className="overview-chip is-warn" title={row.error}>
                      {row.error}
                    </span>
                  ) : null}
                </span>
              </div>
              <div role="cell" className="overview-state">
                <span>{stateLabel(row)}</span>
                {row.pending ? <span className="overview-pending">待上传</span> : null}
              </div>
              <div role="cell" className="overview-data">
                <span>{row.cached?.cookies ?? 0} Cookie</span>
                <span>
                  {row.cached?.localStorageItems ?? 0} 本地 · {row.cached?.sessionStorageItems ?? 0} 会话
                  {row.cached?.indexedDBRecords ? ` · ${row.cached.indexedDBRecords} IDB` : ''}
                </span>
              </div>
              <div role="cell" className="overview-times">
                <span>拉取 {time(row.lastPullAt)}</span>
                <span>推送 {time(row.lastPushAt)}</span>
              </div>
              <div role="cell" className="overview-row-actions">
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`推送 ${row.domain}`}
                  disabled={!connected || !row.listed || !!busy || bulkBusy}
                  onClick={() => void act(row, 'push')}>
                  {busy === pendingKey ? <Loader2 size={13} className="mr-1 animate-spin" /> : null}
                  {confirm === pendingKey ? '确认推送' : '推送'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`拉取 ${row.domain}`}
                  disabled={!connected || !row.listed || !!busy || bulkBusy}
                  onClick={() => void act(row, 'pull')}>
                  {busy === pullingKey ? <Loader2 size={13} className="mr-1 animate-spin" /> : null}
                  {confirm === pullingKey ? '确认拉取' : '拉取'}
                </Button>
              </div>
            </div>
          );
        })}
        {!visible.length && !loading ? (
          <p className="overview-empty">
            {rows.length
              ? '当前筛选下没有网站。'
              : '还没有登记任何网站。打开名单内的网站并保持登录，扩展会自动登记；也可以在「网站名单」手动加入。'}
          </p>
        ) : null}
      </div>

      <p className="overview-footnote">
        <Cloud size={14} aria-hidden />
        总览只读取本机记录，不会为了刷新表格而访问 WebDAV；点「推送 / 拉取」才发起一次真实请求。行内按钮需点击两次确认。
      </p>
    </div>
  );
}
