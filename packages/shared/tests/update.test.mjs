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
const manifest = { version: '1.13.0', version_name: '1.13.0 (build 24)' };
globalThis.chrome = {
  storage: { local: area(), sync: area(), session: area() },
  runtime: { getManifest: () => manifest },
};

const update = require('../lib/update/index.ts');
const { updateStatusStorage } = require('@sync-your-cookie/storage/lib/updateStatusStorage');

const statusKey = 'cookiesync-update-status';
const readStatus = async () => (await chrome.storage.local.get(statusKey))[statusKey];
const release = (tag, assets = true) => ({
  tag_name: tag,
  assets: assets
    ? [
        { name: 'CookieSync-chrome-1.13.0.zip', browser_download_url: 'https://example.test/CookieSync-chrome-1.13.0.zip' },
        { name: 'SHA256SUMS.txt', browser_download_url: 'https://example.test/SHA256SUMS.txt' },
      ]
    : [],
});
const mockRelease = tag => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(release(tag)), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

test('release comparison: semver first, then the build of the same version', () => {
  assert.equal(update.isNewerRelease({ version: '1.14.0' }, '1.13.0', 29), true);
  assert.equal(update.isNewerRelease({ version: '1.13.1' }, '1.13.0', 29), true);
  assert.equal(update.isNewerRelease({ version: '1.13.0', build: 30 }, '1.13.0', 29), true, 'a newer build is newer code');
  assert.equal(update.isNewerRelease({ version: '1.13.0', build: 29 }, '1.13.0', 29), false);
  assert.equal(update.isNewerRelease({ version: '1.13.0', build: 28 }, '1.13.0', 29), false);
  assert.equal(
    update.isNewerRelease({ version: '1.13.0', build: 30 }, '1.13.0', undefined),
    true,
    'an unknown installed build offers one update',
  );
  assert.equal(update.isNewerRelease({ version: '1.13.0' }, '1.13.0', 29), false, 'no build info cannot be newer');
  assert.equal(update.isNewerRelease({ version: '1.12.0', build: 99 }, '1.13.0', 29), false, 'older semver never wins');
});

test('installed build number comes from the manifest version_name', () => {
  assert.equal(update.installedBuildNumber(), 24);
  const original = manifest.version_name;
  delete manifest.version_name;
  assert.equal(update.installedBuildNumber(), undefined);
  manifest.version_name = '1.13.0 (build 123)';
  assert.equal(update.installedBuildNumber(), 123);
  manifest.version_name = original;
});

test('checkLatestRelease marks same-version build bumps as available', async () => {
  mockRelease('v1.13.0-build.30');
  await update.checkLatestRelease();
  const status = await readStatus();
  assert.equal(status.state, 'available');
  assert.equal(status.latestVersion, '1.13.0');
  assert.equal(status.latestBuild, 30);
  assert.match(status.zipUrl, /CookieSync-chrome-1\.13\.0\.zip$/);
});

test('the installed build stays idle and a ready download survives a re-check', async () => {
  mockRelease('v1.13.0-build.24');
  await update.checkLatestRelease();
  assert.equal((await readStatus()).state, 'idle', 'released build equal to the installed build must not prompt');

  await updateStatusStorage.update({
    state: 'ready',
    latestVersion: '1.13.0',
    latestBuild: 30,
    downloadedAt: 123,
    downloadName: 'CookieSync-chrome-1.13.0.zip',
  });
  mockRelease('v1.13.0-build.30');
  await update.checkLatestRelease();
  const status = await readStatus();
  assert.equal(status.state, 'ready', 'a downloaded build must not be invalidated by re-checks');
  assert.equal(status.downloadedAt, 123);
});

test('updating past the release clears the guided-download state', async () => {
  await updateStatusStorage.update({ state: 'ready', latestVersion: '1.13.0', latestBuild: 30, downloadedAt: 1 });
  const original = manifest.version_name;
  manifest.version_name = '1.13.0 (build 30)';
  mockRelease('v1.13.0-build.30');
  await update.checkLatestRelease();
  const status = await readStatus();
  assert.equal(status.state, 'idle');
  assert.equal(status.downloadedAt, undefined);
  manifest.version_name = original;
});

test('a missing release ZIP and unparsable tags surface as errors, not updates', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(release('v1.13.0-build.40', false)), {
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
      url: 'https://github.com/Xioaruan912/CookieSync/releases/tag/v1.13.0-build.40',
    };
  };
  await update.checkLatestRelease();
  const status = await readStatus();
  assert.equal(status.state, 'available');
  assert.equal(status.latestVersion, '1.13.0');
  assert.equal(status.latestBuild, 40);
  assert.equal(
    status.zipUrl,
    'https://github.com/Xioaruan912/CookieSync/releases/download/v1.13.0-build.40/CookieSync-chrome-1.13.0.zip',
  );
  assert.equal(
    status.shaUrl,
    'https://github.com/Xioaruan912/CookieSync/releases/download/v1.13.0-build.40/SHA256SUMS.txt',
  );
});

test('both channels failing leaves an actionable network message', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  await update.checkLatestRelease();
  assert.match((await readStatus()).error || '', /无法连接 GitHub/);
});
