import type { ICookie } from '@sync-your-cookie/protobuf';

const loginSites = ['xiaohongshu.com', 'douyin.com', '115.com'];
const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export const canonicalSiteHost = (host: string) => host.toLowerCase().replace(/^www\./, '');
export const matchesSitePage = (site: string, pageHost: string) =>
  canonicalSiteHost(site) === canonicalSiteHost(pageHost);

/**
 * Site family match used for page storage: `app.115.com` belongs to `115.com`,
 * while `evil-example.com` never matches `example.com`. Exact origins are
 * compared separately before anything is written.
 */
export const matchesSiteScope = (site: string, pageHost: string) => {
  const scope = canonicalSiteHost((site || '').replace(/:\d+$/, ''));
  const host = canonicalSiteHost((pageHost || '').replace(/:\d+$/, ''));
  if (!scope || !host) return false;
  return host === scope || host.endsWith(`.${scope}`);
};

export async function collectSiteCookies(sourceUrl: string): Promise<chrome.cookies.Cookie[]> {
  const page = new URL(sourceUrl);
  if (!['http:', 'https:'].includes(page.protocol)) return [];
  const scope = syncCookieDomain(canonicalSiteHost(page.hostname));
  // URL filtering hides cookies on other paths; domain filtering hides parent cookies.
  // Inspect the current context's store and retain only this site's child/applicable parent domains.
  // Other cookie domains are never registered or persisted from this transient response.
  const cookies = await chrome.cookies.getAll({});
  return cookies.filter(cookie => {
    const domain = cookie.domain.toLowerCase().replace(/^\./, '');
    return within(domain, scope) || (!cookie.hostOnly && within(scope, domain));
  });
}

export function syncCookieDomain(host: string): string {
  const normalized = host.toLowerCase().replace(/:\d+$/, '').replace(/^\./, '');
  return loginSites.find(domain => within(normalized, domain)) || normalized;
}

export function matchesSyncDomain(host: string, cookieDomain: string): boolean {
  const normalized = cookieDomain.toLowerCase().replace(/^\./, '');
  const scope = syncCookieDomain(canonicalSiteHost(host));
  return within(normalized, scope) || within(scope, normalized);
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
