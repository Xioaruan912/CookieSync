import { useGSAP } from '@gsap/react';
import { buildWebdavUrl, testWebdavConnection, useStorageSuspense } from '@sync-your-cookie/shared';
import { accountStorage, isLegacyProvider } from '@sync-your-cookie/storage/lib/accountStorage';
import { cookieStorage } from '@sync-your-cookie/storage/lib/cookieStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { webdavCloudStorage, webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { Button, Input, Label, Switch } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import { Check, ChevronLeft, ChevronRight, Eye, EyeOff, Loader2, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfigChannelSettings } from './ConfigChannelSettings';
import { ConnectionGuide } from './ConnectionGuide';

gsap.registerPlugin(useGSAP);

const probeKey = 'cookiesync-webdav-probe-ok';
const probeLabels = ['创建', '覆盖', '读取', '删除'] as const;

const slides = [
  { id: 'credentials', num: '01', label: '连接与凭据' },
  { id: 'channel', num: '02', label: '同步通道' },
  { id: 'options', num: '03', label: '高级选项' },
] as const;

const presets = [
  { label: '坚果云', url: 'https://dav.jianguoyun.com/dav/', path: 'CookieSync/cookies.txt', unsafe: false },
  {
    label: 'Nextcloud',
    url: 'https://cloud.example.com/remote.php/dav/files/user/',
    path: 'CookieSync/cookies.txt',
    unsafe: false,
  },
  { label: 'AList', url: 'https://alist.example.com/dav/', path: 'CookieSync/cookies.txt', unsafe: true },
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
    setConfig(current => ({ ...current, [key]: value }));
  };

  const applyPreset = (preset: (typeof presets)[number]) => {
    setDirty(true);
    setConfig(current => ({
      ...current,
      url: preset.url,
      path: current.path.trim() ? current.path : preset.path,
      allowUnsafeWrites: preset.unsafe,
    }));
    toast.info(`已填入 ${preset.label} 模板地址`);
  };

  const run = async (save: boolean) => {
    setBusyMode(save ? 'save' : 'test');
    setProbeMessage('');
    let timer: ReturnType<typeof setInterval> | undefined;
    if (!save) {
      setProbePhase('running');
      setProbeStep(0);
      timer = setInterval(() => setProbeStep(step => (step < 3 ? step + 1 : step)), 240);
    }
    try {
      const normalized = {
        ...config,
        url: config.url.trim(),
        username: config.username.trim(),
        path: config.path.trim(),
      };
      buildWebdavUrl(normalized);
      if (save) {
        await webdavStorage.update(normalized, syncConfig);
        setDirty(false);
        await cookieStorage.reset();
        await accountStorage.update({ selectedProvider: 'webdav' });
        await chrome.storage.local.set({ [probeKey]: Date.now() });
        setProbePhase('ok');
        setProbeStep(3);
        setProbeMessage('配置已保存并启用');
        toast.success('WebDAV 配置已保存');
      } else {
        await testWebdavConnection(normalized);
        await chrome.storage.local.set({ [probeKey]: Date.now() });
        setProbePhase('ok');
        setProbeStep(3);
        setProbeMessage('创建、覆盖、读取、删除四项权限均已通过');
        toast.success('连接测试成功：已验证临时文件的创建、覆盖、读取和删除');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'WebDAV 操作失败';
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
    ? '旧后端待迁移'
    : busyMode === 'test'
      ? '正在测试连接'
      : dirty
        ? '有未保存的修改'
        : connected
          ? host || '已连接'
          : '等待配置';

  return (
    <div ref={rootRef} className="sbo-stage">
      {/* Top Bar: Monumental Wordmark + Horizontal Slide Switcher */}
      <header className="sbo-top-bar">
        <div className="sbo-title-mask">
          <h1 id="settings-title" className="sbo-display-title">
            WebDAV
          </h1>
        </div>

        <nav className="sbo-deck-nav" role="tablist" aria-label="同步连接分页">
          {slides.map((slide, index) => (
            <button
              key={slide.id}
              type="button"
              role="tab"
              aria-selected={slideIndex === index}
              className="sbo-deck-tab"
              onClick={() => goSlide(index)}>
              <em>{slide.num}</em>
              <span>{slide.label}</span>
            </button>
          ))}
        </nav>
      </header>

      {/* Zero-Scroll Horizontal Slide Viewport */}
      <div className="sbo-viewport">
        {slideIndex === 0 ? (
          <section className="sbo-slide" role="tabpanel" aria-label="连接与凭据">
            <div className="sbo-slide-split">
              <div className="sbo-col-left">
                <span className="sbo-status-inline" role="status">
                  <span className="sbo-dot" data-tone={tone} aria-hidden="true" />
                  <span>{statusText}</span>
                </span>

                <p className="sbo-statement">
                  {connected ? '私人云端已直连，双机登录态静默同步。' : '私人云端，直连同步。'}
                </p>

                <p className="sbo-lead">
                  {connected && host
                    ? `${host} · ${settings.encryptionEnabled ? 'AES-256-GCM 端到端加密' : 'Protobuf 传输'}${
                        probeAt > 0
                          ? ` · 验证于 ${new Date(probeAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
                          : ''
                      }`
                    : 'Cookie 与页面存储仅在你的设备与私人 WebDAV 目录之间直传，不经任何第三方中转。'}
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
                    {busyMode === 'save' ? '保存中…' : '保存并使用 WebDAV'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="sbo-btn-outline"
                    disabled={busy}
                    onClick={() => void run(false)}>
                    {busyMode === 'test' ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : null}
                    {busyMode === 'test' ? '测试中…' : '测试连接'}
                  </Button>
                </div>

                {probePhase !== 'idle' ? (
                  <>
                    <div className="sbo-probe-line" aria-label="连接测试步骤">
                      {probeLabels.map((label, index) => {
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
                          <span key={label} className="sbo-probe-step" data-state={state}>
                            {state === 'done' ? <Check size={13} aria-hidden="true" /> : null}
                            {label}
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
                    <span>旧后端已移除，填好右侧 WebDAV 即可完成迁移。</span>
                  </div>
                ) : null}
              </div>

              <div className="sbo-col-right" aria-label="WebDAV 配置">
                <div className="sbo-form-head">
                  <span className="sbo-label">Credentials</span>
                  <div className="sbo-presets" role="group" aria-label="快速填入常用网盘模板">
                    {presets.map(preset => (
                      <button
                        key={preset.label}
                        type="button"
                        className="sbo-preset-btn"
                        onClick={() => applyPreset(preset)}>
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="sbo-fields">
                  <div className="sbo-field">
                    <div className="sbo-field-top">
                      <Label htmlFor="webdav-url">WebDAV URL</Label>
                      {isHttps ? (
                        <span className="sbo-proto">HTTPS</span>
                      ) : isHttp ? (
                        <span className="sbo-proto" data-tone="http">
                          HTTP 明文
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
                      <Label htmlFor="webdav-username">用户名</Label>
                      <Input
                        id="webdav-username"
                        autoComplete="off"
                        value={config.username}
                        onChange={e => update('username', e.target.value)}
                        placeholder="账号或邮箱"
                      />
                    </div>

                    <div className="sbo-field">
                      <Label htmlFor="webdav-password">密码／应用密码</Label>
                      <div className="sbo-pass-wrap">
                        <Input
                          id="webdav-password"
                          type={showPassword ? 'text' : 'password'}
                          autoComplete="off"
                          value={config.password}
                          onChange={e => update('password', e.target.value)}
                          placeholder="专用应用密码"
                        />
                        <button
                          type="button"
                          className="sbo-eye"
                          aria-label={showPassword ? '隐藏密码' : '显示密码'}
                          aria-pressed={showPassword}
                          onClick={() => setShowPassword(value => !value)}>
                          {showPassword ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="sbo-field">
                    <Label htmlFor="webdav-path">远程文件路径</Label>
                    <Input
                      id="webdav-path"
                      value={config.path}
                      onChange={e => update('path', e.target.value)}
                      placeholder="CookieSync/cookies.txt"
                    />
                    <p className="sbo-hint">两台电脑填写相同相对路径，父目录需提前创建。</p>
                  </div>
                </div>
              </div>
            </div>
          </section>
        ) : slideIndex === 1 ? (
          <section className="sbo-slide" role="tabpanel" aria-label="配置同步通道">
            <div className="sbo-slide-band">
              <div className="sbo-label-col">
                <h2 className="sbo-label">Sync Channel</h2>
                <p className="sbo-label-sub">Cookie 始终只走 WebDAV；这里决定网站名单与同步偏好如何跨机传递。</p>
              </div>
              <div>
                <ConfigChannelSettings />
              </div>
            </div>
          </section>
        ) : (
          <section className="sbo-slide" role="tabpanel" aria-label="高级与兼容选项">
            <div className="sbo-slide-band">
              <div className="sbo-label-col">
                <h2 className="sbo-label">Options</h2>
                <p className="sbo-label-sub">凭据默认仅保留在本机；建议在右上角「高级设置」开启端到端 AES-256-GCM 加密。</p>
              </div>
              <div className="sbo-options-list">
                <div className="sbo-switch-item">
                  <Label htmlFor="webdav-cloud-sync" className="sbo-switch-copy">
                    <strong>随 Chrome 账号同步 WebDAV 凭据</strong>
                    <span>包含应用密码，不同步 Cookie；关闭后移除云端记录并保留本机副本。</span>
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
                    <strong>AList / OpenList 网关兼容模式</strong>
                    <span>停用 If-Match 条件写入；无法阻止双端同时推送时的并发覆盖。</span>
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
    </div>
  );
}
