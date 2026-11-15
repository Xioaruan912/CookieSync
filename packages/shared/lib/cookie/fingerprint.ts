import type { ICookie, ICookiesMap, ILocalStorageItem } from '@sync-your-cookie/protobuf';

type DomainContent = { cookies?: ICookie[] | null; localStorageItems?: ILocalStorageItem[] | null };
const sort = (values: unknown[]) => values.map(value => JSON.stringify(value)).sort();

async function hash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function cookiesValue(cookies: ICookie[] = []) {
  return sort(
    cookies.map(cookie => ({
      domain: cookie.domain || '',
      name: cookie.name || '',
      value: cookie.value || '',
      path: cookie.path || '/',
      session: !!cookie.session,
      hostOnly: !cookie.domain?.startsWith('.'),
      secure: !!cookie.secure,
      httpOnly: !!cookie.httpOnly,
      sameSite: cookie.sameSite || 'unspecified',
      // Align with the upstream protobuf float field; session cookies have no expiry.
      expirationDate: cookie.session || !cookie.expirationDate ? null : Math.fround(Number(cookie.expirationDate)),
    })),
  );
}

export const cookieContentHash = (cookies: ICookie[] = []) => hash(cookiesValue(cookies));
export const localStorageContentHash = (items: ILocalStorageItem[] = []) =>
  hash(sort(items.map(item => [item.key || '', item.value || ''])));

function domainValue(domain: DomainContent = {}) {
  return {
    cookies: cookiesValue(domain.cookies || []),
    localStorage: sort((domain.localStorageItems || []).map(item => [item.key || '', item.value || ''])),
  };
}

export const domainContentHash = (domain?: DomainContent | null) => hash(domainValue(domain || {}));
export const cookiesMapContentHash = (map: ICookiesMap = {}) =>
  hash(
    Object.keys(map.domainCookieMap || {})
      .sort()
      .map(domain => [domain, domainValue(map.domainCookieMap![domain])]),
  );
