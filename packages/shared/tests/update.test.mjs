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
const manifest = { version: '2.0.0' };
const shownDownloads = [];
let openedDefaultFolder = 0;
globalThis.chrome = {
  storage: { local: area(), sync: area(), session: area() },
  runtime: { getManifest: () => manifest },
  downloads: {
    show: id => shownDownloads.push(id),
    showDefaultFolder: () => {
      openedDefaultFolder += 1;
    },
  },
};

const update = require('../lib/update/index.ts');
const { updateStatusStorage } = require('@sync-your-cookie/storage/lib/updateStatusStorage');

const statusKey = 'cookiesync-update-status';
const readStatus = async () => (await chrome.storage.local.get(statusKey))[statusKey];
const release = (tag, assets = true, zipVersion = '2.0.1') => ({
  tag_name: tag,
  assets: assets
    ? [
        {
          name: `CookieSync-chrome-${zipVersion}.zip`,
          browser_download_url: `https://example.test/CookieSync-chrome-${zipVersion}.zip`,
        },
        { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.test/SHA256SUMS.txt' },
      ]
    : [],
});
const mockRelease = (tag, zipVersion = '2.0.1') => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(release(tag, true, zipVersion)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
};

test('release comparison uses clean semantic versions and ignores build numbers', () => {
  assert.equal(update.isNewerRelease({ version: '2.1.0' }, '2.0.0'), true);
  assert.equal(update.isNewerRelease({ version: '2.0.1' }, '2.0.0'), true);
  assert.equal(update.isNewerRelease({ version: '2.0.0', build: 99 }, '2.0.0'), false);
  assert.equal(update.isNewerRelease({ version: '2.0.0' }, '2.0.0'), false);
  assert.equal(update.isNewerRelease({ version: '1.13.9', build: 99 }, '2.0.0'), false);
  assert.deepEqual(update.parseReleaseTag('v2.0.1'), { version: '2.0.1', build: undefined });
  assert.deepEqual(update.parseReleaseTag('v2.0.0-build.42'), { version: '2.0.0', build: 42 });
});

test('same-version releases stay idle and clear stale download offers', async () => {
  await updateStatusStorage.update({
    state: 'ready',
    latestVersion: '2.0.0',
    downloadedAt: 123,
    downloadName: 'CookieSync-chrome-2.0.0.zip',
    downloadId: 7,
    zipUrl: 'https://example.test/stale.zip',
  });
  mockRelease('v2.0.0', '2.0.0');
  await update.checkLatestRelease();
  const status = await readStatus();
  assert.equal(status.state, 'idle');
  assert.equal(status.latestVersion, '2.0.0');
  assert.equal(status.latestBuild, undefined);
  assert.equal(status.downloadName, undefined);
  assert.equal(status.downloadId, undefined);
  assert.equal(status.zipUrl, undefined);
});

test('checkLatestRelease marks newer semantic versions as available', async () => {
  mockRelease('v2.0.1', '2.0.1');
  await update.checkLatestRelease();
  const status = await readStatus();
  assert.equal(status.state, 'available');
  assert.equal(status.latestVersion, '2.0.1');
  assert.equal(status.latestBuild, undefined);
  assert.match(status.zipUrl, /CookieSync-chrome-2\.0\.1\.zip$/);
});

test('a ready download for the latest version survives a re-check and clears once upgraded', async () => {
  await updateStatusStorage.update({
    state: 'ready',
    latestVersion: '2.0.1',
    downloadedAt: 123,
    downloadName: 'CookieSync-chrome-2.0.1.zip',
    downloadId: 42,
  });
  mockRelease('v2.0.1', '2.0.1');
  await update.checkLatestRelease();
  let status = await readStatus();
  assert.equal(status.state, 'ready');
  assert.equal(status.downloadedAt, 123);

  manifest.version = '2.0.1';
  try {
    await update.checkLatestRelease();
    status = await readStatus();
    assert.equal(status.state, 'idle');
    assert.equal(status.downloadedAt, undefined);
    assert.equal(status.downloadId, undefined);
  } finally {
    manifest.version = '2.0.0';
  }
});

test('showDownloadedRelease reveals the specific download or falls back to Downloads folder', () => {
  shownDownloads.length = 0;
  openedDefaultFolder = 0;
  update.showDownloadedRelease(88);
  assert.deepEqual(shownDownloads, [88]);
  assert.equal(openedDefaultFolder, 0);
  update.showDownloadedRelease(undefined);
  assert.equal(openedDefaultFolder, 1);
});

test('a missing release ZIP and unparsable tags surface as errors, not updates', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(release('v2.0.2', false)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  await update.checkLatestRelease();
  assert.match((await readStatus()).error || '', /无法从发布页面识别版本|未找到安装 ZIP/);

  globalThis.fetch = async () =>
    new Response(JSON.stringify(release('nightly-2026-01-01')), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  await update.checkLatestRelease();
  assert.match((await readStatus()).error || '', /无法从发布页面识别版本|标签格式/);
});

test('a blocked API falls back to the releases page redirect and rebuilds asset URLs', async () => {
  globalThis.fetch = async url => {
    if (String(url).includes('api.github.com')) throw new TypeError('Failed to fetch');
    return {
      ok: true,
      status: 200,
      url: 'https://github.com/Xioaruan912/CookieSync/releases/tag/v2.1.0',
    };
  };
  await update.checkLatestRelease();
  const status = await readStatus();
  assert.equal(status.state, 'available');
  assert.equal(status.latestVersion, '2.1.0');
  assert.equal(
    status.zipUrl,
    'https://github.com/Xioaruan912/CookieSync/releases/download/v2.1.0/CookieSync-chrome-2.1.0.zip',
  );
  assert.equal(
    status.shaUrl,
    'https://github.com/Xioaruan912/CookieSync/releases/download/v2.1.0/SHA256SUMS.txt',
  );
});

test('both channels failing leaves an actionable network message', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await update.checkLatestRelease();
  assert.match((await readStatus()).error || '', /无法连接 GitHub/);
});
