import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assertOutsideSource, ownedPath } from './workspace-lib.mjs';

test('build outputs and owned cleanup cannot escape their designated directories', () => {
  const root = path.resolve('source');
  assert.throws(() => assertOutsideSource(root, root));
  assert.throws(() => assertOutsideSource(root, path.join(root, 'node_modules')));
  assert.doesNotThrow(() => assertOutsideSource(root, path.resolve('external-cache')));
  assert.throws(() => ownedPath(root, '../important'));
  assert.equal(ownedPath(root, 'dist/manifest.json'), path.join(root, 'dist', 'manifest.json'));
});
