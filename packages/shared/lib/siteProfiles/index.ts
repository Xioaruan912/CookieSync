/**
 * Site-specific login profiles.
 *
 * Priority sites (xiaohongshu / douyin / 115) get family-wide cookie capture via
 * syncCookieDomain; a profile additionally declares what a WORKING login looks
 * like for that site, so sync can be honest instead of silent:
 *
 * - loginKeys: the cookie names a valid session must carry. 115 extended its
 *   cookie set twice (KID in 2024-12, USERSESSIONID in 2026; the old SE field
 *   is gone), so snapshots missing any key can never log a machine in.
 * - healthCheck: a READ-ONLY endpoint that answers with the logged-in state.
 *   Never use SSO-style check endpoints here: 115's
 *   passportapi …/check/sso logs out other devices, which is exactly the
 *   failure mode this feature exists to explain.
 * - qrLogin: the same QR flow the site's own web login uses, offered as a
 *   guided repair path. Endpoints rotate; keep every URL in the profile so a
 *   future change is a one-file edit.
 */
import { profile115 } from './115';
import { profileDouyin } from './douyin';
import { profileXiaohongshu } from './xiaohongshu';

export interface SiteHealthCheckConfig {
  url: string;
  referrer: string;
}

export interface SiteQrLoginConfig {
  tokenUrl: string;
  statusUrl: string;
  loginUrl: string;
  app: string;
}

export interface SiteProfile {
  domain: string;
  /** Cookie names that must all be present for a working login session. */
  loginKeys: string[];
  healthCheck?: SiteHealthCheckConfig;
  /** The site rejects sessions whose browser fingerprint changed (OpenList #2502). */
  uaSensitive?: boolean;
  /** True for sites where concurrent tabs on two PCs invalidate the session (e.g. 115). */
  singleSession?: boolean;
  /** True for key login sites that should flush within ~5s after login cookie changes. */
  fastSync?: boolean;
  qrLogin?: SiteQrLoginConfig;
}

export type SiteHealthState = 'ok' | 'invalid' | 'unknown';

export interface SiteHealthResult {
  state: SiteHealthState;
  userName?: string;
  message?: string;
}

const requestTimeoutMs = 15000;

const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function siteProfileFor(host: string): SiteProfile | undefined {
  const normalized = (host || '')
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
  return siteProfiles.find(profile => within(normalized, profile.domain));
}

export function missingLoginKeys(
  profile: SiteProfile,
  cookies: { name?: string | null }[] | null | undefined,
): string[] {
  const names = new Set((cookies || []).map(cookie => cookie.name || ''));
  return profile.loginKeys.filter(key => !names.has(key));
}

export function isSingleSessionSite(host: string): boolean {
  return !!siteProfileFor(host)?.singleSession;
}

export function isFastSyncSite(host: string): boolean {
  return !!siteProfileFor(host)?.fastSync;
}

export interface LoginGuardVerdict {
  blocked: boolean;
  missingKeys: string[];
  reason?: string;
}

/**
 * Anti-downgrade login guard: never let an incomplete/logged-out local snapshot
 * automatically overwrite a complete cloud session for profiled sites (e.g. 115).
 */
export function evaluateLoginGuard(
  host: string,
  localCookies: { name?: string | null }[] | null | undefined,
  cloudCookies: { name?: string | null }[] | null | undefined,
): LoginGuardVerdict {
  const profile = siteProfileFor(host);
  if (!profile || !profile.loginKeys.length) {
    return { blocked: false, missingKeys: [] };
  }
  const localMissing = missingLoginKeys(profile, localCookies);
  if (!localMissing.length) {
    return { blocked: false, missingKeys: [] };
  }
  const cloudMissing = missingLoginKeys(profile, cloudCookies);
  if (cloudCookies && cloudCookies.length > 0 && cloudMissing.length === 0) {
    return {
      blocked: true,
      missingKeys: localMissing,
      reason: `本机缺少 ${profile.domain} 登录核心凭证（${localMissing.join('、')}），已拦截自动上传以保护云端有效会话`,
    };
  }
  return { blocked: false, missingKeys: localMissing };
}

/**
 * Asks the site, with the restored cookie jar, whether the session is alive.
 * 'invalid' means the site answered "not logged in"; 'unknown' means we could
 * not reach or understand the endpoint (never guess 'invalid' on network
 * errors).
 */
