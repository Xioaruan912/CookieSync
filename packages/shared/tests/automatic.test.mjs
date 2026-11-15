import { test } from 'node:test';
import assert from 'node:assert/strict';
const { acknowledgeJobs, canRestoreAtStartup, automaticIntervalMs, pickAutomaticLocalItems } = await import(
  '../lib/cookie/automatic.ts'
);

test('acknowledgement preserves newer changes queued during an upload', () => {
  const old = { domain: '115.com', revision: 'old' };
  const newer = { ...old, revision: 'new' };
  assert.deepEqual(acknowledgeJobs({ '115.com': old }, { '115.com': old }), {});
  assert.deepEqual(acknowledgeJobs({ '115.com': newer }, { '115.com': old }), { '115.com': newer });
});

test('startup respects send-only roles and never overwrites offline pending changes', () => {
  assert.ok(canRestoreAtStartup('douyin.com', undefined, {}));
  assert.ok(canRestoreAtStartup('douyin.com', true, {}));
  assert.ok(!canRestoreAtStartup('douyin.com', false, {}));
  assert.ok(!canRestoreAtStartup('douyin.com', true, { 'douyin.com': { revision: 'pending' } }));
});

test('automatic interval defaults to two minutes and enforces sane bounds', () => {
  assert.equal(automaticIntervalMs(), 120000);
  assert.equal(automaticIntervalMs(0), 60000);
  assert.equal(automaticIntervalMs(90), 3600000);
});

test('closed tab fallback retains the newest queued localStorage, including explicit empty snapshots', () => {
  const cached = [{ key: 'token', value: 'old' }];
  const pending = { localStorageItems: [{ key: 'token', value: 'new' }] };
  assert.equal(pickAutomaticLocalItems(undefined, pending, cached)[0].value, 'new');
  assert.deepEqual(pickAutomaticLocalItems([], pending, cached), []);
});

test('successful upload rebases newer retained revisions to the just-written snapshot', () => {
  const sent = { '115.com': { domain: '115.com', revision: 'B', baseHash: 'A' } };
  const newer = { '115.com': { domain: '115.com', revision: 'C', baseHash: 'A' } };
  assert.deepEqual(acknowledgeJobs(newer, sent, { '115.com': 'B-hash' }), {
    '115.com': { domain: '115.com', revision: 'C', baseHash: 'B-hash' },
  });
});
