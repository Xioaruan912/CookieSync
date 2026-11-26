import { useGSAP } from '@gsap/react';
import { RuntimeMessageType, useStorageSuspense } from '@sync-your-cookie/shared';
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
  { id: 'controls', num: '01', label: '同步控制' },
  { id: 'records', num: '02', label: '运行记录' },
  { id: 'safety', num: '03', label: '回滚与诊断' },
] as const;

const syncOptions = [
  { key: 'activeDeviceSync', label: '双机自动交接', hint: '自动识别正在使用的电脑单主上传，离开 90 秒后静默待机。' },
  { key: 'backgroundSync', label: '后台自动同步', hint: '登录变化自动入队快传，定期与云端静默比对。' },
  { key: 'startupPull', label: '启动时自动拉取', hint: '打开浏览器后自动拉齐云端最新登录态。' },
  { key: 'autoDiscoverSites', label: '自动登记网站', hint: '访问名单内的网站时自动纳入同步，无需手工登记。' },
] as const;

const steps = [
  { phase: 'checking', label: '检查' },
  { phase: 'comparing', label: '比对' },
  { phase: 'uploading', label: '上传' },
] as const;

const time = (value?: number) => (value ? new Date(value).toLocaleString('zh-CN') : '尚无记录');

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

  let headline = enabled ? '后台同步已开启' : '后台同步已关闭';
  if (!connected) headline = '等待连接 WebDAV';
  else if (takingOver) headline = '正在自动交接';

  let summary = enabled ? '静默监听变化，无需手动干预。' : '自动检查已暂停，仍可手动推拉。';
  if (!connected) summary = '配置私人 WebDAV 后即刻启用自动同步。';
  else if (takingOver) summary = '正在从另一台电脑接班并对齐登录态…';
  else if (activeStep >= 0) summary = `正在${steps[activeStep].label}…`;
  else if (busy) summary = '正在完成检查…';
  else if (problem) summary = '同步待重试，可在「运行记录」查看详情。';
  else if (feedback.schemaWarning) summary = '有一条兼容性提示，可在「运行记录」查看。';
  else if (completedCheck !== undefined && (status.lastCheck ?? 0) <= completedCheck) summary = '同步检查已完成。';
  else if (status.pendingCount) summary = `${status.pendingCount} 个网站待上传。`;

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

        <nav className="auto-deck-nav" role="tablist" aria-label="自动同步分页">
          {slides.map((slide, index) => (
            <button
              key={slide.id}
              type="button"
              role="tab"
              aria-selected={slideIndex === index}
              className="auto-deck-tab"
              onClick={() => goSlide(index)}>
              <em>{slide.num}</em>
              <span>{slide.label}</span>
              {slide.id === 'records' && recordNoticeCount > 0 ? (
                <span className="auto-tab-badge" aria-label={`${recordNoticeCount} 条记录提示`}>
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
          <section className="auto-slide" role="tabpanel" aria-label="同步控制">
            <div className="auto-split">
              <div className="auto-col-left">
                <div className="auto-status-line" role="status">
                  <span className="auto-dot" data-tone={tone} aria-hidden="true" />
                  <span>{connected ? 'WebDAV 已连接' : '未连接'}</span>
                </div>

                <h2 className="auto-statement">{headline}</h2>
                <p className="auto-sub">{summary}</p>

                <ol className="auto-pipeline" aria-label="同步流程">
                  {steps.map(({ phase: step, label }, index) => (
                    <li
                      key={step}
                      className="auto-pipe-item"
                      data-state={index === activeStep ? 'active' : index < activeStep ? 'passed' : undefined}
                      aria-current={index === activeStep ? 'step' : undefined}>
                      <span className="auto-pipe-label">{label}</span>
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
                    {running ? '同步中…' : '立即检查并同步'}
                  </Button>
                ) : (
                  <Button type="button" className="auto-primary-btn" asChild>
                    <a href="#connection">配置 WebDAV</a>
                  </Button>
                )}
              </div>

              <div className="auto-col-right" aria-label="同步开关">
                {syncOptions.map(({ key, label, hint }) => (
                  <div className="auto-rule-row" key={key}>
                    <Label htmlFor={`automation-${key}`} className="auto-rule-copy">
                      <strong>{label}</strong>
                      <span>{hint}</span>
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
          <section className="auto-slide auto-slide-scroll" role="tabpanel" aria-label="运行记录">
            <div className="auto-band">
              <div className="auto-label-col">
                <h2 className="auto-label">Activity</h2>
                <p className="auto-label-sub">查看最近同步时间、异常说明与超大缓存跳过明细。</p>
              </div>

              <div className="auto-records-col">
                <dl className="auto-facts">
                  <div>
                    <dt>最近检查</dt>
                    <dd>{time(status.lastCheck)}</dd>
                  </div>
                  <div>
                    <dt>最近上传</dt>
                    <dd>{time(status.lastSuccess)}</dd>
                  </div>
                  <div>
                    <dt>同步间隔</dt>
                    <dd>{settings.syncIntervalMinutes || 2} 分钟</dd>
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
        <span>最近检查 {time(status.lastCheck)} · 间隔 {settings.syncIntervalMinutes || 2} 分钟</span>
        <div className="auto-arrows" aria-label="左右切换分页">
          <button
            type="button"
            className="auto-arrow-btn"
            aria-label="上一页"
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
            aria-label="下一页"
            disabled={slideIndex === slides.length - 1}
            onClick={() => goSlide(slideIndex + 1)}>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </footer>
    </div>
  );
}
