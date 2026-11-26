import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function area() {
  const data = {},
    listeners = [];
  return {
    data,
    get: async keys =>
      Object.fromEntries(
        (keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys]).map(k => [k, data[k]]),
      ),
    set: async values => {
      Object.assign(data, values);
      for (const listener of listeners)
        await listener(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])));
    },
    onChanged: { addListener: fn => listeners.push(fn) },
    setAccessLevel: async () => {},
  };
}
globalThis.chrome = { storage: { local: area(), sync: area(), session: area() } };
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'fixture' } });

const profiles = require('../lib/siteProfiles/index.ts');
const { profile115 } = require('../lib/siteProfiles/115.ts');

function reply(value, status = 200) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('the 115 profile keeps the verified login key set and a read-only health endpoint', () => {
  assert.deepEqual(profile115.loginKeys, ['UID', 'CID', 'SEID', 'KID', 'USERSESSIONID']);
  assert.ok(profile115.healthCheck.url.includes('my.115.com'), 'health check must use the read-only nav endpoint');
  assert.ok(!profile115.healthCheck.url.includes('check/sso'), 'check/sso logs out other devices and must never be used');
  assert.ok(profile115.qrLogin.tokenUrl.includes('qrcodeapi.115.com'));
  assert.equal(profiles.siteProfileFor('www.115.com'), profile115);
  assert.equal(profiles.siteProfileFor('passport.115.com'), profile115);
  assert.equal(profiles.siteProfileFor('115.com:443'), profile115);
  assert.equal(profiles.siteProfileFor('www.11586.com'), undefined, 'lookalike domains must not match');
  assert.equal(profiles.siteProfileFor('www.douyin.com').domain, 'douyin.com');
  assert.equal(profiles.siteProfileFor('www.xiaohongshu.com').domain, 'xiaohongshu.com');
});

test('xiaohongshu and douyin verify login keys locally without a network probe', () => {
  const xhs = profiles.siteProfileFor('www.xiaohongshu.com');
  const dy = profiles.siteProfileFor('www.douyin.com');
  assert.deepEqual(xhs.loginKeys, ['web_session']);
  assert.deepEqual(dy.loginKeys, ['sessionid']);
  assert.equal(xhs.healthCheck, undefined, 'signed APIs cannot serve as a stable read-only probe');
  assert.equal(dy.healthCheck, undefined);
  assert.deepEqual(profiles.missingLoginKeys(xhs, [{ name: 'web_session' }]), []);
  assert.deepEqual(profiles.missingLoginKeys(dy, []), ['sessionid']);
});

test('missingLoginKeys reports exactly the absent login cookies', () => {
  const cookies = [{ name: 'UID' }, { name: 'CID' }];
  assert.deepEqual(profiles.missingLoginKeys(profile115, cookies), ['SEID', 'KID', 'USERSESSIONID']);
  assert.deepEqual(profiles.missingLoginKeys(profile115, []), profile115.loginKeys);
  const complete = profile115.loginKeys.map(name => ({ name }));
  assert.deepEqual(profiles.missingLoginKeys(profile115, complete), []);
});

test('health check maps site answers honestly and never guesses on network errors', async () => {
  globalThis.fetch = async () => reply({ state: true, data: { user_name: 'fixture-user' } });
  const ok = await profiles.checkProfileHealth(profile115);
  assert.equal(ok.state, 'ok');
  assert.equal(ok.userName, 'fixture-user');

  globalThis.fetch = async () => reply({ state: false, error: '登录超时，请重新登录。' });
  const invalid = await profiles.checkProfileHealth(profile115);
  assert.equal(invalid.state, 'invalid');
  assert.match(invalid.message || '', /登录超时/);

  globalThis.fetch = async () => reply({}, 502);
  const unreachable = await profiles.checkProfileHealth(profile115);
  assert.equal(unreachable.state, 'unknown');

  globalThis.fetch = async () => new Response('<html>WAF challenge</html>', { status: 403, headers: { 'Content-Type': 'text/html' } });
  const challenged = await profiles.checkProfileHealth(profile115);
  assert.equal(challenged.state, 'unknown', 'a challenge page is not proof of a logged-out session');
  assert.match(challenged.message || '', /403|无法判断/);

  globalThis.fetch = async () => new Response('not json', { status: 200 });
  const garbage = await profiles.checkProfileHealth(profile115);
  assert.equal(garbage.state, 'unknown');

  globalThis.fetch = async () => reply({ state: false, error: '请先登录,后操作！' }, 401);
  const denied = await profiles.checkProfileHealth(profile115);
  assert.equal(denied.state, 'invalid');
  assert.match(denied.message || '', /请先登录/);

  globalThis.fetch = async () => {
    throw new TypeError('network down');
  };
  const broken = await profiles.checkProfileHealth(profile115);
  assert.equal(broken.state, 'unknown');
  assert.match(broken.message || '', /network/);
});

test('ua hints only fire when the browser family or platform changed', () => {
  const chromeWindows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  const chromeWindowsNew = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
  const edgeMac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0';
  assert.equal(profiles.uaMismatchHint(chromeWindows, chromeWindowsNew), undefined, 'same family and platform stays quiet');
  assert.match(profiles.uaMismatchHint(edgeMac, chromeWindows) || '', /Edge · macOS/);
  assert.equal(profiles.uaMismatchHint(undefined, chromeWindows), undefined, 'missing capture stays quiet');
});