export async function checkProfileHealth(profile: SiteProfile): Promise<SiteHealthResult> {
  const config = profile.healthCheck;
  if (!config) return { state: 'unknown', message: '该站点未配置登录验证' };
  try {
    const response = await fetch(config.url, {
      credentials: 'include',
      cache: 'no-store',
      referrer: config.referrer,
      redirect: 'error',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    // Only an explicit application answer proves anything. A WAF challenge page,
    // a proxy login form or any non-JSON body means "we could not tell", never
    // "you are logged out".
    const body = await response.text().catch(() => '');
    let data: { state?: unknown; error?: unknown; data?: { user_name?: unknown } } | null = null;
    try {
      data = body ? JSON.parse(body) : null;
    } catch {
      data = null;
    }
    if (!data || typeof data !== 'object') {
      return {
        state: 'unknown',
        message: response.ok
          ? '验证响应无法识别（不是 JSON），可能被站点风控或代理拦截'
          : `验证请求返回 HTTP ${response.status}，无法判断登录状态`,
      };
    }
    if (response.ok && data.state === true)
      return { state: 'ok', userName: data.data?.user_name ? String(data.data.user_name) : undefined };
    if (data.state === false || typeof data.error === 'string') {
      return { state: 'invalid', message: (typeof data.error === 'string' && data.error) || '站点报告未登录' };
    }
    return {
      state: 'unknown',
      message: response.ok ? '验证响应缺少登录状态字段' : `验证请求返回 HTTP ${response.status}`,
    };
  } catch (error) {
    return { state: 'unknown', message: error instanceof Error ? error.message : '验证请求失败' };
  }
}

const uaFamily = (ua: string) =>
  ua.includes('Edg/')
    ? 'Edge'
    : ua.includes('OPR/')
      ? 'Opera'
      : ua.includes('Firefox/')
        ? 'Firefox'
        : ua.includes('Chrome/')
          ? 'Chrome'
          : ua.includes('Safari/')
            ? 'Safari'
            : '';
const uaPlatform = (ua: string) =>
  ua.includes('Windows')
    ? 'Windows'
    : ua.includes('Mac OS')
      ? 'macOS'
      : ua.includes('Android')
        ? 'Android'
        : ua.includes('Linux')
          ? 'Linux'
          : '';

/** Undefined when the capture came from the same browser family and platform. */
export function uaMismatchHint(capturedUserAgent: string | null | undefined, currentUserAgent: string): string | undefined {
  if (!capturedUserAgent) return undefined;
  if (uaFamily(capturedUserAgent) === uaFamily(currentUserAgent) && uaPlatform(capturedUserAgent) === uaPlatform(currentUserAgent))
    return undefined;
  const captured = `${uaFamily(capturedUserAgent) || '未知浏览器'} · ${uaPlatform(capturedUserAgent) || '未知系统'}`;
  return `快照来自 ${captured}，与本机浏览器特征不同，该站点可能拒绝此会话`;
}

export interface QrToken {
  uid: string;
  time: number;
  sign: string;
  /** The payload the site's own login page renders as a QR image. */
  qrcode: string;
}

export async function requestQrToken(profile: SiteProfile): Promise<QrToken> {
  const config = profile.qrLogin;
  if (!config) throw new Error('该站点未配置扫码登录');
  const response = await fetch(config.tokenUrl, {
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`获取二维码失败：HTTP ${response.status}`);
  const data = (await response.json().catch(() => null)) as
    | { state?: unknown; error?: unknown; data?: { uid?: unknown; time?: unknown; sign?: unknown; qrcode?: unknown } }
    | null;
  if (data?.state !== 1 || !data.data?.uid)
    throw new Error((typeof data?.error === 'string' && data.error) || '获取二维码失败，端点可能已变更');
  return {
    uid: String(data.data.uid),
    time: Number(data.data.time) || 0,
    sign: String(data.data.sign || ''),
    qrcode: String(data.data.qrcode || ''),
  };
}

export type QrStatus = -2 | -1 | 0 | 1 | 2;

export async function pollQrStatus(profile: SiteProfile, token: QrToken): Promise<QrStatus> {
  const config = profile.qrLogin;
  if (!config) throw new Error('该站点未配置扫码登录');
  const url = `${config.statusUrl}?uid=${encodeURIComponent(token.uid)}&time=${token.time}&sign=${encodeURIComponent(token.sign)}`;
  const response = await fetch(url, {
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`二维码状态查询失败：HTTP ${response.status}`);
  const data = (await response.json().catch(() => null)) as { state?: unknown; error?: unknown; data?: { status?: unknown } | number } | null;
  // Observed shapes differ across endpoint generations; accept both
  // {data:{status}} and {data} being the status number itself.
  const status = Number(typeof data?.data === 'number' ? data.data : data?.data?.status);
  if (![-2, -1, 0, 1, 2].includes(status))
    throw new Error((typeof data?.error === 'string' && data.error) || '二维码状态无法识别');
  return status as QrStatus;
}

export interface QrLoginResult {
  /** Cookie values parsed from the response body — a best-effort backup for Set-Cookie. */
  cookies: Record<string, string>;
}

/**
 * Confirms the scanned login. The response's Set-Cookie headers land in the
 * browser cookie jar via the credentialed fetch; the body values are parsed
 * only as a fallback for cookies the jar did not receive.
 */
export async function completeQrLogin(profile: SiteProfile, token: QrToken): Promise<QrLoginResult> {
  const config = profile.qrLogin;
  if (!config) throw new Error('该站点未配置扫码登录');
  const response = await fetch(config.loginUrl, {
    method: 'POST',
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ app: config.app, account: token.uid }).toString(),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`扫码登录确认失败：HTTP ${response.status}`);
  const data = (await response.json().catch(() => null)) as
    | { state?: unknown; error?: unknown; data?: { cookie?: unknown } | null }
    | null;
  if (data?.state !== 1) throw new Error((typeof data?.error === 'string' && data.error) || '扫码登录确认失败');
  const cookies: Record<string, string> = {};
  const parseCookieString = (raw: string) => {
    for (const part of raw.split(';')) {
      const separator = part.indexOf('=');
      if (separator <= 0) continue;
      cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    }
  };
  const container = data.data?.cookie;
  if (typeof container === 'string') {
    parseCookieString(container);
  } else if (container && typeof container === 'object') {
    // Observed responses wrap the raw "k=v; k=v" string under a `cookie` field.
    const inner = (container as Record<string, unknown>).cookie;
    if (typeof inner === 'string') parseCookieString(inner);
    else
      for (const [name, value] of Object.entries(container as Record<string, unknown>)) {
        if (typeof value === 'string' || typeof value === 'number') cookies[name] = String(value);
      }
  }
  return { cookies };
}

export const siteProfiles: SiteProfile[] = [profile115, profileXiaohongshu, profileDouyin];
