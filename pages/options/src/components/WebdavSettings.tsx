import { useGSAP } from '@gsap/react';
import {
  buildWebdavUrl,
  decodePairingCode,
  encodePairingCode,
  isLikelyGatewayWebdavUrl,
  probeWebdavCompatibility,
  useLocale,
  useStorageSuspense,
} from '@sync-your-cookie/shared';
import { accountStorage, isLegacyProvider } from '@sync-your-cookie/storage/lib/accountStorage';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { webdavCloudStorage, webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { Button, Input, Label, Switch } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import { Check, ChevronLeft, ChevronRight, Copy, Eye, EyeOff, Loader2, QrCode, TriangleAlert } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfigChannelSettings } from './ConfigChannelSettings';
import { ConnectionGuide } from './ConnectionGuide';
import { OverviewDialog } from './OverviewDialog';

gsap.registerPlugin(useGSAP);

const probeKey = 'cookiesync-webdav-probe-ok';
const probeLabels = [
  ['创建', 'Create'],
  ['覆盖', 'Overwrite'],
  ['读取', 'Read'],
  ['删除', 'Delete'],
] as const;

const slides = [
  { id: 'credentials', num: '01', label: '连接与凭据', enLabel: 'Credentials' },
  { id: 'channel', num: '02', label: '同步通道', enLabel: 'Sync Channel' },
  { id: 'options', num: '03', label: '高级选项', enLabel: 'Options' },
] as const;

const presets = [
  { label: '坚果云', enLabel: 'Jianguoyun', url: 'https://dav.jianguoyun.com/dav/', path: 'CookieSync/cookies.txt', unsafe: false },
  {
    label: 'Nextcloud',
    enLabel: 'Nextcloud',
    url: 'https://cloud.example.com/remote.php/dav/files/user/',
    path: 'CookieSync/cookies.txt',
    unsafe: false,
  },
  {
    label: 'OpenList',
    enLabel: 'OpenList',
    url: 'https://openlist.example.com/dav/',
    path: 'CookieSync/cookies.txt',
    unsafe: true,
  },
  { label: 'AList', enLabel: 'AList', url: 'https://alist.example.com/dav/', path: 'CookieSync/cookies.txt', unsafe: true },
] as const;

type ProbePhase = 'idle' | 'running' | 'ok' | 'error';

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl.trim()).host;
  } catch {
    return '';
  }
}

