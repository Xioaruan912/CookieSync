import { test } from 'node:test';
import assert from 'node:assert/strict';
const { cookieContentHash, domainContentHash, cookiesMapContentHash } = await import('../lib/cookie/fingerprint.ts');

test('semantic fingerprints ignore order, timestamps and device-specific metadata', async () => {
  const a = {
    cookies: [
      { name: 'sid', value: 'A', domain: '.115.com', path: '/', session: true, storeId: '0' },
      { name: 'x', value: 'B', domain: '.115.com' },
    ],
    localStorageItems: [
      { key: 'b', value: '2' },
      { key: 'a', value: '1' },
    ],
    updateTime: 1,
    userAgent: 'one',
  };
  const b = {
    ...a,
    cookies: [
      { ...a.cookies[1], sameSite: 'unspecified' },
      { ...a.cookies[0], expirationDate: 0, storeId: '1' },
    ],
    localStorageItems: [...a.localStorageItems].reverse(),
    updateTime: 99,
    userAgent: 'two',
  };
  assert.equal(await domainContentHash(a), await domainContentHash(b));
  assert.notEqual(
    await domainContentHash(a),
    await domainContentHash({ ...a, cookies: [{ ...a.cookies[0], value: 'new' }] }),
  );
  assert.equal(
    await cookiesMapContentHash({ domainCookieMap: { '115.com': a, 'douyin.com': b }, updateTime: 1 }),
    await cookiesMapContentHash({ domainCookieMap: { 'douyin.com': b, '115.com': a }, updateTime: 99 }),
  );
});

test('cookie fingerprints align protobuf expiry precision but preserve session and value changes', async () => {
  const cookie = { name: 'sid', value: 'value', domain: '.douyin.com', session: false, expirationDate: 1900000123.123 };
  assert.equal(
    await cookieContentHash([cookie]),
    await cookieContentHash([{ ...cookie, expirationDate: Math.fround(cookie.expirationDate) }]),
  );
  assert.notEqual(await cookieContentHash([cookie]), await cookieContentHash([{ ...cookie, session: true }]));
});
