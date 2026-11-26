import { useGSAP } from '@gsap/react';
import { RuntimeMessageType, useStorageSuspense } from '@sync-your-cookie/shared';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { Button, Input } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import { Cloud, CloudOff, Laptop, Pencil, RefreshCw } from 'lucide-react';
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
  const [completed, setCompleted] = useState(0);
  const localName = status.localDeviceName || '本机';
  const handoverEnabled = settings.activeDeviceSync !== false;
  const standby = handoverEnabled && status.deviceRole === 'standby';
  const localActive = handoverEnabled && status.deviceRole === 'active';
  const takingOver = starting || status.deviceRole === 'taking-over' || status.phase === 'taking-over';
  const peer =
    connected && status.activeDeviceId && status.activeDeviceId !== status.localDeviceId ? status.activeDeviceName : '';
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
  const title = !connected
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
        gsap
          .timeline({ defaults: { duration: 0.24, ease: 'power3.out', clearProps: 'transform,opacity' } })
          .from('.overview-node-local', { y: 7, opacity: 0.72 })
          .from('.overview-node-cloud', { y: 4, opacity: 0.76 }, 0.045)
          .from('.overview-node-peer', { y: 5, opacity: 0.78 }, 0.075);
      });
      return () => media.revert();
    },
    { scope: hero },
  );

  useGSAP(
    () => {
      if (!completed) return;
      const media = gsap.matchMedia();
      media.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.fromTo(
          '.overview-cloud-halo',
          { opacity: 0.85, scale: 0.78 },
          {
            opacity: 0,
            scale: 1.43,
            duration: 0.52,
            ease: 'power3.out',
            clearProps: 'transform,opacity',
          },
        );
      });
      return () => media.revert();
    },
    { scope: hero, dependencies: [completed], revertOnUpdate: true },
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
      setCompleted(time => time + 1);
      toast.success(response.msg || '已完成接班同步');
      await onSync();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '接班同步失败');
    } finally {
      setStarting(false);
    }
  };

  return (
    <section
      ref={hero}
      className="overview-hero"
      aria-label="双机连接"
      data-flow={flow}
      data-connected={connected}
      data-peer={!!peer}>
      <div className="overview-hero-copy">
        <h2 aria-live="polite">{title}</h2>
        <div className="overview-hero-status">
          <span
            className="overview-status-dot"
            data-tone={connected ? (status.error ? 'warn' : 'live') : 'muted'}
            aria-hidden="true"
          />
          {connected ? lastSyncText : '等待配置'}
        </div>
        {connected ? (
          <Button
            className="overview-control overview-takeover rounded-full"
            onClick={() => void takeOver()}
            disabled={takingOver || busy}>
            <RefreshCw size={15} aria-hidden="true" />
            接班同步
          </Button>
        ) : (
          <Button className="overview-control overview-takeover rounded-full" asChild>
            <a href="#connection">配置 WebDAV</a>
          </Button>
        )}
      </div>

      <div className="overview-topology">
        <div className="overview-node overview-node-local" data-emphasis={connected && localActive}>
          <Laptop size={27} aria-hidden="true" />
          <button
            type="button"
            className="overview-device-name"
            onClick={() => setDraft(localName)}
            aria-label={`修改设备名，当前为 ${localName}`}>
            <span>{localName}</span>
            <Pencil size={12} aria-hidden="true" />
          </button>
          <span className="overview-node-role">
            {connected && standby ? '本机 · 待机' : connected && localActive ? '本机 · 活跃' : '本机'}
          </span>
        </div>
        <span className="overview-rail overview-rail-local" aria-hidden="true">
          <span className="overview-pulse" />
        </span>
        <div className="overview-node-cloud">
          <span className="overview-cloud-symbol">
            <span className="overview-cloud-halo" aria-hidden="true" />
            {connected ? <Cloud size={26} aria-hidden="true" /> : <CloudOff size={26} aria-hidden="true" />}
          </span>
          <strong>WebDAV</strong>
        </div>
        <span className="overview-rail overview-rail-peer" aria-hidden="true">
          <span className="overview-pulse" />
        </span>
        <div className="overview-node overview-node-peer" data-emphasis={!!peer}>
          <Laptop size={27} aria-hidden="true" />
          <strong title={peer || undefined}>{peer || '另一台设备'}</strong>
          <span className="overview-node-role">{peer ? '活跃设备' : '未识别'}</span>
        </div>
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
            <Button type="submit" className="rounded-full" disabled={saving || !draft.trim()}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </form>
        </OverviewDialog>
      ) : null}
    </section>
  );
}
