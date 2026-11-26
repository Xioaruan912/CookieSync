import { useGSAP } from '@gsap/react';
import { RuntimeMessageType, useLocale, useStorageSuspense } from '@sync-your-cookie/shared';
import { accountStorage, isLegacyProvider } from '@sync-your-cookie/storage/lib/accountStorage';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { syncFeedbackStorage } from '@sync-your-cookie/storage/lib/syncFeedbackStorage';
import {
  storageTruncationStorage,
  summarizeStorageTruncation,
  type StorageLimitIssue,
} from '@sync-your-cookie/storage/lib/syncRuntimeStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { Button, Label, Switch } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { Suspense, useRef, useState } from 'react';
import { SafetyCard } from './SafetyCard';

gsap.registerPlugin(useGSAP);

const slides = [
  { id: 'controls', num: '01', label: '同步控制', enLabel: 'Controls' },
  { id: 'records', num: '02', label: '运行记录', enLabel: 'Activity' },
  { id: 'safety', num: '03', label: '回滚与诊断', enLabel: 'Recovery' },
] as const;

const syncOptions = [
  {
    key: 'activeDeviceSync',
    label: '双机自动交接',
    enLabel: 'Dual-PC Auto Handover',
    hint: '自动识别正在使用的电脑单主上传，离开 90 秒后静默待机。',
    enHint: 'Single-writer upload on your active PC; automatically idles to standby after 90s.',
  },
  {
    key: 'backgroundSync',
    label: '后台自动同步',
    enLabel: 'Background Auto-Sync',
    hint: '登录变化自动入队快传，定期与云端静默比对。',
    enHint: 'Queues login changes automatically and compares quietly with cloud snapshots.',
  },
  {
    key: 'startupPull',
    label: '启动时自动拉取',
    enLabel: 'Pull on Startup',
    hint: '打开浏览器后自动拉齐云端最新登录态。',
    enHint: 'Restores the latest cloud login sessions when Chrome starts.',
  },
  {
    key: 'autoDiscoverSites',
    label: '自动登记网站',
    enLabel: 'Auto-Discover Sites',
    hint: '访问名单内的网站时自动纳入同步，无需手工登记。',
    enHint: 'Automatically registers visited allowlisted sites for sync.',
  },
] as const;

const steps = [
  { phase: 'checking', label: '检查', enLabel: 'Check' },
  { phase: 'comparing', label: '比对', enLabel: 'Compare' },
  { phase: 'uploading', label: '上传', enLabel: 'Upload' },
] as const;

const formatTime = (isEn: boolean, value?: number) =>
  value ? new Date(value).toLocaleString(isEn ? 'en-US' : 'zh-CN') : isEn ? 'No record' : '尚无记录';

