import { useGSAP } from '@gsap/react';
import {
  completeQrLogin,
  pollQrStatus,
  requestQrToken,
  siteProfiles,
  useStorageSuspense,
  type SiteProfile,
} from '@sync-your-cookie/shared';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import { siteHealthStorage, type SiteHealthEntry } from '@sync-your-cookie/storage/lib/siteHealthStorage';
import { Button, Label, Switch } from '@sync-your-cookie/ui';
import gsap from 'gsap';
import { Loader2, QrCode, RefreshCw } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

gsap.registerPlugin(useGSAP);

type QrStage =
  | { stage: 'idle' }
  | { stage: 'loading' }
  | { stage: 'waiting'; dataUrl: string }
  | { stage: 'scanned'; dataUrl: string }
  | { stage: 'success' }
  | { stage: 'failed'; error: string };

const stateText = (profile: SiteProfile, entry?: SiteHealthEntry) => {
  if (!profile.healthCheck) {
    if (entry?.loginKeysMissing) return '缺少核心凭证';
    if (entry?.checkedAt) return '本机凭证齐全';
    return '防踢护盾已就绪';
  }
  return entry?.state === 'ok'
    ? '登录有效'
    : entry?.state === 'invalid'
      ? '登录已失效'
      : entry?.state === 'unknown'
        ? '验证未完成'
        : '尚未验证';
};

