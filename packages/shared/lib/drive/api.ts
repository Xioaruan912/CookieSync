import { driveAccountStorage } from '@sync-your-cookie/storage/lib/driveStorage';

const api = 'https://www.googleapis.com/drive/v3';
const upload = 'https://www.googleapis.com/upload/drive/v3';
export const driveFileName = 'CookieSync-cookies-v1.txt';
export const driveScope = 'https://www.googleapis.com/auth/drive.appdata';
export const isDriveConfigured = () => !!chrome.runtime.getManifest().oauth2?.client_id;

async function token(interactive = false): Promise<string> {
  if (!isDriveConfigured()) throw new Error('维护者尚未配置 Google 登录，请暂用 WebDAV；无需填写个人客户端 ID');
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive, scopes: [driveScope] }, value => {
      if (chrome.runtime.lastError || !value) reject(new Error('请在设置中点击“使用 Google 登录”完成云端硬盘授权'));
      else resolve(value);
    });
  });
}

async function request(
  url: string,
  init: RequestInit = {},
  accessToken?: string,
  expectedUserId?: string,
): Promise<Response> {
  let current = accessToken || (await token());
  for (let attempt = 0; attempt < 2; attempt++) {
    if (expectedUserId) {
      const account = await driveAccountStorage.get();
      if (!account.connected || account.userId !== expectedUserId)
        throw new Error('Google 连接或账号已变化，请重新连接，已停止同步');
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${current}`);
    const res = await fetch(url, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (res.status === 401 && attempt === 0) {
      await chrome.identity.removeCachedAuthToken({ token: current });
      current = await token(); // Never open an authorization popup in background work.
      if (expectedUserId) {
        const identity = await fetch(`${api}/about?fields=user(permissionId)`, {
          headers: { Authorization: `Bearer ${current}` },
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        });
        if (!identity.ok || (await identity.json()).user?.permissionId !== expectedUserId)
          throw new Error('Google 账号已变化，请重新连接，已停止跨账号同步');
      }
      continue;
    }
    if (!res.ok) {
      if (res.status === 412) throw new Error('Google Drive 文件发生冲突，已停止覆盖，请重新拉取');
      if (res.status === 401) throw new Error('Google 授权已失效，请在设置中重新连接');
      if (res.status === 403) throw new Error('Google Drive 拒绝访问，请检查 Drive API、授权范围或配额');
      throw new Error(`Google Drive HTTP ${res.status}，未修改本机待同步数据`);
    }
    return res;
  }
  throw new Error('Google 授权失败');
}

async function user(accessToken?: string, expectedUserId?: string) {
  const res = await request(`${api}/about?fields=user(permissionId,emailAddress)`, {}, accessToken, expectedUserId);
  const data = await res.json();
  if (!data.user?.permissionId) throw new Error('无法确认 Google Drive 账号');
  return { userId: data.user.permissionId as string, email: data.user.emailAddress as string | undefined };
}

export async function connectDrive() {
  const accessToken = await token(true);
  const profile = await user(accessToken);
  await driveAccountStorage.set({ connected: true, ...profile });
  return profile;
}

export async function disconnectDrive() {
  await driveAccountStorage.set({ connected: false });
  await chrome.identity.clearAllCachedAuthTokens();
}

async function assertAccount(accessToken: string) {
  const account = await driveAccountStorage.get();
  if (!account.connected || !account.userId) throw new Error('请先在此电脑点击“使用 Google 登录”连接云端硬盘');
  const current = await user(accessToken, account.userId);
  if (current.userId !== account.userId) throw new Error('Google 账号已变化，请重新连接，已停止跨账号同步');
  return account.userId;
}

async function findFile(accessToken: string, userId: string): Promise<string | undefined> {
  const query = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name = '${driveFileName}' and trashed = false`,
    fields: 'files(id),nextPageToken',
    pageSize: '100',
  });
  const res = await request(`${api}/files?${query}`, {}, accessToken, userId);
  const data = await res.json();
  if (!Array.isArray(data.files)) throw new Error('Google Drive 文件列表格式错误');
  if (data.files.length > 1 || data.nextPageToken)
    throw new Error('发现多个 CookieSync 同步文件，已停止覆盖，请先处理重复文件');
  return data.files[0]?.id;
}

export interface DriveSnapshot {
  content: string;
  userId: string;
  id?: string;
  etag?: string;
}

export async function readDrive(): Promise<DriveSnapshot> {
  const accessToken = await token();
  const userId = await assertAccount(accessToken);
  const id = await findFile(accessToken, userId);
  if (!id) return { userId, content: '' };
  const res = await request(`${api}/files/${encodeURIComponent(id)}?alt=media`, {}, accessToken, userId);
  return { userId, id, content: await res.text(), etag: res.headers.get('etag') || undefined };
}

export async function writeDrive(content: string, previous: DriveSnapshot) {
  const accessToken = await token();
  if ((await assertAccount(accessToken)) !== previous.userId) throw new Error('Google 账号不一致，已停止写入');
  const id = await findFile(accessToken, previous.userId);
  if (id !== previous.id) throw new Error('Google Drive 同步文件已变化，请重新拉取');
  if (id) {
    if (!previous.etag || previous.etag.startsWith('W/'))
      throw new Error('Google Drive 未返回强 ETag，已停止不安全覆盖');
    await request(
      `${upload}/files/${encodeURIComponent(id)}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'If-Match': previous.etag },
        body: content,
      },
      accessToken,
      previous.userId,
    );
  } else {
    const boundary = `cookiesync_${crypto.randomUUID()}`;
    const metadata = JSON.stringify({ name: driveFileName, parents: ['appDataFolder'] });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--\r\n`;
    await request(
      `${upload}/files?uploadType=multipart&fields=id`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      },
      accessToken,
      previous.userId,
    );
    await findFile(accessToken, previous.userId); // Surface simultaneous first-create duplicates instead of silently selecting one.
  }
  return { success: true, errors: [] };
}
