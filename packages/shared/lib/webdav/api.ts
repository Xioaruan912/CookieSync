export interface WebdavConfig {
  url: string;
  username: string;
  password: string;
  path: string;
  allowUnsafeWrites?: boolean;
}

export interface WebdavSnapshot {
  content: string;
  exists: boolean;
  etag?: string;
}

export function buildWebdavUrl(config: WebdavConfig): string {
  let base: URL;
  try {
    base = new URL(config.url.trim());
  } catch {
    throw new Error('请输入有效的 WebDAV URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    throw new Error('WebDAV 必须使用 HTTPS（仅本机测试允许 HTTP）');
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new Error('URL 不得包含账号、密码、查询参数或片段，请在独立字段填写凭据');
  }
  if (!config.username.trim() || config.username.includes(':') || !config.password) {
    throw new Error('请填写 WebDAV 用户名和密码／应用密码，用户名不能包含冒号');
  }
  const path = config.path.trim().replace(/^\/+/, '');
  if (!path || path.endsWith('/') || path.includes('\\') || /[\u0000-\u001f]/.test(path) || /^[a-z]+:/i.test(path)) {
    throw new Error('远程路径必须是相对于 WebDAV URL 的文件路径');
  }
  const segments = path.split('/');
  if (segments.some(segment => !segment || ['.', '..'].includes(segment) || /%2e|%2f|%5c/i.test(segment))) {
    throw new Error('远程文件路径不能包含空目录、相对跳转或转义路径分隔符');
  }
  base.pathname = base.pathname.replace(/\/?$/, '/') + segments.map(encodeURIComponent).join('/');
  return base.href;
}

async function request(config: WebdavConfig, method: string, body?: string, headers: Record<string, string> = {}) {
  const url = buildWebdavUrl(config);
  const bytes = new TextEncoder().encode(`${config.username}:${config.password}`);
  const auth = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, {
      method,
      body,
      headers: { Authorization: `Basic ${auth}`, ...headers },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    // Consume under the same deadline, including a stalled response body.
    const content = await response.text();
    return { response, content };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('WebDAV 请求超时，请检查网络后重试');
    throw new Error('WebDAV 连接失败：请检查地址、证书和网络；不允许重定向，请填写最终地址');
  } finally {
    clearTimeout(timer);
  }
}

function checkStatus(response: Response, allowMissing = false, method = 'PUT') {
  if (response.ok || (allowMissing && response.status === 404)) return;
  const hints: Record<number, string> = {
    401: '用户名或密码错误',
    403: '没有读写权限',
    404: '目录不存在，请先在服务器创建目录',
    409: '目录不存在或写入冲突',
    412: '写入条件不满足：可能是版本冲突、文件锁或服务器条件写入不兼容，本次未上传',
    423: '文件被锁定，请稍后重试',
    507: '服务器空间不足',
  };
  throw new Error(`WebDAV ${method} HTTP ${response.status}：${hints[response.status] || '服务器请求失败'}`);
}

export async function readWebdav(config: WebdavConfig): Promise<WebdavSnapshot> {
  const { response, content } = await request(config, 'GET');
  checkStatus(response, true, 'GET');
  return {
    content: response.status === 404 ? '' : content.trim(),
    exists: response.status !== 404,
    etag: response.headers.get('ETag') || undefined,
  };
}

export async function writeWebdav(config: WebdavConfig, content: string, previous: WebdavSnapshot) {
  if (previous.exists && (!previous.etag || previous.etag.startsWith('W/')) && !config.allowUnsafeWrites) {
    throw new Error('WebDAV 服务器未提供强 ETag，已阻止覆盖；请更换服务器，或明确开启不安全兼容模式');
  }
  const headers: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8' };
  if (config.allowUnsafeWrites) {
    // Explicit opt-in for gateways which reject conditional PUT. This detects prior
    // changes but cannot make the subsequent read/PUT pair atomic across devices.
    const latest = await readWebdav(config);
    if (latest.exists !== previous.exists || latest.content !== previous.content) {
      throw new Error('WebDAV 内容发生冲突，已停止覆盖；请刷新远程列表后确认数据');
    }
  } else if (!previous.exists) headers['If-None-Match'] = '*';
  else if (previous.etag && !previous.etag.startsWith('W/')) headers['If-Match'] = previous.etag;
  const { response } = await request(config, 'PUT', content, headers);
  checkStatus(response);
  return { success: true, errors: [] };
}

export async function testWebdavConnection(config: WebdavConfig): Promise<void> {
  buildWebdavUrl(config);
  // A sibling probe exercises the same directory permissions without touching cookies.
  const probe = { ...config, path: `${config.path}.connection-test-${crypto.randomUUID()}` };
  const marker = `CookieSync connection test ${crypto.randomUUID()}`;
  await writeWebdav(probe, marker, { content: '', exists: false });
  let readError: unknown;
  try {
    const initial = await readWebdav(probe);
    if (initial.content !== marker) throw new Error('WebDAV 测试文件内容不一致');
    const overwritten = marker + ' overwritten';
    await writeWebdav(probe, overwritten, initial);
    if ((await readWebdav(probe)).content !== overwritten) throw new Error('WebDAV 测试文件覆盖后内容不一致');
  } catch (error) {
    readError = error;
  }
  try {
    const { response } = await request(probe, 'DELETE');
    checkStatus(response, true, 'DELETE');
  } catch {
    throw new Error('WebDAV 测试文件清理失败，请手动删除远程 .connection-test- 文件并检查 DELETE 权限');
  }
  if (readError) throw readError;
}