test('qr flow completes token, status and login, and parses body cookies tolerantly', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push(target + ' ' + (init?.method || 'GET'));
    if (target.includes('/token')) return reply({ state: 1, data: { uid: 'tok-1', time: 1781179327, sign: 'sig', qrcode: '115.com/scan/dg-fixture' } });
    if (target.includes('/get/status/')) return reply({ state: 1, data: { status: 2 } });
    if (target.includes('/login/qrcode')) return reply({ state: 1, data: { cookie: { cookie: 'UID=9; CID=10; SEID=11; KID=12' } } });
    throw new Error('unexpected endpoint: ' + target);
  };
  const token = await profiles.requestQrToken(profile115);
  assert.equal(token.uid, 'tok-1');
  assert.equal(token.qrcode, '115.com/scan/dg-fixture');
  assert.equal(await profiles.pollQrStatus(profile115, token), 2);
  const login = await profiles.completeQrLogin(profile115, token);
  assert.deepEqual(login.cookies, { UID: '9', CID: '10', SEID: '11', KID: '12' });
  assert.deepEqual(calls, [
    'https://qrcodeapi.115.com/api/1.0/web/1.0/token GET',
    'https://qrcodeapi.115.com/get/status/?uid=tok-1&time=1781179327&sign=sig GET',
    'https://passportapi.115.com/app/1.0/web/1.0/login/qrcode POST',
  ]);
});

test('qr failures surface endpoint rotation and rejected logins', async () => {
  globalThis.fetch = async () => reply({ state: 0, error: '二维码接口不可用' });
  await assert.rejects(profiles.requestQrToken(profile115), /二维码接口不可用|获取二维码失败/);

  globalThis.fetch = async () => reply({ state: 1, data: { status: 4 } });
  await assert.rejects(profiles.pollQrStatus(profile115, { uid: 'u', time: 1, sign: 's', qrcode: '' }), /状态无法识别/);

  globalThis.fetch = async () => reply({ state: false, error: '登录失败，系统已下架' });
  await assert.rejects(profiles.completeQrLogin(profile115, { uid: 'u', time: 1, sign: 's', qrcode: '' }), /系统已下架/);
});

test('a profile without a health endpoint reports unknown instead of guessing', async () => {
  const bare = { domain: 'bare.example', loginKeys: ['SID'] };
  const result = await profiles.checkProfileHealth(bare);
  assert.equal(result.state, 'unknown');
});

test('baidu pan, quark pan, and bilibili use read-only health endpoints and parse honestly', async () => {
  const baidu = profiles.siteProfileFor('pan.baidu.com');
  const quark = profiles.siteProfileFor('pan.quark.cn');
  const bili = profiles.siteProfileFor('www.bilibili.com');
  const cloud189 = profiles.siteProfileFor('cloud.189.cn');

  assert.ok(baidu?.healthCheck?.url.includes('pan.baidu.com/api/loginStatus'));
  assert.ok(quark?.healthCheck?.url.includes('pan.quark.cn/account/info'));
  assert.ok(bili?.healthCheck?.url.includes('api.bilibili.com/x/web-interface/nav'));
  assert.deepEqual(cloud189?.loginKeys, ['COOKIE_LOGIN_USER']);
  assert.equal(cloud189?.singleSession, true);

  // Baidu Pan: ok / invalid / unknown
  globalThis.fetch = async () => reply({ errno: 0, login_info: { username: 'baidu-user', uk: 123 } });
  const bdOk = await profiles.checkProfileHealth(baidu);
  assert.equal(bdOk.state, 'ok');
  assert.equal(bdOk.userName, 'baidu-user');

  globalThis.fetch = async () => reply({ errno: -6 });
  assert.equal((await profiles.checkProfileHealth(baidu)).state, 'invalid');

  globalThis.fetch = async () => reply({ errno: 999 });
  assert.equal((await profiles.checkProfileHealth(baidu)).state, 'unknown');

  // Quark Pan: ok / invalid / unknown
  globalThis.fetch = async () => reply({ success: true, code: 'OK', data: { nickname: 'quark-user' } });
  const qkOk = await profiles.checkProfileHealth(quark);
  assert.equal(qkOk.state, 'ok');
  assert.equal(qkOk.userName, 'quark-user');

  globalThis.fetch = async () => reply({ success: true, code: 'OK', data: null });
  assert.equal((await profiles.checkProfileHealth(quark)).state, 'invalid');

  globalThis.fetch = async () => reply({ success: false, code: 'RATE_LIMIT' }, 429);
  assert.equal((await profiles.checkProfileHealth(quark)).state, 'unknown');

  // Bilibili: ok / invalid / unknown
  globalThis.fetch = async () => reply({ code: 0, data: { isLogin: true, uname: 'bili-user' } });
  const biOk = await profiles.checkProfileHealth(bili);
  assert.equal(biOk.state, 'ok');
  assert.equal(biOk.userName, 'bili-user');

  globalThis.fetch = async () => reply({ code: -101, message: '账号未登录', data: { isLogin: false } });
  assert.equal((await profiles.checkProfileHealth(bili)).state, 'invalid');

  globalThis.fetch = async () => reply({ code: -412, message: '风控拦截' }, 412);
  assert.equal((await profiles.checkProfileHealth(bili)).state, 'unknown');
});
