import { useGSAP } from '@gsap/react';
import type { OverviewRow } from '@sync-your-cookie/shared';
import { Button } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import { ArrowDownToLine, ArrowUpFromLine, Loader2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { TransferDirection } from './DeviceStatus';

gsap.registerPlugin(useGSAP);

export const siteNeedsAttention = (site: OverviewRow) => site.attention.some(hint => hint !== 'paused') || !!site.error;

const rulesLabel = (site: OverviewRow) => {
  if (!site.listed) return '名单外';
  if (site.paused) return '已暂停';
  if (site.autoPull && site.autoPush) return '双向同步';
  return site.autoPush ? '仅自动推送' : '仅自动拉取';
};

export function SiteState({ site, connected }: { site: OverviewRow; connected: boolean }) {
  let badge = { label: rulesLabel(site), tone: 'muted' };
  if (site.listed && !site.paused) {
    if (site.uploadState === 'uploading') badge = { label: '上传中', tone: 'uploading' };
    else if (site.uploadState === 'retry' && site.autoPush) badge = { label: '失败待重试', tone: 'warn' };
    else if (site.error) badge = { label: '同步异常', tone: 'warn' };
    else if (site.health?.state === 'invalid') badge = { label: '会话失效', tone: 'warn' };
    else if (!connected) badge = { label: '等待连接', tone: 'muted' };
    else if (site.pending && site.autoPush) badge = { label: '排队', tone: 'pending' };
    else if (site.truncated || site.indexedDbSkipped?.length) badge = { label: '待处理', tone: 'pending' };
    else if (site.lastPushAt || site.lastPullAt) badge = { label: '已同步', tone: 'live' };
  }
  return (
    <span className="overview-site-state" data-tone={badge.tone}>
      <span className="overview-status-dot" data-tone={badge.tone} aria-hidden="true" />
      {badge.label}
    </span>
  );
}

const displayDate = (time?: number) =>
  time
    ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(
        time,
      )
    : '尚无记录';

type DetailTab = 'state' | 'storage' | 'history' | 'issues';

const detailTabs: [DetailTab, string][] = [
  ['state', '状态'],
  ['storage', '存储'],
  ['history', '记录'],
  ['issues', '异常'],
];

interface Props {
  site: OverviewRow;
  connected: boolean;
  blocked: boolean;
  working?: TransferDirection;
  animate?: boolean;
  onTransfer: (direction: TransferDirection) => Promise<void>;
}

export function OverviewSiteDetails({ site, connected, blocked, working, animate, onTransfer }: Props) {
  const section = useRef<HTMLDivElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const lastAction = useRef<TransferDirection>();
  const slideDir = useRef(animate ? 1 : 0);
  const [tab, setTab] = useState<DetailTab>('state');
  const [confirm, setConfirm] = useState<TransferDirection>();
  const issues = [
    site.retryError || site.error,
    site.health?.message,
    site.truncated && `${site.truncated} 项存储超出同步上限`,
    site.indexedDbSkipped?.length && `未同步的 IndexedDB 仓库：${site.indexedDbSkipped.join('、')}`,
  ].filter(Boolean);
  const hasIssues = issues.length > 0;
  const disabled = !connected || !site.listed || blocked;

  useLayoutEffect(() => {
    if (confirm) confirmButton.current?.focus({ preventScroll: true });
    else if (lastAction.current) {
      section.current
        ?.querySelector<HTMLElement>(`[data-action="${lastAction.current}"]`)
        ?.focus({ preventScroll: true });
      lastAction.current = undefined;
    }
  }, [confirm]);

  // Smooth horizontal slide when switching detail sub-tabs
  useGSAP(
    () => {
      const dir = slideDir.current;
      slideDir.current = 0;
      if (!dir || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      gsap.fromTo(
        '.overview-inspector-body',
        { x: dir * 24, opacity: 0 },
        {
          x: 0,
          opacity: 1,
          duration: 0.24,
          ease: 'power3.out',
          clearProps: 'transform,opacity',
          overwrite: 'auto',
        },
      );
    },
    { scope: section, dependencies: [tab], revertOnUpdate: true },
  );

  const complete = async () => {
    if (!confirm || disabled) return;
    await onTransfer(confirm);
    setConfirm(undefined);
  };

  const healthLabel = site.health?.state === 'ok' ? '有效' : site.health?.state === 'invalid' ? '失效' : '未验证';
  const rows =
    tab === 'storage'
      ? [
          ['Cookie', site.cached?.cookies ?? 0],
          ['本地存储', site.cached?.localStorageItems ?? 0],
          ['会话存储', site.cached?.sessionStorageItems ?? 0],
          ['IndexedDB', site.cached?.indexedDBRecords ?? 0],
        ]
      : tab === 'history'
        ? [
            ['最近推送', displayDate(site.lastPushAt)],
            ['最近拉取', displayDate(site.lastPullAt)],
          ]
        : [
            ['同步状态', <SiteState site={site} connected={connected} />],
            ['同步方向', rulesLabel(site)],
            ['最近同步', displayDate(Math.max(site.lastPushAt || 0, site.lastPullAt || 0))],
            ...(site.health ? [['登录状态', healthLabel]] : []),
          ];

  const visibleTabs = detailTabs.filter(([key]) => key !== 'issues' || hasIssues);

  return (
    <div ref={section} className="overview-inspector-inner">
      <div className="overview-inspector-site">
        <span className="ov-inspector-eyebrow">Inspector</span>
        <strong title={site.domain}>{site.domain}</strong>
      </div>

      <div className="overview-segment" role="group" aria-label="详情分组">
        {visibleTabs.map(([key, label], index) => (
          <button
            type="button"
            key={key}
            aria-pressed={tab === key}
            onClick={event => {
              const curIdx = visibleTabs.findIndex(([k]) => k === tab);
              slideDir.current = event.detail > 0 ? (index >= curIdx ? 1 : -1) : 0;
              setTab(key);
              setConfirm(undefined);
            }}>
            {label}
          </button>
        ))}
      </div>

      <div className="overview-inspector-body">
        {confirm ? (
          <p role="status" className="overview-confirm-text">
            {confirm === 'push' ? '将当前站点的数据合并到云端。' : '将把云端数据应用到本机，并刷新该站点已打开的页面。'}
          </p>
        ) : tab === 'issues' && hasIssues ? (
          <ul className="overview-issues">
            {issues.map((issue, index) => (
              <li key={index}>{issue}</li>
            ))}
          </ul>
        ) : (
          <dl className="overview-detail-list">
            {rows.map(([label, value]) => (
              <div key={String(label)}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div className="overview-inspector-actions">
        {confirm ? (
          <>
            <Button
              ref={confirmButton}
              size="sm"
              className="ov-btn-primary"
              disabled={disabled}
              onClick={() => void complete()}>
              {working ? <Loader2 className="overview-spinner" size={14} aria-hidden="true" /> : null}
              {working ? '处理中…' : confirm === 'push' ? '确认推送' : '确认拉取'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="ov-btn-outline"
              disabled={!!working}
              onClick={() => setConfirm(undefined)}>
              取消
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              className="ov-btn-primary"
              disabled={disabled}
              data-action="push"
              onClick={() => {
                lastAction.current = 'push';
                setConfirm('push');
              }}>
              <ArrowUpFromLine size={14} aria-hidden="true" />
              推送到云端
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="ov-btn-outline"
              disabled={disabled}
              data-action="pull"
              onClick={() => {
                lastAction.current = 'pull';
                setConfirm('pull');
              }}>
              <ArrowDownToLine size={14} aria-hidden="true" />
              拉取到本机
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
