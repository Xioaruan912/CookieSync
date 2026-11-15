import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const { buildWebdavUrl, readWebdav, writeWebdav, testWebdavConnection } = await import('../lib/webdav/api.ts');

test('rejects unsafe URLs and paths; preserves base folder and encodes Unicode', () => {
  const config = {
    url: 'https://dav.example/remote.php/dav/files/me/',
    username: '用户',
    password: 'secret',
    path: '/同步/cookies #1.txt',
  };
  assert.equal(
    buildWebdavUrl(config),
    'https://dav.example/remote.php/dav/files/me/%E5%90%8C%E6%AD%A5/cookies%20%231.txt',
  );
  for (const path of ['../escape', 'a/../escape', 'https://evil.test/x', 'a\\b', 'folder/', '%2e%2e/x']) {
    assert.throws(() => buildWebdavUrl({ ...config, path }));
  }
  for (const url of ['http://dav.example/', 'https://name:password@dav.example/', 'https://dav.example/?token=x']) {
    assert.throws(() => buildWebdavUrl({ ...config, url }));
  }
});

test('real WebDAV round trip: auth, 404, ETag, conflict, probe isolation and errors', async () => {
  const files = new Map();
  let version = 0;
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, path: req.url });
    if (req.headers.authorization !== `Basic ${Buffer.from('用户:应用密码').toString('base64')}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.url.includes('redirect')) {
      res.writeHead(302, { Location: '/other' }).end();
      return;
    }
    if (req.url.includes('forbidden')) {
      res.writeHead(403).end();
      return;
    }
    const existing = files.get(req.url);
    if (req.method === 'GET') {
      if (!existing) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { ETag: existing.etag }).end(existing.body);
      return;
    }
    if (req.method === 'DELETE') {
      files.delete(req.url);
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'PUT') {
      if (
        (req.headers['if-none-match'] === '*' && existing) ||
        (req.headers['if-match'] && req.headers['if-match'] !== existing?.etag)
      ) {
        res.writeHead(412).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const etag = `"v${++version}"`;
      files.set(req.url, { body, etag });
      res.writeHead(201, { ETag: etag }).end();
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {
    url: `http://127.0.0.1:${server.address().port}/dav/`,
    username: '用户',
    password: '应用密码',
    path: 'cookies.txt',
  };
  try {
    const missing = await readWebdav(config);
    assert.equal(missing.content, '');
    assert.equal(missing.exists, false);
    assert.equal((await writeWebdav(config, '{"first":1}', missing)).success, true);
    const first = await readWebdav(config);
    assert.equal(first.content, '{"first":1}');
    assert.equal(first.exists, true);
    await writeWebdav(config, '{"second":2}', first);
    await assert.rejects(writeWebdav(config, 'stale overwrite', first), /冲突/);
    assert.equal((await readWebdav(config)).content, '{"second":2}');
    await testWebdavConnection(config);
    assert.equal(files.size, 1);
    assert.equal((await readWebdav(config)).content, '{"second":2}');
    assert.ok(requests.some(r => r.method === 'DELETE' && r.path.includes('.connection-test-')));
    await assert.rejects(readWebdav({ ...config, password: 'wrong' }), /401/);
    await assert.rejects(readWebdav({ ...config, path: 'forbidden' }), /403/);
    await assert.rejects(readWebdav({ ...config, path: 'redirect' }), /重定向/);
    assert.ok(!requests.some(r => r.path === '/other'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('blocks unsafe overwrite without strong ETag unless explicitly allowed', async () => {
  const config = { url: 'https://dav.example/', username: 'user', password: 'pass', path: 'cookies.txt' };
  for (const etag of [undefined, 'W/"weak"']) {
    await assert.rejects(writeWebdav(config, 'data', { content: '', exists: true, etag }), /ETag/);
  }
});

test('explicit compatibility mode omits rejected conditions and still detects changed content', async () => {
  let content = 'old';
  let writes = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { ETag: '"gateway-etag"' }).end(content);
      return;
    }
    if (req.headers['if-match'] || req.headers['if-none-match']) {
      res.writeHead(412).end();
      return;
    }
    writes++;
    content = '';
    for await (const chunk of req) content += chunk;
    res.writeHead(204).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {
    url: `http://127.0.0.1:${server.address().port}/dav/`,
    username: 'test',
    password: 'test',
    path: 'cookies.txt',
  };
  try {
    const previous = await readWebdav(config);
    await assert.rejects(writeWebdav(config, 'new', previous), /412/);
    await writeWebdav({ ...config, allowUnsafeWrites: true }, 'new', previous);
    assert.equal(content, 'new');
    assert.equal(writes, 1);
    await assert.rejects(writeWebdav({ ...config, allowUnsafeWrites: true }, 'stale', previous), /冲突/);
    assert.equal(writes, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
