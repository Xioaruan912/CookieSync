import { useGSAP } from '@gsap/react';
import { useLocale, type OverviewRow } from '@sync-your-cookie/shared';
import { Button } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import { ArrowDownToLine, ArrowUpFromLine, Loader2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { TransferDirection } from './DeviceStatus';

gsap.registerPlugin(useGSAP);

export const siteNeedsAttention = (site: OverviewRow) =>
  site.attention.some(hint => hint !== 'paused' && hint !== 'truncated') || !!site.error || !!site.retryError;

const rulesLabel = (site: OverviewRow, isEn: boolean) => {
  if (!site.listed) return isEn ? 'Unlisted' : '名单外';
  if (site.paused) return isEn ? 'Paused' : '已暂停';
  if (site.autoPull && site.autoPush) return isEn ? 'Two-way sync' : '双向同步';
  return site.autoPush ? (isEn ? 'Auto-push only' : '仅自动推送') : isEn ? 'Auto-pull only' : '仅自动拉取';
};

export function SiteState({ site, connected }: { site: OverviewRow; connected: boolean }) {
  const { isEn } = useLocale();
  let badge = { label: rulesLabel(site, isEn), tone: 'muted' };
  if (site.listed && !site.paused) {
    if (site.uploadState === 'uploading') badge = { label: isEn ? 'Uploading' : '上传中', tone: 'uploading' };
    else if (site.uploadState === 'retry' && site.autoPush) badge = { label: isEn ? 'Retry pending' : '失败待重试', tone: 'warn' };
    else if (site.error) badge = { label: isEn ? 'Sync error' : '同步异常', tone: 'warn' };
    else if (site.health?.state === 'invalid') badge = { label: isEn ? 'Session expired' : '会话失效', tone: 'warn' };
    else if (!connected) badge = { label: isEn ? 'Waiting' : '等待连接', tone: 'muted' };
    else if (site.pending && site.autoPush) badge = { label: isEn ? 'Queued' : '排队', tone: 'pending' };
    else if (site.lastPushAt || site.lastPullAt) badge = { label: isEn ? 'Synced' : '已同步', tone: 'live' };
  }
  return (
    <span className="overview-site-state" data-tone={badge.tone}>
      <span className="overview-status-dot" data-tone={badge.tone} aria-hidden="true" />
      {badge.label}
    </span>
  );
}

const displayDate = (isEn: boolean, time?: number) =>
  time
    ? new Intl.DateTimeFormat(isEn ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(
        time,
      )
    : isEn
      ? 'No record'
      : '尚无记录';

type DetailTab = 'state' | 'storage' | 'history' | 'issues';

const detailTabs: [DetailTab, string, string][] = [
  ['state', '状态', 'Status'],
  ['storage', '存储', 'Storage'],
  ['history', '记录', 'History'],
  ['issues', '异常', 'Issues'],
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
  const { isEn, t } = useLocale();
  const section = useRef<HTMLDivElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const lastAction = useRef<TransferDirection>();
  const slideDir = useRef(animate ? 1 : 0);
  const [tab, setTab] = useState<DetailTab>('state');
  const [confirm, setConfirm] = useState<TransferDirection>();
  const healthProblem =
    site.health?.state === 'invalid' || site.health?.state === 'unknown' || site.health?.loginKeysMissing
      ? site.health.message
      : undefined;
  const issues = [site.retryError || site.error, healthProblem].filter(Boolean);
  const hasIssues = issues.length > 0;
  const skippedCount = site.truncated || 0;
  const skippedIdb = site.indexedDbSkipped || [];
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

  const healthLabel =
    site.health?.state === 'ok'
      ? t('有效', 'Valid')
      : site.health?.state === 'invalid'
        ? t('失效', 'Expired')
        : t('未验证', 'Unchecked');
  const rows =
    tab === 'storage'
      ? [
          ['Cookie', site.cached?.cookies ?? 0],
          [t('本地存储', 'LocalStorage'), site.cached?.localStorageItems ?? 0],
          [t('会话存储', 'SessionStorage'), site.cached?.sessionStorageItems ?? 0],
          ['IndexedDB', site.cached?.indexedDBRecords ?? 0],
          ...(skippedCount > 0 ? [[t('已跳过超大缓存', 'Skipped oversized items'), t(`${skippedCount} 项（不影响登录）`, `${skippedCount} items (login unaffected)`)]] : []),
          ...(skippedIdb.length > 0 ? [[t('已跳过 IDB 仓库', 'Skipped IDB stores'), skippedIdb.join(', ')]] : []),
        ]
      : tab === 'history'
        ? [
            [t('最近推送', 'Last push'), displayDate(isEn, site.lastPushAt)],
            [t('最近拉取', 'Last pull'), displayDate(isEn, site.lastPullAt)],
          ]
        : [
            [t('同步状态', 'Sync status'), <SiteState site={site} connected={connected} />],
            [t('同步方向', 'Sync mode'), rulesLabel(site, isEn)],
            [t('最近同步', 'Last sync'), displayDate(isEn, Math.max(site.lastPushAt || 0, site.lastPullAt || 0))],
            ...(site.health ? [[t('登录状态', 'Session health'), healthLabel]] : []),
          ];

  const visibleTabs = detailTabs.filter(([key]) => key !== 'issues' || hasIssues);

  return (
    <div ref={section} className="overview-inspector-inner">
      <div className="overview-inspector-site">
        <span className="ov-inspector-eyebrow">Inspector</span>
        <strong title={site.domain}>{site.domain}</strong>
      </div>

      <div className="overview-segment" role="group" aria-label={t('详情分组', 'Detail tabs')}>
        {visibleTabs.map(([key, label, enLabel], index) => (
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
            {isEn ? enLabel : label}
          </button>
        ))}
      </div>

      <div className="overview-inspector-body">
        {confirm ? (
          <p role="status" className="overview-confirm-text">
            {confirm === 'push'
              ? t('将当前站点的数据合并到云端。', 'Merge this site’s local session into the cloud snapshot.')
              : t('将把云端数据应用到本机，并刷新该站点已打开的页面。', 'Restore the cloud session locally and reload open tabs for this site.')}
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
              {working ? t('处理中…', 'Working…') : confirm === 'push' ? t('确认推送', 'Confirm Push') : t('确认拉取', 'Confirm Pull')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="ov-btn-outline"
              disabled={!!working}
              onClick={() => setConfirm(undefined)}>
              {t('取消', 'Cancel')}
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
              {t('推送到云端', 'Push to Cloud')}
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
              {t('拉取到本机', 'Pull to Device')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