export function SiteHealthSettings() {
  const rootRef = useRef<HTMLDivElement>(null);
  const slideDir = useRef(0);
  const health = useStorageSuspense(siteHealthStorage);
  const settings = useStorageSuspense(settingsStorage);
  const [busyDomain, setBusyDomain] = useState<string>();
  const [qrProfile, setQrProfile] = useState<SiteProfile>();
  const [qrStage, setQrStage] = useState<QrStage>({ stage: 'idle' });
  const [profileIndex, setProfileIndex] = useState(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>();

  const trackedProfiles = siteProfiles.filter(
    profile => profile.healthCheck || profile.qrLogin || profile.singleSession,
  );
  const activeProfile = trackedProfiles[profileIndex] || trackedProfiles[0];
  const entry = activeProfile ? health[activeProfile.domain] : undefined;

  useEffect(
    () => () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    },
    [],
  );

  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add('(prefers-reduced-motion: no-preference)', () => {
        gsap
          .timeline({ defaults: { ease: 'power3.out', clearProps: 'transform,opacity' } })
          .from('.adapt-display-title', { yPercent: 105, duration: 0.52 })
          .from('.adapt-slide', { y: 12, opacity: 0, duration: 0.36 }, 0.14);
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
        '.adapt-slide',
        { x: dir * 40, opacity: 0 },
        { x: 0, opacity: 1, duration: 0.28, ease: 'power3.out', clearProps: 'transform,opacity', overwrite: 'auto' },
      );
    },
    { scope: rootRef, dependencies: [profileIndex], revertOnUpdate: true },
  );

  const verify = async (domain: string) => {
    setBusyDomain(domain);
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CookieSyncCheckSiteHealth', domain });
      if (!response?.isOk) throw new Error();
    } catch {
      toast.error('验证未完成，后台任务未启动，请重新加载扩展后重试');
    } finally {
      setBusyDomain(undefined);
    }
  };

  const applyQrCookies = async (profile: SiteProfile, cookies: Record<string, string>) => {
    for (const [name, value] of Object.entries(cookies)) {
      if (!value) continue;
      await chrome.cookies.set({
        url: `https://${profile.domain}/`,
        domain: `.${profile.domain}`,
        name,
        value,
        path: '/',
        secure: true,
        httpOnly: true,
      });
    }
  };

  const startRepair = async (profile: SiteProfile) => {
    if (!profile.qrLogin) return;
    setQrProfile(profile);
    setQrStage({ stage: 'loading' });
    if (pollTimer.current) clearTimeout(pollTimer.current);
    try {
      const token = await requestQrToken(profile);
      const payload = token.qrcode.startsWith('http') ? token.qrcode : `https://${token.qrcode}`;
      const dataUrl = await QRCode.toDataURL(payload, { width: 220, margin: 1 });
      setQrStage({ stage: 'waiting', dataUrl });
      const deadline = Date.now() + 5 * 60000;
      const poll = async () => {
        if (Date.now() > deadline) {
          setQrStage({ stage: 'failed', error: '二维码已过期，请重新生成' });
          return;
        }
        try {
          const status = await pollQrStatus(profile, token);
          if (status === 2) {
            const result = await completeQrLogin(profile, token);
            await applyQrCookies(profile, result.cookies);
            await chrome.runtime.sendMessage({ type: 'CookieSyncRunAutomaticSync' });
            setQrStage({ stage: 'success' });
            toast.success(`${profile.domain} 会话已更新，正在推送`);
          } else if (status === 1) {
            setQrStage(current =>
              current.stage === 'waiting' ? { stage: 'scanned', dataUrl: current.dataUrl } : current,
            );
            pollTimer.current = setTimeout(poll, 2000);
          } else if (status === -1) {
            setQrStage({ stage: 'failed', error: '二维码已过期，请重新生成' });
          } else if (status === -2) {
            setQrStage({ stage: 'failed', error: '已在手机上取消，可重新生成' });
          } else {
            pollTimer.current = setTimeout(poll, 2000);
          }
        } catch (error) {
          setQrStage({ stage: 'failed', error: error instanceof Error ? error.message : '扫码流程失败' });
        }
      };
      pollTimer.current = setTimeout(poll, 1500);
    } catch (error) {
      setQrStage({ stage: 'failed', error: error instanceof Error ? error.message : '扫码流程启动失败' });
    }
  };

  const closeQr = () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setQrProfile(undefined);
    setQrStage({ stage: 'idle' });
  };

  return (
    <div ref={rootRef} className="adapt-stage" aria-label="已适配网站">
      <header className="adapt-top-bar">
        <div className="adapt-title-mask">
          <h1 id="settings-title" className="adapt-display-title">
            Adaptations
          </h1>
        </div>

        <nav className="adapt-deck-nav" role="tablist" aria-label="已适配站点">
          {trackedProfiles.map((profile, index) => (
            <button
              key={profile.domain}
              type="button"
              role="tab"
              aria-selected={profileIndex === index}
              className="adapt-deck-tab"
              onClick={() => {
                if (index === profileIndex) return;
                slideDir.current = index > profileIndex ? 1 : -1;
                setProfileIndex(index);
              }}>
              <em>0{index + 1}</em>
              <span>{profile.domain}</span>
            </button>
          ))}
        </nav>
      </header>

      <div className="adapt-viewport">
        {activeProfile ? (
          <section className="adapt-slide" role="tabpanel" aria-label={activeProfile.domain}>
            <div className="adapt-split">
              <div className="adapt-col-left">
                <div className="adapt-status-line" role="status">
                  <span
                    className="adapt-dot"
                    data-state={
                      activeProfile.healthCheck
                        ? entry?.state
                        : entry?.loginKeysMissing
                          ? 'invalid'
                          : 'ok'
                    }
                    aria-hidden="true"
                  />
                  <span>
                    {stateText(activeProfile, entry)}
                    {entry?.checkedAt ? ` · ${new Date(entry.checkedAt).toLocaleString('zh-CN')}` : ''}
                  </span>
                </div>

                <h2 className="adapt-domain-title">{activeProfile.domain}</h2>

                <p className="adapt-desc">
                  {activeProfile.healthCheck && activeProfile.qrLogin
                    ? '恢复后使用只读接口校验登录有效性，核心登录凭证不完整时自动拦截不覆盖云端，并支持内置扫码一键修复。'
                    : '核心登录凭证不完整时自动拦截不覆盖云端，待机时自动休眠后台标签页防止双机互踢。'}
                </p>

                {activeProfile.loginKeys?.length ? (
                  <div className="adapt-keys" aria-label="核心登录凭证">
                    {activeProfile.loginKeys.map(key => (
                      <span
                        key={key}
                        className="adapt-key-tag"
                        data-healthy={entry?.state === 'ok' && !entry.loginKeysMissing ? 'true' : undefined}>
                        {key}
                      </span>
                    ))}
                  </div>
                ) : null}

                <div className="adapt-actions">
                  <Button
                    type="button"
                    className="adapt-btn-primary"
                    disabled={busyDomain === activeProfile.domain}
                    onClick={() => void verify(activeProfile.domain)}>
                    {busyDomain === activeProfile.domain ? (
                      <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw size={14} aria-hidden="true" />
                    )}
                    立即验证
                  </Button>

                  {activeProfile.qrLogin ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="adapt-btn-outline"
                      disabled={qrProfile?.domain === activeProfile.domain && qrStage.stage !== 'failed'}
                      onClick={() => void startRepair(activeProfile)}>
                      <QrCode size={14} aria-hidden="true" />
                      扫码重新登录
                    </Button>
                  ) : activeProfile.loginPageUrl ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="adapt-btn-outline"
                      onClick={() => void chrome.tabs.create({ url: activeProfile.loginPageUrl })}>
                      <QrCode size={14} aria-hidden="true" />
                      扫码重新登录
                    </Button>
                  ) : null}
                </div>

                {entry?.loginKeysMissing ? (
                  <p className="adapt-msg" data-tone="error" role="status">
                    本机缺少核心登录凭证，已自动拦截不上传，避免覆盖云端健康登录态。
                  </p>
                ) : null}

                {entry?.message ? (
                  <p
                    className="adapt-msg"
                    data-tone={entry.state === 'invalid' ? 'error' : undefined}
                    role={entry.state === 'invalid' ? 'alert' : 'status'}>
                    {entry.message}
                  </p>
                ) : null}
              </div>

              <div className="adapt-col-right">
                <p className="adapt-eyebrow">Single-Session Guard</p>

                {trackedProfiles.some(profile => profile.singleSession) ? (
                  <div className="adapt-switch-row">
                    <Label htmlFor="adaptations-idle-tabs" className="adapt-switch-copy">
                      <strong>待机时休眠单会话网站</strong>
                      <span>
                        离开 90 秒或另一台电脑接班时，自动休眠闲置机上的 115 后台标签页防互踢；绝不关闭标签页，也不打扰正在使用的电脑。
                      </span>
                    </Label>
                    <Switch
                      id="adaptations-idle-tabs"
                      checked={settings.discardIdleSingleSessionTabs !== false}
                      onCheckedChange={checked => void settingsStorage.update({ discardIdleSingleSessionTabs: checked })}
                    />
                  </div>
                ) : null}

                <dl className="adapt-specs">
                  <div>
                    <dt>缺凭证防降级拦截</dt>
                    <dd>已开启</dd>
                  </div>
                  <div>
                    <dt>恢复前清理冲突旧 Cookie</dt>
                    <dd>已开启</dd>
                  </div>
                  <div>
                    <dt>健康巡检模式</dt>
                    <dd>只读接口 · 待机静默</dd>
                  </div>
                </dl>
              </div>
            </div>
          </section>
        ) : null}
      </div>

      <footer className="adapt-bottom-rail">
        <span>服务端风控或会话撤销属目标站行为，扩展负责状态透明与防双端互踢。</span>
      </footer>

      {qrProfile ? (
        <div className="adapt-qr-overlay" role="dialog" aria-modal="true" aria-label="扫码登录">
          <div className="adapt-qr-panel">
            <h3>{qrProfile.domain} 扫码登录</h3>
            {qrStage.stage === 'loading' ? (
              <p className="adapt-qr-status">
                <Loader2 className="mr-2 h-4 w-4 animate-spin inline" aria-hidden="true" />
                正在获取二维码…
              </p>
            ) : qrStage.stage === 'waiting' || qrStage.stage === 'scanned' ? (
              <>
                <div className="adapt-qr-box">
                  <img src={qrStage.dataUrl} alt="登录二维码" width={220} height={220} />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-2 top-2 h-0.5 rounded-full bg-sky-400 shadow-[0_0_12px_#38bdf8]"
                    style={{ animation: 'qr-scan-laser 2.4s ease-in-out infinite' }}
                  />
                </div>
                <p className="adapt-qr-status">
                  {qrStage.stage === 'scanned' ? '已扫码，请在手机上确认登录' : '使用 115 手机 APP 扫码'}
                </p>
              </>
            ) : qrStage.stage === 'success' ? (
              <p className="adapt-qr-status">扫码成功，会话已更新并推送</p>
            ) : qrStage.stage === 'failed' ? (
              <p className="adapt-qr-status" role="alert">
                {qrStage.error}
              </p>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              className="adapt-btn-outline"
              onClick={qrStage.stage === 'failed' ? () => void startRepair(qrProfile) : closeQr}>
              {qrStage.stage === 'failed' ? '重新生成二维码' : '关闭'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