export function WebdavSettings() {
  const { isEn, t } = useLocale();
  const rootRef = useRef<HTMLDivElement>(null);
  const slideDir = useRef(0);
  const account = useStorageSuspense(accountStorage);
  const saved = useStorageSuspense(webdavStorage);
  const cloud = useStorageSuspense(webdavCloudStorage);
  const settings = useStorageSuspense(settingsStorage);
  const [slideIndex, setSlideIndex] = useState(0);
  const [syncConfig, setSyncConfig] = useState(cloud.enabled);
  const [config, setConfig] = useState(saved);
  const [dirty, setDirty] = useState(false);
  const [busyMode, setBusyMode] = useState<'save' | 'test'>();
  const [showPassword, setShowPassword] = useState(false);
  const [probeAt, setProbeAt] = useState(0);
  const [probePhase, setProbePhase] = useState<ProbePhase>('idle');
  const [probeStep, setProbeStep] = useState(-1);
  const [probeMessage, setProbeMessage] = useState('');
  const [pairOpen, setPairOpen] = useState(false);
  const [pairQrUrl, setPairQrUrl] = useState('');
  const [pairInput, setPairInput] = useState('');

  useEffect(() => {
    if (!dirty) {
      setConfig(saved);
      setSyncConfig(cloud.enabled);
    }
  }, [saved, cloud.enabled, dirty]);

  useEffect(() => {
    const read = () => {
      void chrome.storage.local
        .get(probeKey)
        .then(value => setProbeAt(Number(value[probeKey]) || 0))
        .catch(() => {});
    };
    read();
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[probeKey]) read();
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, []);

  // Opening curtain reveal
  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add('(prefers-reduced-motion: no-preference)', () => {
        gsap
          .timeline({ defaults: { ease: 'power3.out', clearProps: 'transform,opacity' } })
          .from('.sbo-display-title', { yPercent: 105, duration: 0.52 })
          .from('.sbo-slide', { y: 12, opacity: 0, duration: 0.36 }, 0.14);
      });
      return () => media.revert();
    },
    { scope: rootRef },
  );

  // Silky horizontal slide transition on deck switch
  useGSAP(
    () => {
      const dir = slideDir.current;
      slideDir.current = 0;
      if (!dir || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      gsap.fromTo(
        '.sbo-slide',
        { x: dir * 44, opacity: 0 },
        { x: 0, opacity: 1, duration: 0.32, ease: 'power3.out', clearProps: 'transform,opacity', overwrite: 'auto' },
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

  const legacy = isLegacyProvider(account);
  const connected = !legacy && !!saved.url.trim() && !!saved.username.trim() && !!saved.password;
  const host = hostOf(config.url || saved.url);
  const lowerUrl = config.url.trim().toLowerCase();
  const isHttps = lowerUrl.startsWith('https://');
  const isHttp = lowerUrl.startsWith('http://');

  const urlCheck = useMemo(() => {
    const url = config.url.trim();
    const path = config.path.trim();
    if (!url) return { valid: false, preview: '', error: '' };
    try {
      return { valid: true, preview: buildWebdavUrl({ ...config, url, path: path || 'sync-your-cookie.txt' }), error: '' };
    } catch (error) {
      return { valid: false, preview: '', error: error instanceof Error ? error.message : '地址格式无效' };
    }
  }, [config]);

  const update = (key: keyof typeof config, value: string) => {
    setDirty(true);
    setConfig(current => ({
      ...current,
      [key]: value,
      ...(key === 'url' && !current.allowUnsafeWrites && isLikelyGatewayWebdavUrl(value)
        ? { allowUnsafeWrites: true }
        : {}),
    }));
  };

  const applyPreset = (preset: (typeof presets)[number]) => {
    setDirty(true);
    setConfig(current => ({
      ...current,
      url: preset.url,
      path: current.path.trim() ? current.path : preset.path,
      allowUnsafeWrites: preset.unsafe,
    }));
    toast.info(t(`已填入 ${preset.label} 模板地址`, `Applied ${preset.enLabel} template`));
  };

  const run = async (save: boolean) => {
    setBusyMode(save ? 'save' : 'test');
    setProbeMessage('');
    let timer: ReturnType<typeof setInterval> | undefined;
    setProbePhase('running');
    setProbeStep(0);
    timer = setInterval(() => setProbeStep(step => (step < 3 ? step + 1 : step)), 240);
    try {
      let normalized = {
        ...config,
        url: config.url.trim(),
        username: config.username.trim(),
        path: config.path.trim(),
        ...(isLikelyGatewayWebdavUrl(config.url) && !config.allowUnsafeWrites ? { allowUnsafeWrites: true } : {}),
      };
      buildWebdavUrl(normalized);
      const probe = await probeWebdavCompatibility(normalized);
      const autoSwitched = probe.compatibilityRequired && !config.allowUnsafeWrites;
      if (probe.compatibilityRequired && !normalized.allowUnsafeWrites) {
        normalized = { ...normalized, allowUnsafeWrites: true };
      }
      if (autoSwitched) {
        setConfig(current => ({ ...current, allowUnsafeWrites: true }));
      }
      if (save) {
        await webdavStorage.update(normalized, syncConfig);
        setDirty(false);
        await cookieStorage.reset();
        await accountStorage.update({ selectedProvider: 'webdav' });
        await chrome.storage.local.set({ [probeKey]: Date.now() });
        setProbePhase('ok');
        setProbeStep(3);
        const msg = autoSwitched
          ? t('检测到 OpenList / AList 网关，已自动开启兼容模式并保存配置', 'Detected OpenList / AList gateway — auto-enabled compatibility mode & saved')
          : t('配置已保存并验证通过', 'WebDAV configuration verified and saved');
        setProbeMessage(msg);
        toast.success(msg);
      } else {
        if (autoSwitched && connected && saved.url.trim() === normalized.url) {
          await webdavStorage.update({ ...saved, allowUnsafeWrites: true }, syncConfig);
          setDirty(false);
        } else if (autoSwitched) {
          setDirty(true);
        }
        await chrome.storage.local.set({ [probeKey]: Date.now() });
        setProbePhase('ok');
        setProbeStep(3);
        const msg = autoSwitched
          ? t('检测到 OpenList / AList 不支持条件写入，已自动开启「网关兼容模式」并通过四项权限验证', 'Detected OpenList / AList — auto-enabled Gateway Compatibility Mode & passed all checks')
          : t('创建、覆盖、读取、删除四项权限均已通过', 'Create, overwrite, read, and delete checks all passed');
        setProbeMessage(msg);
        toast.success(msg);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : t('WebDAV 操作失败', 'WebDAV operation failed');
      setProbePhase('error');
      setProbeMessage(message);
      toast.error(message);
    } finally {
      if (timer) clearInterval(timer);
      setBusyMode(undefined);
    }
  };

  const busy = !!busyMode;
  const verified = probePhase === 'ok' || (probePhase === 'idle' && probeAt > 0 && connected);
  const tone =
    busyMode === 'test' || busyMode === 'save'
      ? 'running'
      : probePhase === 'error'
        ? 'error'
        : legacy || dirty
          ? 'warn'
          : connected
            ? 'live'
            : 'muted';

  const statusText = legacy
    ? t('旧后端待迁移', 'Legacy backend needs migration')
    : busyMode === 'test'
      ? t('正在测试连接', 'Testing connection')
      : dirty
        ? t('有未保存的修改', 'Unsaved changes')
        : connected
          ? host || t('已连接', 'Connected')
          : t('等待配置', 'Not configured');

  return (
    <div ref={rootRef} className="sbo-stage">
      {/* Top Bar: Monumental Wordmark + Horizontal Slide Switcher */}
      <header className="sbo-top-bar">
        <div className="sbo-title-mask">
          <h1 id="settings-title" className="sbo-display-title">
            WebDAV
          </h1>
        </div>

        <nav className="sbo-deck-nav" role="tablist" aria-label={t('同步连接分页', 'Connection tabs')}>
          {slides.map((slide, index) => (
            <button
              key={slide.id}
              type="button"
              role="tab"
              aria-selected={slideIndex === index}
              className="sbo-deck-tab"
              onClick={() => goSlide(index)}>
              <em>{slide.num}</em>
              <span>{isEn ? slide.enLabel : slide.label}</span>
            </button>
          ))}
        </nav>
      </header>

      {/* Zero-Scroll Horizontal Slide Viewport */}
      <div className="sbo-viewport">
        {slideIndex === 0 ? (
          <section className="sbo-slide" role="tabpanel" aria-label={t('连接与凭据', 'Credentials')}>
            <div className="sbo-slide-split">
              <div className="sbo-col-left">
                <span className="sbo-status-inline" role="status">
                  <span className="sbo-dot" data-tone={tone} aria-hidden="true" />
                  <span>{statusText}</span>
                </span>

                <p className="sbo-statement">
                  {connected
                    ? t('私人云端已直连，双机登录态静默同步。', 'Direct private cloud link active across your devices.')
                    : t('私人云端，直连同步。', 'Private cloud, direct sync.')}
                </p>

                <p className="sbo-lead">
                  {connected && host
                    ? `${host} · ${settings.encryptionEnabled ? t('AES-256-GCM 端到端加密', 'AES-256-GCM E2E Encrypted') : t('Protobuf 传输', 'Protobuf Sync')}${
                        probeAt > 0
                          ? ` · ${t('验证于', 'Verified at')} ${new Date(probeAt).toLocaleTimeString(isEn ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' })}`
                          : ''
                      }`
                    : t(
                        'Cookie 与页面存储仅在你的设备与私人 WebDAV 目录之间直传，不经任何第三方中转。',
                        'Cookies and web storage sync directly between your browsers and private WebDAV directory with zero third-party relays.',
                      )}
                </p>

                <div
                  className="sbo-constellation"
                  data-state={probePhase === 'running' || busy ? 'running' : verified ? 'live' : 'idle'}
                  aria-hidden="true">
                  <span className="sbo-constellation-node">Local</span>
                  <span className="sbo-dots-track">
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="sbo-constellation-node">{host || 'WebDAV'}</span>
                </div>

                <div className="sbo-actions">
                  <Button type="button" className="sbo-btn-primary" disabled={busy} onClick={() => void run(true)}>
                    {busyMode === 'save' ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : null}
                    {busyMode === 'save' ? t('保存中…', 'Saving…') : t('保存并使用 WebDAV', 'Save & Use WebDAV')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="sbo-btn-outline"
                    disabled={busy}
                    onClick={() => void run(false)}>
                    {busyMode === 'test' ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : null}
                    {busyMode === 'test' ? t('测试中…', 'Testing…') : t('测试连接', 'Test Connection')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="sbo-btn-outline"
                    disabled={busy}
                    onClick={() => {
                      setPairInput('');
                      setPairOpen(true);
                      if (config.url && config.username && config.password) {
                        const code = encodePairingCode({
                          url: config.url,
                          username: config.username,
                          password: config.password,
                          path: config.path,
                          allowUnsafeWrites: config.allowUnsafeWrites,
                          encryptionEnabled: settings.encryptionEnabled,
                          encryptionPassword: settings.encryptionPassword,
                        });
                        void QRCode.toDataURL(code, { width: 184, margin: 1 }).then(setPairQrUrl).catch(() => setPairQrUrl(''));
                      } else {
                        setPairQrUrl('');
                      }
                    }}>
                    <QrCode size={14} aria-hidden="true" />
                    {t('跨机配对', 'Pair Device')}
                  </Button>
                </div>

                {probePhase !== 'idle' ? (
                  <>
                    <div className="sbo-probe-line" aria-label={t('连接测试步骤', 'Connection test steps')}>
                      {probeLabels.map(([zhLabel, enLabel], index) => {
                        const state =
                          probePhase === 'running'
                            ? index === probeStep
                              ? 'active'
                              : index < probeStep
                                ? 'done'
                                : 'idle'
                            : probePhase === 'ok'
                              ? 'done'
                              : index === Math.max(0, probeStep)
                                ? 'error'
                                : index < probeStep
                                  ? 'done'
                                  : 'idle';
                        return (
                          <span key={zhLabel} className="sbo-probe-step" data-state={state}>
                            {state === 'done' ? <Check size={13} aria-hidden="true" /> : null}
                            {isEn ? enLabel : zhLabel}
                          </span>
                        );
                      })}
                    </div>
                    {probeMessage ? (
                      <p
                        className="sbo-feedback"
                        data-tone={probePhase === 'error' ? 'error' : probePhase === 'ok' ? 'live' : undefined}
                        role={probePhase === 'error' ? 'alert' : 'status'}>
                        {probeMessage}
                      </p>
                    ) : null}
                  </>
                ) : null}

                {legacy ? (
                  <div className="sbo-legacy" role="alert">
                    <TriangleAlert size={16} aria-hidden="true" />
                    <span>{t('旧后端已移除，填好右侧 WebDAV 即可完成迁移。', 'Legacy backend removed. Fill in your WebDAV details on the right to migrate.')}</span>
                  </div>
                ) : null}
              </div>

              <div className="sbo-col-right" aria-label={t('WebDAV 配置', 'WebDAV configuration')}>
                <div className="sbo-form-head">
                  <span className="sbo-label">Credentials</span>
                  <div className="sbo-presets" role="group" aria-label={t('快速填入常用网盘模板', 'Quick templates')}>
                    {presets.map(preset => (
                      <button
                        key={preset.label}
                        type="button"
                        className="sbo-preset-btn"
                        onClick={() => applyPreset(preset)}>
                        {isEn ? preset.enLabel : preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="sbo-fields">
                  <div className="sbo-field">
                    <div className="sbo-field-top">
                      <Label htmlFor="webdav-url">WebDAV URL</Label>
                      {isHttps ? (
                        <span className="sbo-proto">
                          HTTPS{config.allowUnsafeWrites ? ` · ${t('OpenList/AList 兼容已开启', 'OpenList/AList Compat')}` : ''}
                        </span>
                      ) : isHttp ? (
                        <span className="sbo-proto" data-tone="http">
                          {t('HTTP 明文', 'Plain HTTP')}
                        </span>
                      ) : null}
                    </div>
                    <Input
                      id="webdav-url"
                      type="url"
                      value={config.url}
                      onChange={e => update('url', e.target.value)}
                      placeholder="https://dav.jianguoyun.com/dav/"
                    />
                    {urlCheck.error ? (
                      <p className="sbo-hint" data-tone="error" role="alert">
                        {urlCheck.error}
                      </p>
                    ) : urlCheck.preview ? (
                      <p className="sbo-hint">{urlCheck.preview}</p>
                    ) : null}
                  </div>

                  <div className="sbo-field-pair">
                    <div className="sbo-field">
                      <Label htmlFor="webdav-username">{t('用户名', 'Username')}</Label>
                      <Input
                        id="webdav-username"
                        autoComplete="off"
                        value={config.username}
                        onChange={e => update('username', e.target.value)}
                        placeholder={t('账号或邮箱', 'Account or email')}
                      />
                    </div>

                    <div className="sbo-field">
                      <Label htmlFor="webdav-password">{t('密码／应用密码', 'Password / App Password')}</Label>
                      <div className="sbo-pass-wrap">
                        <Input
                          id="webdav-password"
                          type={showPassword ? 'text' : 'password'}
                          autoComplete="off"
                          value={config.password}
                          onChange={e => update('password', e.target.value)}
                          placeholder={t('专用应用密码', 'Dedicated app password')}
                        />
                        <button
                          type="button"
                          className="sbo-eye"
                          aria-label={showPassword ? t('隐藏密码', 'Hide password') : t('显示密码', 'Show password')}
                          aria-pressed={showPassword}
                          onClick={() => setShowPassword(value => !value)}>
                          {showPassword ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="sbo-field">
                    <Label htmlFor="webdav-path">{t('远程文件路径', 'Remote File Path')}</Label>
                    <Input
                      id="webdav-path"
                      value={config.path}
                      onChange={e => update('path', e.target.value)}
                      placeholder="CookieSync/cookies.txt"
                    />
                    <p className="sbo-hint">
                      {t('两台电脑填写相同相对路径，父目录需提前创建。', 'Use the same relative path on all devices; create the parent folder first.')}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>
        ) : slideIndex === 1 ? (
          <section className="sbo-slide" role="tabpanel" aria-label={t('配置同步通道', 'Config sync channel')}>
            <div className="sbo-slide-band">
              <div className="sbo-label-col">
                <h2 className="sbo-label">Sync Channel</h2>
                <p className="sbo-label-sub">
                  {t(
                    'Cookie 始终只走 WebDAV；这里决定网站名单与同步偏好如何跨机传递。',
                    'Cookies always travel via WebDAV; choose how your site allowlist and preferences sync.',
                  )}
                </p>
              </div>
              <div>
                <ConfigChannelSettings />
              </div>
            </div>
          </section>
        ) : (
          <section className="sbo-slide" role="tabpanel" aria-label={t('高级与兼容选项', 'Advanced options')}>
            <div className="sbo-slide-band">
              <div className="sbo-label-col">
                <h2 className="sbo-label">Options</h2>
                <p className="sbo-label-sub">
                  {t(
                    '凭据默认仅保留在本机；建议在右上角「高级设置」开启端到端 AES-256-GCM 加密。',
                    'Credentials stay local by default; enable end-to-end AES-256-GCM encryption under Advanced.',
                  )}
                </p>
              </div>
              <div className="sbo-options-list">
                <div className="sbo-switch-item">
                  <Label htmlFor="webdav-cloud-sync" className="sbo-switch-copy">
                    <strong>{t('随 Chrome 账号同步 WebDAV 凭据', 'Sync WebDAV Credentials via Chrome Sync')}</strong>
                    <span>
                      {t(
                        '包含应用密码，不同步 Cookie；关闭后移除云端记录并保留本机副本。',
                        'Includes app password (never Cookies); turning off clears Chrome Sync while keeping local copy.',
                      )}
                    </span>
                  </Label>
                  <Switch
                    id="webdav-cloud-sync"
                    checked={syncConfig}
                    onCheckedChange={checked => {
                      setDirty(true);
                      setSyncConfig(checked);
                    }}
                  />
                </div>

                <div className="sbo-switch-item">
                  <Label htmlFor="webdav-unsafe-writes" className="sbo-switch-copy">
                    <strong>{t('AList / OpenList 网关兼容模式', 'AList / OpenList Compatibility Mode')}</strong>
                    <span>
                      {t(
                        '停用 If-Match 条件写入；无法阻止双端同时推送时的并发覆盖。',
                        'Disables If-Match conditional writes for gateways that do not support strong ETags.',
                      )}
                    </span>
                  </Label>
                  <Switch
                    id="webdav-unsafe-writes"
                    checked={!!config.allowUnsafeWrites}
                    onCheckedChange={checked => {
                      setDirty(true);
                      setConfig(current => ({ ...current, allowUnsafeWrites: checked }));
                    }}
                  />
                </div>
              </div>
            </div>
          </section>
        )}
      </div>

      {/* Bottom Rail: Whisper-Quiet Onboarding + Horizontal Prev/Next Arrows */}
      <footer className="sbo-bottom-rail">
        <ConnectionGuide />
        <div className="sbo-slide-arrows" aria-label="左右切换分页">
          <button
            type="button"
            className="sbo-arrow-btn"
            aria-label="上一页"
            disabled={slideIndex === 0}
            onClick={() => goSlide(slideIndex - 1)}>
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <span className="sbo-slide-counter">
            0{slideIndex + 1} / 0{slides.length}
          </span>
          <button
            type="button"
            className="sbo-arrow-btn"
            aria-label="下一页"
            disabled={slideIndex === slides.length - 1}
            onClick={() => goSlide(slideIndex + 1)}>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </footer>

      {pairOpen ? (
        <OverviewDialog title="跨机 / 手机一键配对" onClose={() => setPairOpen(false)}>
          <div className="grid gap-4 text-sm">
            {config.url && config.username && config.password ? (
              <div className="grid gap-3 border-b pb-4">
                <p className="text-xs text-muted-foreground">
                  纯本地生成，不经过任何服务器。可扫码或复制配对口令到另一台电脑 / 手机油猴版一键导入。
                </p>
                {pairQrUrl ? (
                  <div className="flex justify-center">
                    <img
                      src={pairQrUrl}
                      alt="CookieSync 跨机配对二维码"
                      className="h-44 w-44 rounded-xl border bg-white p-2"
                    />
                  </div>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  className="sbo-btn-primary w-full"
                  onClick={() => {
                    const code = encodePairingCode({
                      url: config.url,
                      username: config.username,
                      password: config.password,
                      path: config.path,
                      allowUnsafeWrites: config.allowUnsafeWrites,
                      encryptionEnabled: settings.encryptionEnabled,
                      encryptionPassword: settings.encryptionPassword,
                    });
                    void navigator.clipboard
                      .writeText(code)
                      .then(() => toast.success('已复制跨机配对口令（含应用密码，请仅在自己设备间使用）'))
                      .catch(() => toast.error('复制失败'));
                  }}>
                  <Copy size={14} className="mr-1.5" aria-hidden="true" />
                  复制本机配对口令
                </Button>
              </div>
            ) : null}

            <div className="grid gap-2">
              <Label htmlFor="pair-import-input" className="text-xs text-muted-foreground">
                导入其他设备的配对口令
              </Label>
              <div className="flex gap-2">
                <Input
                  id="pair-import-input"
                  placeholder="粘贴 cookiesync://pair#v1.…"
                  value={pairInput}
                  onChange={e => setPairInput(e.target.value)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!pairInput.trim()}
                  onClick={() => {
                    try {
                      const imported = decodePairingCode(pairInput);
                      setConfig(prev => ({
                        ...prev,
                        url: imported.url,
                        username: imported.username,
                        password: imported.password,
                        path: imported.path,
                        allowUnsafeWrites: Boolean(imported.allowUnsafeWrites || isLikelyGatewayWebdavUrl(imported.url)),
                      }));
                      if (imported.encryptionEnabled && imported.encryptionPassword) {
                        void settingsStorage.update({
                          protobufEncoding: true,
                          encryptionEnabled: true,
                          encryptionPassword: imported.encryptionPassword,
                        });
                      }
                      setDirty(true);
                      setPairOpen(false);
                      toast.success('已导入配对配置，请点击「保存并使用 WebDAV」完成连接');
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : '配对口令无效');
                    }
                  }}>
                  一键填入
                </Button>
              </div>
            </div>
          </div>
        </OverviewDialog>
      ) : null}
    </div>
  );
}
