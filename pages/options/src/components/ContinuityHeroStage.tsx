import { useGSAP } from '@gsap/react';
import { RuntimeMessageType, siteProfileFor, useStorageSuspense } from '@sync-your-cookie/shared';
import { autoSyncStatusStorage } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { domainConfigStorage } from '@sync-your-cookie/storage/lib/domainConfigStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { siteHealthStorage } from '@sync-your-cookie/storage/lib/siteHealthStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { Button } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Cloud,
  Laptop,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

const profile115 = siteProfileFor('115.com') || {
  domain: '115.com',
  loginKeys: ['UID', 'CID', 'SEID', 'KID', 'USERSESSIONID'],
};

gsap.registerPlugin(ScrollTrigger, useGSAP);

interface ContinuityHeroStageProps {
  onNavigate: (section: 'overview' | 'connection' | 'automation' | 'sites' | 'about') => void;
  onDockChange?: (docked: boolean) => void;
}

export function ContinuityHeroStage({ onNavigate, onDockChange }: ContinuityHeroStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLElement>(null);
  const status = useStorageSuspense(autoSyncStatusStorage);
  const settings = useStorageSuspense(settingsStorage);
  const config = useStorageSuspense(domainConfigStorage);
  const health = useStorageSuspense(siteHealthStorage);
  const webdav = useStorageSuspense(webdavStorage);

  const [takingOver, setTakingOver] = useState(false);
  const [verifying115, setVerifying115] = useState(false);
  const [bulkBusy, setBulkBusy] = useState<'pull' | 'push' | undefined>();
  const [bulkArm, setBulkArm] = useState<'pull' | 'push' | undefined>();
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');

  const connected = !!webdav.url?.trim() && !!webdav.username?.trim() && !!webdav.password;
  const registeredCount = Object.keys(config.domainMap || {}).length;
  const pendingCount = status.pendingCount || 0;
  const guardedCount = status.guardedDomains?.length || 0;
  const role = status.deviceRole || 'active';
  const localName = status.localDeviceName || '本机 Chrome';
  const activeName = status.activeDeviceName || localName;
  const isOwner = role !== 'standby' && (!status.activeDeviceId || status.activeDeviceId === status.localDeviceId);
  const health115 = health[profile115.domain];
  const state115 = health115?.state;
  const has115Missing = health115?.loginKeysMissing === true;

  // Stage 4 Hero-First Choreography + Scene 2 ScrollTrigger Continuity Dock
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(
        {
          isDesktop: '(min-width: 820px)',
          isMobile: '(max-width: 819px)',
          reduceMotion: '(prefers-reduced-motion: reduce)',
        },
        context => {
          const { isDesktop, reduceMotion } = context.conditions || {};

          if (reduceMotion) {
            gsap.set('.hero-lead, .hero-shield, .hero-metric, .key-pill', { autoAlpha: 1, y: 0, scale: 1 });
            return;
          }

          // Scene 1: Non-uniform shrinking stagger (Lead -> Support -> Key Matrix)
          const entrance = gsap.timeline({ defaults: { ease: 'power3.out' } });
          entrance
            .from('.hero-lead', { y: isDesktop ? 20 : 12, scale: 0.985, autoAlpha: 0, duration: 0.52 })
            .from('.hero-shield', { y: isDesktop ? 16 : 10, scale: 0.988, autoAlpha: 0, duration: 0.46 }, 0.07)
            .from('.hero-metric', { y: 14, autoAlpha: 0, duration: 0.4, stagger: { each: 0.055, ease: 'power2.out' } }, 0.13)
            .from('.key-pill', { scale: 0.9, autoAlpha: 0, duration: 0.3, stagger: { each: 0.04, ease: 'power2.out' } }, 0.22);

          // Scene 2: Scroll-scrubbed Hero compression + header live capsule reveal
          if (isDesktop && stageRef.current) {
            gsap.to('.hero-bento-grid', {
              scale: 0.972,
              y: -10,
              opacity: 0.88,
              ease: 'none',
              scrollTrigger: {
                trigger: stageRef.current,
                start: 'top 76px',
                end: 'bottom 76px',
                scrub: 0.55,
                onUpdate: self => onDockChange?.(self.progress > 0.35),
              },
            });
          } else if (stageRef.current) {
            ScrollTrigger.create({
              trigger: stageRef.current,
              start: 'bottom 84px',
              onEnter: () => onDockChange?.(true),
              onLeaveBack: () => onDockChange?.(false),
            });
          }
        },
        stageRef,
      );

      document.fonts?.ready.then(() => ScrollTrigger.refresh());
      return () => mm.revert();
    },
    { scope: stageRef },
  );

  // Smooth odometer animation when registered site count updates
  useEffect(() => {
    const el = countRef.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = String(registeredCount);
      return;
    }
    const obj = { value: Number(el.textContent) || 0 };
    const tween = gsap.to(obj, {
      value: registeredCount,
      duration: 0.65,
      ease: 'power2.out',
      onUpdate: () => {
        el.textContent = String(Math.round(obj.value));
      },
    });
    return () => {
      tween.kill();
    };
  }, [registeredCount]);

  // Pointer-tracked specular highlight for Titanium Bento surfaces
  const handleCardPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    event.currentTarget.style.setProperty('--mx', `${x.toFixed(1)}%`);
    event.currentTarget.style.setProperty('--my', `${y.toFixed(1)}%`);
  };

  const handleTakeoverNow = async () => {
    if (!connected) {
      onNavigate('connection');
      return;
    }
    setTakingOver(true);
    try {
      const response = await chrome.runtime.sendMessage({ type: RuntimeMessageType.TakeoverNow });
      if (!response?.isOk) throw new Error(response?.msg || '接班同步失败');
      toast.success(response.msg || '已完成双机接班同步');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '接班同步失败');
    } finally {
      setTakingOver(false);
    }
  };

  const handleBulk = async (mode: 'pull' | 'push') => {
    if (bulkArm !== mode) {
      setBulkArm(mode);
      setTimeout(() => setBulkArm(prev => (prev === mode ? undefined : prev)), 4500);
      return;
    }
    setBulkArm(undefined);
    setBulkBusy(mode);
    try {
      const response = await chrome.runtime.sendMessage({
        type: mode === 'pull' ? RuntimeMessageType.PullAll : RuntimeMessageType.PushAll,
      });
      if (!response?.isOk) throw new Error(response?.msg || '批量同步失败');
      toast.success(mode === 'pull' ? '已从云端拉取全部网站' : '已向云端上传全部网站');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '批量同步失败');
    } finally {
      setBulkBusy(undefined);
    }
  };

  const handleVerify115 = async () => {
    setVerifying115(true);
    try {
      const response = await chrome.runtime.sendMessage({
        type: RuntimeMessageType.CheckSiteHealth,
        domain: profile115.domain,
      });
      if (!response?.isOk) throw new Error(response?.msg || '验证失败');
      toast.success('已完成 115 会话检测');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '115 会话验证失败');
    } finally {
      setVerifying115(false);
    }
  };

  const saveDeviceName = async () => {
    const trimmed = draftName.trim();
    if (!trimmed) {
      setEditingName(false);
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({ type: RuntimeMessageType.RenameDevice, name: trimmed });
      if (!res?.isOk) throw new Error(res?.msg || '改名失败');
      toast.success(`本机已命名为「${trimmed}」`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存设备名失败');
    } finally {
      setEditingName(false);
    }
  };

  const roleHeadline = !connected
    ? '配置 WebDAV，开启双机无感交接'
    : role === 'taking-over'
      ? '正在从另一台电脑接班同步…'
      : isOwner
        ? '双机无缝交接已就绪'
        : `当前由「${activeName}」当家`;

  const roleSummary = !connected
    ? '填好私人 WebDAV 地址后，两台 Windows Chrome 会自动识别你正在用哪台，换电脑打开即登录。'
    : status.note
      ? status.note
      : isOwner
        ? '关键登录 5 秒自动上云，随时可关浏览器；离开 90 秒自动传完并进入静默护航。'
        : '本机已自动进入静默待机，不上传旧数据，并已暂停后台 115 心跳防止互踢。';

  return (
    <section ref={stageRef} className="hero-bento-stage" aria-label="双机同步核心舞台">
      <div className="hero-bento-grid">
        {/* 7-Col Obsidian Dual-PC Continuity Bento Tile */}
        <div
          className="hero-lead obsidian-bento bento-lift"
          onPointerMove={handleCardPointerMove}
          data-role={role}>
          <div className="obsidian-sheen" aria-hidden="true" />
          <div className="obsidian-top">
            <span className="status-pill-dark">
              <span
                className="live-orb"
                data-state={!connected ? 'warn' : role === 'standby' ? 'standby' : 'live'}
                aria-hidden="true"
              />
              {!connected
                ? '等待连接 WebDAV'
                : role === 'taking-over'
                  ? '正在接班同步'
                  : isOwner
                    ? '本机当家 · 自动同步中'
                    : '静默待机 · 防覆盖保护中'}
            </span>

            {editingName ? (
              <form
                className="device-rename-form"
                onSubmit={e => {
                  e.preventDefault();
                  void saveDeviceName();
                }}>
                <input
                  autoFocus
                  value={draftName}
                  maxLength={32}
                  onChange={e => setDraftName(e.target.value)}
                  onBlur={() => void saveDeviceName()}
                  placeholder="例如：家里电脑"
                  aria-label="本机名称"
                />
                <button type="submit" aria-label="保存设备名">
                  <Check size={13} />
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="device-chip"
                title="点击给这台电脑起个名字（如：公司电脑 / 家里电脑）"
                onClick={() => {
                  setDraftName(localName);
                  setEditingName(true);
                }}>
                <Laptop size={13} aria-hidden="true" />
                <span>{localName}</span>
                <Pencil size={11} className="opacity-60" aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="obsidian-main">
            <h1>{roleHeadline}</h1>
            <p>{roleSummary}</p>

            {/* Live Dual-PC Continuity SVG Bridge */}
            <div className="continuity-bridge" aria-hidden="true">
              <div className="bridge-node" data-active={isOwner}>
                <Laptop size={15} />
                <span>{localName}</span>
              </div>
              <div className="bridge-track" data-flowing={connected && (status.phase !== 'idle' || isOwner)}>
                <svg viewBox="0 0 200 32" preserveAspectRatio="none">
                  <path
                    d="M 4 16 C 60 3, 140 29, 196 16"
                    stroke="rgba(255,255,255,0.16)"
                    strokeWidth="1.8"
                    fill="none"
                  />
                  <path
                    className="bridge-beam"
                    d="M 4 16 C 60 3, 140 29, 196 16"
                    stroke={role === 'standby' ? '#FF9F0A' : '#38BDF8'}
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    fill="none"
                  />
                </svg>
              </div>
              <div className="bridge-node" data-active={connected}>
                <Cloud size={15} />
                <span>{connected ? (settings.encryptionEnabled ? 'WebDAV · 已加密' : 'WebDAV 云端') : '未配置'}</span>
              </div>
            </div>
          </div>

          <div className="obsidian-actions">
            <Button
              size="sm"
              className="apple-pill-primary"
              disabled={takingOver}
              onClick={() => void handleTakeoverNow()}>
              {takingOver ? (
                <Loader2 size={14} className="mr-1.5 animate-spin" />
              ) : (
                <RefreshCw size={14} className="mr-1.5" />
              )}
              {!connected ? '去配置 WebDAV' : takingOver ? '正在接班…' : '立即接班同步'}
            </Button>

            {connected ? (
              <>
                <Button
                  size="sm"
                  className="apple-pill-glass"
                  disabled={!!bulkBusy}
                  onClick={() => void handleBulk('pull')}>
                  {bulkBusy === 'pull' ? (
                    <Loader2 size={14} className="mr-1.5 animate-spin" />
                  ) : (
                    <ArrowDownToLine size={14} className="mr-1.5" />
                  )}
                  {bulkArm === 'pull' ? '再点确认覆盖本机' : '拉取全部'}
                </Button>
                <Button
                  size="sm"
                  className="apple-pill-glass"
                  disabled={!!bulkBusy}
                  onClick={() => void handleBulk('push')}>
                  {bulkBusy === 'push' ? (
                    <Loader2 size={14} className="mr-1.5 animate-spin" />
                  ) : (
                    <ArrowUpFromLine size={14} className="mr-1.5" />
                  )}
                  {bulkArm === 'push' ? '再点确认覆盖云端' : '全部上传'}
                </Button>
              </>
            ) : null}
          </div>
        </div>

        {/* 5-Col 115 Five-Layer Shield Bento Tile */}
        <div
          className="hero-shield titanium-tile bento-lift"
          onPointerMove={handleCardPointerMove}
          data-state={has115Missing ? 'invalid' : state115 || 'idle'}>
          <div className="tile-sheen" aria-hidden="true" />
          <div className="shield-head">
            <span
              className="shield-pill"
              data-state={has115Missing ? 'invalid' : state115 || 'unknown'}>
              {state115 === 'ok' && !has115Missing ? (
                <ShieldCheck size={14} aria-hidden="true" />
              ) : state115 === 'invalid' || has115Missing ? (
                <ShieldAlert size={14} aria-hidden="true" />
              ) : (
                <ShieldQuestion size={14} aria-hidden="true" />
              )}
              {has115Missing
                ? '115 缺少核心凭证（已拦截覆盖）'
                : state115 === 'ok'
                  ? `115.com 会话有效${health115?.userName ? ` · ${health115.userName}` : ''}`
                  : state115 === 'invalid'
                    ? '115.com 会话已失效'
                    : '115.com 护盾就绪'}
            </span>
          </div>

          <div className="shield-body">
            <h2>115 五重防掉线护盾</h2>
            <p>
              {health115?.message ||
                '核心凭证不全自动拦住不覆盖云端；恢复前先清冲突旧残渣；不关机电脑待机时自动休眠 115 后台页，避免双端心跳互踢。'}
            </p>

            <div className="key-matrix" aria-label="115 必需登录凭证">
              {profile115.loginKeys.map(key => (
                <span
                  key={key}
                  className="key-pill"
                  data-healthy={!has115Missing && state115 !== 'invalid'}>
                  {key}
                </span>
              ))}
            </div>
          </div>

          <div className="shield-foot">
            <span className="shield-meta">
              {settings.discardIdleSingleSessionTabs !== false
                ? status.discardedTabsCount
                  ? `已休眠护航 ${status.discardedTabsCount} 个 115 标签页`
                  : '闲置休眠防互踢已开启'
                : '闲置休眠保护已关闭'}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="titanium-link-btn"
                disabled={verifying115}
                onClick={() => void handleVerify115()}>
                {verifying115 ? '验证中…' : '立即验证'}
              </button>
              <button
                type="button"
                className="titanium-link-btn"
                onClick={() => onNavigate('automation')}>
                扫码修复 →
              </button>
            </div>
          </div>
        </div>

        {/* Bottom 3-Col Bento Metric Odometer Tiles */}
        <div className="hero-metric titanium-stat bento-lift" onPointerMove={handleCardPointerMove}>
          <div className="tile-sheen" aria-hidden="true" />
          <div className="stat-top">
            <span>已保护网站</span>
            {pendingCount > 0 ? <em className="stat-badge-amber">{pendingCount} 待上传</em> : <em className="stat-badge-ok">已对齐</em>}
          </div>
          <strong ref={countRef}>{registeredCount}</strong>
          <small>打开名单内网站自动登记，无需手工维护</small>
        </div>

        <div className="hero-metric titanium-stat bento-lift" onPointerMove={handleCardPointerMove}>
          <div className="tile-sheen" aria-hidden="true" />
          <div className="stat-top">
            <span>关键登录快传</span>
            <Zap size={14} className="text-primary" aria-hidden="true" />
          </div>
          <strong>{settings.activeDeviceSync !== false ? '5 秒' : `${settings.syncIntervalMinutes || 2} 分钟`}</strong>
          <small>登完 115 / 小红书 / 抖音几秒上云，随时可关浏览器</small>
        </div>

        <div className="hero-metric titanium-stat bento-lift" onPointerMove={handleCardPointerMove}>
          <div className="tile-sheen" aria-hidden="true" />
          <div className="stat-top">
            <span>坏数据拦截 & 待机护航</span>
            <em className={guardedCount > 0 ? 'stat-badge-amber' : 'stat-badge-ok'}>
              {guardedCount > 0 ? `已拦 ${guardedCount} 站` : '运行中'}
            </em>
          </div>
          <strong>{settings.activeDeviceSync !== false ? '双机单主' : '常规模式'}</strong>
          <small>
            {guardedCount > 0
              ? `已保护 ${status.guardedDomains?.join('、')} 不被残缺态覆盖`
              : '离开 90 秒自动闭嘴，绝不反冲覆盖另一台电脑'}
          </small>
        </div>
      </div>
    </section>
  );
}
