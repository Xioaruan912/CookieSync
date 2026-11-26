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
import {
  Activity,
  ArrowDownToLine,
  ArrowRightLeft,
  Clock3,
  CloudUpload,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { OverviewDialog } from './OverviewDialog';
import { SafetyCard } from './SafetyCard';

const syncOptions = [
  { key: 'activeDeviceSync', label: '双机自动交接', icon: ArrowRightLeft },
  { key: 'backgroundSync', label: '后台自动同步', icon: Activity },
  { key: 'startupPull', label: '启动时自动拉取', icon: ArrowDownToLine },
  { key: 'autoDiscoverSites', label: '自动登记网站', icon: Search },
] as const;

const steps = [
  { phase: 'checking', label: '检查', icon: Search },
  { phase: 'comparing', label: '比对', icon: SlidersHorizontal },
  { phase: 'uploading', label: '上传', icon: CloudUpload },
] as const;

const time = (value?: number) => (value ? new Date(value).toLocaleString() : '尚无记录');
const narrowLayout = '(max-width: 730px)';

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
  const account = useStorageSuspense(accountStorage);
  const webdav = useStorageSuspense(webdavStorage);
  const status = useStorageSuspense(autoSyncStatusStorage);
  const settings = useStorageSuspense(settingsStorage);
  const feedback = useStorageSuspense(syncFeedbackStorage);
  const truncation = useStorageSuspense(storageTruncationStorage);
  const truncatedSites = Object.entries(summarizeStorageTruncation(truncation));
  const [dialog, setDialog] = useState<{ kind: 'records' | 'safety'; sheet: boolean }>();
  const [rechecking, setRechecking] = useState(false);
  const [recheckResult, setRecheckResult] = useState<{ message: string; error?: boolean }>();
  const [checkBeforeRequest, setCheckBeforeRequest] = useState<number>();
  const [error, setError] = useState('');
  const [completedCheck, setCompletedCheck] = useState<number>();
  const [narrow, setNarrow] = useState(() => window.matchMedia(narrowLayout).matches);

  useEffect(() => {
    const media = window.matchMedia(narrowLayout);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

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
  if (!connected) headline = '等待连接';
  else if (takingOver) headline = '正在自动交接';

  let summary = enabled ? '等待变化' : '自动检查已暂停';
  if (!connected) summary = '配置 WebDAV 后即可同步';
  else if (takingOver) summary = '正在接班同步';
  else if (activeStep >= 0) summary = `正在${steps[activeStep].label}`;
  else if (busy) summary = '正在完成检查';
  else if (problem) summary = '同步待重试';
  else if (feedback.schemaWarning) summary = '有一条兼容性提示';
  else if (completedCheck !== undefined && (status.lastCheck ?? 0) <= completedCheck) summary = '同步检查已完成';
  else if (status.pendingCount) summary = `${status.pendingCount} 个网站待上传`;

  let tone = connected && enabled ? 'ready' : 'muted';
  if (running) tone = 'running';
  else if (problem || feedback.schemaWarning) tone = 'warning';

  const open = (kind: 'records' | 'safety') => {
    setDialog({ kind, sheet: narrow });
  };

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

  const rulesPanel = (
    <section key="rules" className="automation-rules titanium-panel-card" aria-labelledby="automation-rules-title">
      <h2 id="automation-rules-title">同步开关</h2>
      <div>
        {syncOptions.map(({ key, label, icon: Icon }) => (
          <div className="automation-rule" key={key}>
            <Label htmlFor={`automation-${key}`}>
              <Icon size={17} aria-hidden="true" />
              {label}
            </Label>
            <Switch
              id={`automation-${key}`}
              checked={settings[key] !== false}
              onCheckedChange={checked => void settingsStorage.update({ [key]: checked })}
            />
          </div>
        ))}
      </div>
    </section>
  );

  const syncPanel = (
    <section key="sync" className="automation-stage" aria-labelledby="automation-stage-title">
      <div className="automation-stage-head">
        <h2 id="automation-stage-title">{headline}</h2>
        <div className="automation-stage-status" data-tone={tone} role="status">
          <i aria-hidden="true" />
          <span key={summary}>{summary}</span>
        </div>
        {connected ? (
          <Button className="automation-primary" size="sm" disabled={!enabled || running} onClick={() => void sync()}>
            <RefreshCw size={15} className={running ? 'automation-spinning' : undefined} aria-hidden="true" />
            {running ? '同步中…' : '立即检查并同步'}
          </Button>
        ) : (
          <Button className="automation-primary" size="sm" asChild>
            <a href="#connection">配置 WebDAV</a>
          </Button>
        )}
      </div>

      <ol className="automation-path" aria-label="同步流程">
        {steps.map(({ phase: step, label, icon: Icon }, index) => (
          <li
            key={step}
            data-step={step}
            data-state={index === activeStep ? 'active' : index < activeStep ? 'passed' : undefined}
            aria-current={index === activeStep ? 'step' : undefined}>
            <div className="automation-path-node">
              <Icon size={20} aria-hidden="true" />
              {label}
            </div>
            {index < steps.length - 1 && (
              <div className="automation-wire" data-flow={index + 1 === activeStep || undefined} aria-hidden="true" />
            )}
          </li>
        ))}
      </ol>

      <div className="automation-actions">
        <Button type="button" variant="ghost" size="sm" aria-haspopup="dialog" onClick={() => open('records')}>
          <Clock3 size={16} aria-hidden="true" />
          运行记录
          {(truncatedSites.length > 0 || problem || feedback.schemaWarning) && (
            <span className="automation-notice">
              <span className="sr-only">
                {truncatedSites.length ? `，${truncatedSites.length} 个网站有超限记录` : '，有待查看的提示'}
              </span>
              {truncatedSites.length ? (
                <span aria-hidden="true">{truncatedSites.length}</span>
              ) : (
                <i aria-hidden="true" />
              )}
            </span>
          )}
        </Button>
        <Button type="button" variant="ghost" size="sm" aria-haspopup="dialog" onClick={() => open('safety')}>
          <ShieldCheck size={16} aria-hidden="true" />
          回滚与诊断
        </Button>
      </div>
    </section>
  );

  return (
    <>
      <div className="automation-heading">
        <h1 id="settings-title" className="workspace-title">
          自动同步
        </h1>
        {connected && (
          <span className="automation-connection">
            <i aria-hidden="true" />
            WebDAV 已连接
          </span>
        )}
      </div>
      <div className="automation-workspace">{narrow ? [syncPanel, rulesPanel] : [rulesPanel, syncPanel]}</div>

      {dialog && (
        <OverviewDialog
          title={dialog.kind === 'records' ? '运行记录' : '回滚与诊断'}
          sheet={dialog.sheet}
          onClose={() => setDialog(undefined)}>
          <div className="automation-dialog-body">
            {dialog.kind === 'records' ? (
              <>
                <dl className="automation-record-facts">
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
                {problem && (
                  <p className="automation-record-alert" role="alert">
                    {problem}
                  </p>
                )}
                {feedback.schemaWarning && (
                  <p className="automation-record-alert" role="alert">
                    {feedback.schemaWarning.message}
                  </p>
                )}
                {status.note && <p>{status.note}</p>}
                {truncatedSites.length > 0 && (
                  <section className="automation-limits" aria-labelledby="automation-limits-title">
                    <h3 id="automation-limits-title">{truncatedSites.length} 个网站有存储项超出同步上限</h3>
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
                            <div className="automation-limit-heading">
                              <span>{site}</span>
                              <strong>{count} 项</strong>
                            </div>
                            {!!details.length && (
                              <ul className="automation-limit-details">
                                {details.map(({ origin, area, issue, index }) => (
                                  <li key={`${origin}|${area}|${index}`}>
                                    <strong>
                                      {area === 'local' ? 'LocalStorage' : 'SessionStorage'}
                                      {issue.reason !== 'invalid' ? ` · ${formatBytes(issue.bytes)}` : ''}
                                    </strong>
                                    <span>{origin}</span>
                                    <span>{limitLabel(issue)}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {details.length < count && (
                              <p className="automation-limit-summary">
                                {details.length
                                  ? `另有 ${count - details.length} 项未列出`
                                  : '打开对应的网页后复查可查看明细'}
                              </p>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={rechecking}
                      onClick={() => void recheck()}>
                      {rechecking ? '正在复查…' : '复查已打开的网站'}
                    </Button>
                  </section>
                )}
                {recheckResult && (
                  <p
                    className={recheckResult.error ? 'automation-record-alert' : undefined}
                    role={recheckResult.error ? 'alert' : 'status'}>
                    {recheckResult.message}
                  </p>
                )}
              </>
            ) : (
              <Suspense fallback={<p role="status">正在加载诊断…</p>}>
                <SafetyCard />
              </Suspense>
            )}
          </div>
        </OverviewDialog>
      )}
    </>
  );
}
