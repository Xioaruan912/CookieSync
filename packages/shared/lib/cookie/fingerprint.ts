import type { ICookie, ICookiesMap, ILocalStorageItem } from '@sync-your-cookie/protobuf';

type DomainContent = {
  cookies?: ICookie[] | null;
  localStorageItems?: ILocalStorageItem[] | null;
  sessionStorageItems?: ILocalStorageItem[] | null;
  indexedDBRecords?: { origin?: string | null; database?: string | null; store?: string | null; key?: string | null; value?: string | null }[] | null;
};
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

/** Origin is part of the identity: the same key on another origin is another value. */
const storageValue = (items: ILocalStorageItem[] = []) =>
  sort(items.map(item => ({ origin: item.origin || '', key: item.key || '', value: item.value || '' })));

export const cookieContentHash = (cookies: ICookie[] = []) => hash(cookiesValue(cookies));
export const localStorageContentHash = (items: ILocalStorageItem[] = []) => hash(storageValue(items));

function domainValue(domain: DomainContent = {}) {
  return {
    cookies: cookiesValue(domain.cookies || []),
    localStorage: storageValue(domain.localStorageItems || []),
    sessionStorage: storageValue(domain.sessionStorageItems || []),
    indexedDB: sort(
      (domain.indexedDBRecords || []).map(record => ({
        origin: record.origin || '',
        database: record.database || '',
        store: record.store || '',
        key: record.key || '',
        value: record.value || '',
      })),
    ),
  };
}

export const domainContentHash = (domain?: DomainContent | null) => hash(domainValue(domain || {}));
export const cookiesMapContentHash = (map: ICookiesMap = {}) =>
  hash(
    Object.keys(map.domainCookieMap || {})
      .sort()
      .map(domain => [domain, domainValue(map.domainCookieMap![domain])]),
  );
