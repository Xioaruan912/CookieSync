import {
  completeQrLogin,
  pollQrStatus,
  requestQrToken,
  siteProfiles,
  useStorageSuspense,
  type SiteProfile,
} from '@sync-your-cookie/shared';
import { siteHealthStorage, type SiteHealthEntry } from '@sync-your-cookie/storage/lib/siteHealthStorage';
import { Button } from '@sync-your-cookie/ui';
import { BadgeCheck, Loader2, QrCode, RefreshCw, ShieldAlert, ShieldQuestion } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

type QrStage =
  | { stage: 'idle' }
  | { stage: 'loading' }
  | { stage: 'waiting'; dataUrl: string }
  | { stage: 'scanned'; dataUrl: string }
  | { stage: 'success' }
  | { stage: 'failed'; error: string };

const stateText = (entry?: SiteHealthEntry) =>
  entry?.state === 'ok'
    ? '登录有效'
    : entry?.state === 'invalid'
      ? '登录已失效'
      : entry?.state === 'unknown'
        ? '验证未完成'
        : '尚未验证';

export function SiteHealthSettings() {
  const health = useStorageSuspense(siteHealthStorage);
  const [busyDomain, setBusyDomain] = useState<string>();
  const [qrProfile, setQrProfile] = useState<SiteProfile>();
  const [qrStage, setQrStage] = useState<QrStage>({ stage: 'idle' });
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>();
  const trackedProfiles = siteProfiles.filter(profile => profile.healthCheck);

  useEffect(
    () => () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    },
    [],
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

  /**
   * The login response's Set-Cookie headers land the browser jar directly;
   * body values are the authoritative new session and are always written, so a
   * QR re-login replaces the previous cookies instead of preserving them.
   */
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
            setQrStage(current => (current.stage === 'waiting' ? { stage: 'scanned', dataUrl: current.dataUrl } : current));
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
    <div className="site-health" aria-label="站点登录状态">
      <h3 className="font-medium">站点登录状态</h3>
      <p className="text-muted-foreground text-sm">
        恢复后向站点验证会话是否真的有效；仅对配备档案的站点运行，不在每次同步轮询中打扰站点。
      </p>
      {trackedProfiles.map(profile => {
        const entry = health[profile.domain];
        return (
          <div key={profile.domain} className="site-health-card" data-state={entry?.state}>
            <div className="site-health-head">
              <span className="site-health-badge">
                {entry?.state === 'ok' ? (
                  <BadgeCheck size={16} aria-hidden="true" />
                ) : entry?.state === 'invalid' ? (
                  <ShieldAlert size={16} aria-hidden="true" />
                ) : (
                  <ShieldQuestion size={16} aria-hidden="true" />
                )}
                {profile.domain} 登录状态
              </span>
              <Button size="sm" variant="outline" disabled={busyDomain === profile.domain} onClick={() => void verify(profile.domain)}>
                {busyDomain === profile.domain ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw size={15} className="mr-1" aria-hidden="true" />
                )}
                立即验证
              </Button>
            </div>
            <p className="site-health-state">
              {stateText(entry)}
              {entry?.state === 'ok' && entry.userName ? ` · ${entry.userName}` : ''}
              {entry?.checkedAt ? ` · 检查于 ${new Date(entry.checkedAt).toLocaleString()}` : ''}
            </p>
            {entry?.loginKeysMissing ? (
              <p role="status">本机快照缺少该站登录要素（可能已退出登录）；推送后其他电脑也无法用它登录。</p>
            ) : null}
            {entry?.message ? (
              <p role={entry.state === 'invalid' ? 'alert' : 'status'} className="break-words">
                {entry.message}
              </p>
            ) : null}
            {profile.qrLogin ? (
              <details className="site-health-repair">
                <summary>
                  <QrCode size={15} aria-hidden="true" />
                  {profile.domain} 会话修复（扫码重登）
                </summary>
                <p className="text-muted-foreground">
                  在本机生成全新网页端会话，效果与在官网手动登录相同：会替换当前网页端会话，手机等其他端登录不受影响。成功后立即推送，其他电脑稍后自动采用。
                </p>
                <Button size="sm" variant="outline" disabled={qrProfile?.domain === profile.domain && qrStage.stage !== 'failed'} onClick={() => void startRepair(profile)}>
                  <QrCode size={15} className="mr-1" aria-hidden="true" />
                  生成二维码
                </Button>
              </details>
            ) : null}
          </div>
        );
      })}

      {qrProfile ? (
        <div className="qr-overlay" role="dialog" aria-modal="true" aria-label="扫码登录">
          <div className="qr-panel">
            <h3>{qrProfile.domain} 扫码登录</h3>
            {qrStage.stage === 'loading' ? (
              <p className="qr-status">
                <Loader2 className="mr-2 h-4 w-4 animate-spin inline" aria-hidden="true" />
                正在获取二维码…
              </p>
            ) : qrStage.stage === 'waiting' || qrStage.stage === 'scanned' ? (
              <>
                <img src={qrStage.dataUrl} alt="登录二维码" width={220} height={220} />
                <p className="qr-status">
                  {qrStage.stage === 'scanned' ? '已扫码，请在手机上确认登录' : '使用 115 手机 APP 扫码'}
                </p>
              </>
            ) : qrStage.stage === 'success' ? (
              <p className="qr-status">扫码成功，会话已更新并推送</p>
            ) : qrStage.stage === 'failed' ? (
              <p className="qr-status" role="alert">
                {qrStage.error}
              </p>
            ) : null}
            <Button size="sm" variant="outline" onClick={qrStage.stage === 'failed' ? () => void startRepair(qrProfile) : closeQr}>
              {qrStage.stage === 'failed' ? '重新生成二维码' : '关闭'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