function formatBytes(bytes: number) {
  const unit = bytes >= 1024 * 1024 ? 'MiB' : bytes >= 1024 ? 'KiB' : 'B';
  const divisor = unit === 'MiB' ? 1024 * 1024 : unit === 'KiB' ? 1024 : 1;
  return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(bytes / divisor)} ${unit}`;
}

function limitLabel(issue: StorageLimitIssue) {
  if (issue.reason === 'invalid') return '无法读取此条目';
  if (issue.reason === 'item-count') return `每来源最多 ${issue.limit} 项`;
  if (issue.reason === 'item-bytes') return `单项上限 ${formatBytes(issue.limit)}`;
  const subject = issue.reason === 'site-bytes' ? '站点合计上限' : '来源容量上限';
  return `${subject} ${formatBytes(issue.limit)}，本次剩余 ${formatBytes(issue.remaining ?? 0)}`;
}

export function AutoSyncStatus() {
  const { isEn, t } = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const slideDir = useRef(0);
  const account = useStorageSuspense(accountStorage);
  const webdav = useStorageSuspense(webdavStorage);
  const status = useStorageSuspense(autoSyncStatusStorage);
  const settings = useStorageSuspense(settingsStorage);
  const feedback = useStorageSuspense(syncFeedbackStorage);
  const truncation = useStorageSuspense(storageTruncationStorage);
  const truncatedSites = Object.entries(summarizeStorageTruncation(truncation));
  const [slideIndex, setSlideIndex] = useState(0);
  const [rechecking, setRechecking] = useState(false);
  const [recheckResult, setRecheckResult] = useState<{ message: string; error?: boolean }>();
  const [checkBeforeRequest, setCheckBeforeRequest] = useState<number>();
  const [error, setError] = useState('');
  const [completedCheck, setCompletedCheck] = useState<number>();

  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add('(prefers-reduced-motion: no-preference)', () => {
        gsap
          .timeline({ defaults: { ease: 'power3.out', clearProps: 'transform,opacity' } })
          .from('.auto-display-title', { yPercent: 105, duration: 0.52 })
          .from('.auto-slide', { y: 12, opacity: 0, duration: 0.36 }, 0.14);
      });
      return () => media.revert();
    },
    { scope: rootRef },
  );

  useGSAP(
    () => {
      const dir = slideDir.current;
      slideDir.current = 0;
      if (!dir || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      gsap.fromTo(
        '.auto-slide',
        { x: dir * 44, opacity: 0 },
        { x: 0, opacity: 1, duration: 0.3, ease: 'power3.out', clearProps: 'transform,opacity', overwrite: 'auto' },
      );
    },
    { scope: rootRef, dependencies: [slideIndex], revertOnUpdate: true },
  );

  const goSlide = (next: number) => {
    const clamped = Math.max(0, Math.min(slides.length - 1, next));
    if (clamped === slideIndex) return;
    slideDir.current = clamped > slideIndex ? 1 : -1;
    setSlideIndex(clamped);
  };

  const connected =
    !isLegacyProvider(account) && !!webdav.url?.trim() && !!webdav.username?.trim() && !!webdav.password;
  const enabled = settings.backgroundSync !== false;
  const takingOver = status.phase === 'taking-over';
  const busy = checkBeforeRequest !== undefined;
  const waitingForWorker =
    busy && (!status.phase || status.phase === 'idle') && (status.lastCheck ?? 0) === checkBeforeRequest;
  const phase = waitingForWorker ? 'checking' : status.phase;
  const activeStep = connected ? steps.findIndex(step => step.phase === phase) : -1;
  const running = connected && (activeStep >= 0 || takingOver || busy);
  const problem = error || (connected ? status.error : '');

  let headline = enabled ? t('后台同步已开启', 'Background Sync Active') : t('后台同步已关闭', 'Background Sync Paused');
  if (!connected) headline = t('等待连接 WebDAV', 'Waiting for WebDAV');
  else if (takingOver) headline = t('正在自动交接', 'Handing Over Session');

  let summary = enabled
    ? t('静默监听变化，无需手动干预。', 'Quietly watching session changes — no manual action needed.')
    : t('自动检查已暂停，仍可手动推拉。', 'Automatic checks are paused. Manual push & pull remain available.');
  if (!connected) summary = t('配置私人 WebDAV 后即刻启用自动同步。', 'Connect your private WebDAV server to enable automatic sync.');
  else if (takingOver) summary = t('正在从另一台电脑接班并对齐登录态…', 'Taking over from your peer device and aligning sessions…');
  else if (activeStep >= 0) summary = isEn ? `${steps[activeStep].enLabel}ing…` : `正在${steps[activeStep].label}…`;
  else if (busy) summary = t('正在完成检查…', 'Finishing check…');
  else if (problem) summary = t('同步待重试，可在「运行记录」查看详情。', 'Sync retry pending. Check Activity for details.');
  else if (feedback.schemaWarning) summary = t('有一条兼容性提示，可在「运行记录」查看。', 'Compatibility notice available in Activity.');
  else if (completedCheck !== undefined && (status.lastCheck ?? 0) <= completedCheck)
    summary = t('同步检查已完成。', 'Sync check completed.');
  else if (status.pendingCount)
    summary = t(`${status.pendingCount} 个网站待上传。`, `${status.pendingCount} site(s) queued to upload.`);

  let tone: 'ready' | 'running' | 'warning' | 'muted' = connected && enabled ? 'ready' : 'muted';
  if (running) tone = 'running';
  else if (problem || feedback.schemaWarning) tone = 'warning';

  const recordNoticeCount = truncatedSites.length || (problem || feedback.schemaWarning ? 1 : 0);

  const recheck = async () => {
    setRechecking(true);
    setRecheckResult(undefined);
    try {
      const response = await chrome.runtime.sendMessage({ type: RuntimeMessageType.RecheckStorageLimits });
      if (!response?.isOk) throw new Error(response?.msg || '复查失败，请重试');
      const { checkedSites, remaining } = response.result as { checkedSites: number; remaining: number };
      setRecheckResult({
        message: checkedSites
          ? `已复查 ${checkedSites} 个网站。${remaining ? `还有 ${remaining} 个网站留有超限记录。` : '超限记录已清除。'}`
          : '请打开有超限记录的网站，再复查。',
      });
    } catch (cause) {
      setRecheckResult({ error: true, message: cause instanceof Error ? cause.message : '复查失败，请重试' });
    } finally {
      setRechecking(false);
    }
  };

  const sync = async () => {
    setCheckBeforeRequest(status.lastCheck ?? 0);
    setError('');
    setCompletedCheck(undefined);
    try {
      const response = await chrome.runtime.sendMessage({ type: RuntimeMessageType.RunAutomaticSync });
      if (!response?.isOk) throw new Error(response?.msg || '同步任务未启动');
      const latest = await autoSyncStatusStorage.get();
      if (!latest.error) setCompletedCheck(latest.lastCheck ?? 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '同步任务未启动');
    } finally {
      setCheckBeforeRequest(undefined);
    }
  };

  return (
    <div ref={rootRef} className="auto-stage">
      {/* Top Bar */}
      <header className="auto-top-bar">
        <div className="auto-title-mask">
          <h1 id="settings-title" className="auto-display-title">
            Automation
          </h1>
        </div>

        <nav className="auto-deck-nav" role="tablist" aria-label={t('自动同步分页', 'Automation tabs')}>
          {slides.map((slide, index) => (
            <button
              key={slide.id}
              type="button"
              role="tab"
              aria-selected={slideIndex === index}
              className="auto-deck-tab"
              onClick={() => goSlide(index)}>
              <em>{slide.num}</em>
              <span>{isEn ? slide.enLabel : slide.label}</span>
              {slide.id === 'records' && recordNoticeCount > 0 ? (
                <span className="auto-tab-badge" aria-label={t(`${recordNoticeCount} 条记录提示`, `${recordNoticeCount} notices`)}>
                  {recordNoticeCount}
                </span>
              ) : null}
            </button>
          ))}
        </nav>
      </header>

      {/* Zero-Scroll Horizontal Slide Viewport */}
      <div className="auto-viewport">
        {slideIndex === 0 ? (
          <section className="auto-slide" role="tabpanel" aria-label={t('同步控制', 'Controls')}>
            <div className="auto-split">
              <div className="auto-col-left">
                <div className="auto-status-line" role="status">
                  <span className="auto-dot" data-tone={tone} aria-hidden="true" />
                  <span>{connected ? t('WebDAV 已连接', 'WebDAV Connected') : t('未连接', 'Not Connected')}</span>
                </div>

                <h2 className="auto-statement">{headline}</h2>
                <p className="auto-sub">{summary}</p>

                <ol className="auto-pipeline" aria-label={t('同步流程', 'Sync pipeline')}>
                  {steps.map(({ phase: step, label, enLabel }, index) => (
                    <li
                      key={step}
                      className="auto-pipe-item"
                      data-state={index === activeStep ? 'active' : index < activeStep ? 'passed' : undefined}
                      aria-current={index === activeStep ? 'step' : undefined}>
                      <span className="auto-pipe-label">{isEn ? enLabel : label}</span>
                      {index < steps.length - 1 ? (
                        <span
                          className="auto-pipe-dots"
                          data-flow={running && index <= Math.max(0, activeStep) ? 'true' : undefined}
                          aria-hidden="true">
                          <i />
                          <i />
                          <i />
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>

                {connected ? (
                  <Button
                    type="button"
                    className="auto-primary-btn"
                    disabled={!enabled || running}
                    onClick={() => void sync()}>
                    <RefreshCw size={14} className={running ? 'auto-spinning' : undefined} aria-hidden="true" />
                    {running ? t('同步中…', 'Syncing…') : t('立即检查并同步', 'Check & Sync Now')}
                  </Button>
                ) : (
                  <Button type="button" className="auto-primary-btn" asChild>
                    <a href="#connection">{t('配置 WebDAV', 'Set up WebDAV')}</a>
                  </Button>
                )}
              </div>

              <div className="auto-col-right" aria-label={t('同步开关', 'Sync toggles')}>
                {syncOptions.map(({ key, label, enLabel, hint, enHint }) => (
                  <div className="auto-rule-row" key={key}>
                    <Label htmlFor={`automation-${key}`} className="auto-rule-copy">
                      <strong>{isEn ? enLabel : label}</strong>
                      <span>{isEn ? enHint : hint}</span>
                    </Label>
                    <Switch
                      id={`automation-${key}`}
                      checked={settings[key] !== false}
                      onCheckedChange={checked => void settingsStorage.update({ [key]: checked })}
                    />
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : slideIndex === 1 ? (
          <section className="auto-slide auto-slide-scroll" role="tabpanel" aria-label={t('运行记录', 'Activity')}>
            <div className="auto-band">
              <div className="auto-label-col">
                <h2 className="auto-label">Activity</h2>
                <p className="auto-label-sub">
                  {t('查看最近同步时间、异常说明与超大缓存跳过明细。', 'Inspect recent sync timestamps, alerts, and skipped oversized storage items.')}
                </p>
              </div>

              <div className="auto-records-col">
                <dl className="auto-facts">
                  <div>
                    <dt>{t('最近检查', 'Last check')}</dt>
                    <dd>{formatTime(isEn, status.lastCheck)}</dd>
                  </div>
                  <div>
                    <dt>{t('最近上传', 'Last upload')}</dt>
                    <dd>{formatTime(isEn, status.lastSuccess)}</dd>
                  </div>
                  <div>
                    <dt>{t('同步间隔', 'Interval')}</dt>
                    <dd>
                      {settings.syncIntervalMinutes || 2} {t('分钟', 'min')}
                    </dd>
                  </div>
                </dl>

                {problem ? (
                  <p className="auto-alert" role="alert">
                    {problem}
                  </p>
                ) : null}

                {feedback.schemaWarning ? (
                  <p className="auto-alert" role="alert">
                    {feedback.schemaWarning.message}
                  </p>
                ) : null}

                {status.note ? <p className="auto-note">{status.note}</p> : null}

                {truncatedSites.length > 0 ? (
                  <div className="auto-limits">
                    <h3>{truncatedSites.length} 个网站已跳过超限缓存（不影响登录同步）</h3>
                    <ul>
                      {truncatedSites.map(([site, count]) => {
                        const entry = truncation[site];
                        const details =
                          typeof entry === 'object'
                            ? Object.entries(entry.origins).flatMap(([origin, data]) =>
                                (['local', 'session'] as const).flatMap(area =>
                                  (data.details?.[area] || []).map((issue, index) => ({ origin, area, issue, index })),
                                ),
                              )
                            : [];
                        return (
                          <li key={site}>
                            <div className="auto-limit-head">
                              <strong>{site}</strong>
                              <span>{count} 项</span>
                            </div>
                            {details.length ? (
                              <ul className="auto-limit-details">
                                {details.map(({ origin, area, issue, index }) => (
                                  <li key={`${origin}|${area}|${index}`}>
                                    <span>
                                      {area === 'local' ? 'LocalStorage' : 'SessionStorage'}
                                      {issue.reason !== 'invalid' ? ` · ${formatBytes(issue.bytes)}` : ''}
                                    </span>
                                    <span>{origin}</span>
                                    <span>{limitLabel(issue)}</span>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                    <Button
                      type="button"
                      variant="outline"
                      className="auto-outline-btn"
                      disabled={rechecking}
                      onClick={() => void recheck()}>
                      {rechecking ? '正在复查…' : '复查已打开的网站'}
                    </Button>
                  </div>
                ) : null}

                {recheckResult ? (
                  <p className={recheckResult.error ? 'auto-alert' : 'auto-note'} role={recheckResult.error ? 'alert' : 'status'}>
                    {recheckResult.message}
                  </p>
                ) : null}
              </div>
            </div>
          </section>
        ) : (
          <section className="auto-slide auto-slide-scroll" role="tabpanel" aria-label="回滚与诊断">
            <div className="auto-band">
              <div className="auto-label-col">
                <h2 className="auto-label">Recovery</h2>
                <p className="auto-label-sub">批量操作前自动留档本地回滚点，支持云端历史备份恢复与脱敏诊断导出。</p>
              </div>
              <Suspense fallback={<p className="auto-note">正在加载诊断…</p>}>
                <SafetyCard />
              </Suspense>
            </div>
          </section>
        )}
      </div>

      {/* Bottom Rail */}
      <footer className="auto-bottom-rail">
        <span>
          {t('最近检查', 'Last check')} {formatTime(isEn, status.lastCheck)} · {t('间隔', 'Interval')}{' '}
          {settings.syncIntervalMinutes || 2} {t('分钟', 'min')}
        </span>
        <div className="auto-arrows" aria-label={t('左右切换分页', 'Switch pages')}>
          <button
            type="button"
            className="auto-arrow-btn"
            aria-label={t('上一页', 'Previous')}
            disabled={slideIndex === 0}
            onClick={() => goSlide(slideIndex - 1)}>
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <span className="auto-counter">
            0{slideIndex + 1} / 0{slides.length}
          </span>
          <button
            type="button"
            className="auto-arrow-btn"
            aria-label={t('下一页', 'Next')}
            disabled={slideIndex === slides.length - 1}
            onClick={() => goSlide(slideIndex + 1)}>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </footer>
    </div>
  );
}
