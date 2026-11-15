import type { ICookie } from '@sync-your-cookie/protobuf';

const loginSites = ['xiaohongshu.com', 'douyin.com', '115.com'];
const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function syncCookieDomain(host: string): string {
  const normalized = host.toLowerCase().replace(/:\d+$/, '').replace(/^\./, '');
  return loginSites.find(domain => within(normalized, domain)) || normalized;
}

export function matchesSyncDomain(host: string, cookieDomain: string): boolean {
  const normalized = cookieDomain.toLowerCase().replace(/^\./, '');
  const scope = syncCookieDomain(host);
  return loginSites.includes(scope) ? within(normalized, scope) : within(host.replace(/:\d+$/, ''), normalized);
}

export function cookieSetDetails(cookie: ICookie, activeTabUrl: string): chrome.cookies.SetDetails | undefined {
  const page = new URL(activeTabUrl);
  if (!cookie.domain || !matchesSyncDomain(page.hostname, cookie.domain)) return;
  // Protobuf's missing numeric field becomes 0. Session cookies MUST omit expiry.
  const expirationDate = cookie.session ? undefined : cookie.expirationDate ?? undefined;
  if (expirationDate !== undefined && expirationDate <= Date.now() / 1000) return;
  const path = cookie.path || '/';
  const sameSite = cookie.sameSite || undefined;
  return {
    url: `${cookie.secure ? 'https:' : page.protocol}//${cookie.domain.replace(/^\./, '')}${path}`,
    domain: cookie.domain.startsWith('.') ? cookie.domain : undefined,
    name: cookie.name ?? undefined,
    value: cookie.value ?? undefined,
    // Restore into this browser context, not the source device's store ID.
    storeId: undefined,
    expirationDate,
    path,
    httpOnly: cookie.httpOnly ?? undefined,
    secure: cookie.secure ?? undefined,
    sameSite: sameSite as chrome.cookies.SameSiteStatus | undefined,
  };
}
