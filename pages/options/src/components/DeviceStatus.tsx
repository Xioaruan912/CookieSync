import { useGSAP } from '@gsap/react';
import { RuntimeMessageType, useStorageSuspense } from '@sync-your-cookie/shared';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { Button, Input } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import { Pencil, RefreshCw, Smartphone } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { OverviewDialog } from './OverviewDialog';

gsap.registerPlugin(useGSAP);

export type TransferDirection = 'push' | 'pull';

interface Props {
  connected: boolean;
  operation?: TransferDirection;
  busy: boolean;
  onSync: () => Promise<void>;
}

export function DeviceStatus({ connected, operation, busy, onSync }: Props) {
  const hero = useRef<HTMLElement>(null);
  const status = useStorageSuspense(autoSyncStatusStorage);
  const settings = useStorageSuspense(settingsStorage);
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);

  const localName = status.localDeviceName || '本机';
  const handoverEnabled = settings.activeDeviceSync !== false;
  const standby = handoverEnabled && status.deviceRole === 'standby';
  const localActive = handoverEnabled && status.deviceRole === 'active';
  const takingOver = starting || status.deviceRole === 'taking-over' || status.phase === 'taking-over';
  const peer =
    connected && status.activeDeviceId && status.activeDeviceId !== status.localDeviceId ? status.activeDeviceName : '';
  const mobileActive =
    connected &&
    !!status.activeMobileDeviceName &&
    (!status.activeMobileLeaseAt || Date.now() - status.activeMobileLeaseAt < 24 * 60 * 60 * 1000);
  const mobileName = mobileActive ? status.activeMobileDeviceName : '';

  const flow = !connected
    ? undefined
    : operation ||
      (takingOver
        ? 'pull'
        : status.phase === 'uploading'
          ? 'push'
          : status.phase === 'checking' || status.phase === 'comparing'
            ? 'check'
            : undefined);

  const roleText = !connected
    ? '未连接 WebDAV'
    : takingOver
      ? '正在接班'
      : flow === 'push'
        ? '正在推送'
        : flow === 'pull'
          ? '正在拉取'
          : flow === 'check'
            ? '正在检查'
            : standby
              ? '本机待机'
              : localActive
                ? status.lastTakeoverAt
                  ? '本机已接班'
                  : '本机活跃'
                : '本机同步';

  const lastSync = [status.lastSuccess, status.lastTakeoverAt].reduce<number>(
    (latest, time) => Math.max(latest, time || 0),
    0,
  );
  const lastSyncText = lastSync
    ? `最近同步 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(lastSync)}`
    : '尚无同步记录';

  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.from('.ov-display-title', {
          yPercent: 105,
          duration: 0.52,
          ease: 'power3.out',
          clearProps: 'transform',
        });
      });
      return () => media.revert();
    },
    { scope: hero },
  );

  const rename = async () => {
    const name = draft?.trim();
    if (!name || saving) return;
    setSaving(true);
    try {
      const response = await chrome.runtime.sendMessage({ type: RuntimeMessageType.RenameDevice, name });
      if (!response?.isOk) throw new Error(response?.msg || '保存设备名失败');
      setDraft(undefined);
      toast.success('设备名已保存');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存设备名失败');
    } finally {
      setSaving(false);
    }
  };

  const takeOver = async () => {
    if (takingOver || busy) return;
    setStarting(true);
    try {
      const response = await chrome.runtime.sendMessage({ type: RuntimeMessageType.TakeoverNow });
      if (!response?.isOk) throw new Error(response?.msg || '接班同步失败');
      toast.success(response.msg || '已完成接班同步');
      await onSync();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '接班同步失败');
    } finally {
      setStarting(false);
    }
  };

  return (
    <header
      ref={hero}
      className="overview-hero"
      aria-label="双机连接"
      data-flow={flow}
      data-connected={connected}
      data-peer={!!peer}>
      <div className="ov-title-block">
        <div className="ov-title-mask">
          <h1 id="settings-title" className="ov-display-title">
            Overview
          </h1>
        </div>
        <div className="overview-hero-status" aria-live="polite">
          <span
            className="overview-status-dot"
            data-tone={connected ? (status.error ? 'warn' : flow ? 'uploading' : 'live') : 'muted'}
            aria-hidden="true"
          />
          <span>
            {roleText}
            {connected ? ` · ${lastSyncText}` : ''}
          </span>
          {mobileName ? (
            <span
              className="ml-2 inline-flex items-center gap-1 rounded-full border border-[var(--sbo-line)] px-2.5 py-0.5 text-[11.5px] text-[var(--sbo-ink)]"
              title="手机端独立槽位在线，与主机并行同步互不干扰">
              <Smartphone size={11} aria-hidden="true" />
              <span>{mobileName}</span>
              <span className="text-[var(--sbo-ok)]">在线</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="ov-continuity-right">
        <div className="overview-topology">
          <button
            type="button"
            className="ov-device-btn"
            onClick={() => setDraft(localName)}
            aria-label={`修改设备名，当前为 ${localName}`}>
            <span>{localName}</span>
            <Pencil size={12} aria-hidden="true" />
          </button>
          <span className="ov-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="ov-cloud-label">WebDAV</span>
          <span className="ov-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="ov-peer-label" data-emphasis={!!peer || undefined} title={peer || undefined}>
            {peer || '另一台设备'}
          </span>
        </div>

        {connected ? (
          <Button
            className="overview-takeover"
            onClick={() => void takeOver()}
            disabled={takingOver || busy}>
            <RefreshCw size={14} className={takingOver ? 'overview-spinner' : undefined} aria-hidden="true" />
            接班同步
          </Button>
        ) : (
          <Button className="overview-takeover" asChild>
            <a href="#connection">配置 WebDAV</a>
          </Button>
        )}
      </div>

      {draft !== undefined ? (
        <OverviewDialog title="修改设备名" onClose={() => setDraft(undefined)}>
          <form
            className="overview-rename-form"
            onSubmit={event => {
              event.preventDefault();
              void rename();
            }}>
            <Input
              aria-label="本机名称"
              data-initial-focus
              value={draft}
              onChange={event => setDraft(event.target.value)}
            />
            <Button type="submit" className="ov-btn-primary" disabled={saving || !draft.trim()}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </form>
        </OverviewDialog>
      ) : null}
    </header>
  );
}
