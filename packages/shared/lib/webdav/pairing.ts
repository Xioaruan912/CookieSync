export interface PairingPayload {
  url: string;
  username: string;
  password: string;
  path: string;
  allowUnsafeWrites?: boolean;
  encryptionEnabled?: boolean;
  encryptionPassword?: string;
}

const PREFIX = 'cookiesync://pair#v1.';

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + pad);
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Encodes WebDAV + optional encryption settings into a compact local-only
 * pairing string for copying or scanning across your own PC and mobile devices.
 */
export function encodePairingCode(payload: PairingPayload): string {
  const compact: Record<string, unknown> = {
    u: payload.url.trim(),
    n: payload.username.trim(),
    p: payload.password,
    f: payload.path.trim() || 'CookieSync/cookies.txt',
  };
  if (payload.allowUnsafeWrites) {
    compact.w = 1;
  }
  if (payload.encryptionEnabled && payload.encryptionPassword) {
    compact.e = 1;
    compact.k = payload.encryptionPassword;
  }
  return PREFIX + toBase64Url(JSON.stringify(compact));
}

export function decodePairingCode(raw: string): PairingPayload {
  const trimmed = (raw || '').trim();
  const body = trimmed.startsWith(PREFIX) ? trimmed.slice(PREFIX.length) : trimmed;
  if (!body) throw new Error('请粘贴有效的 CookieSync 配对口令');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fromBase64Url(body)) as Record<string, unknown>;
  } catch {
    throw new Error('配对口令格式无效，请确认已完整复制');
  }
  const url = typeof parsed.u === 'string' ? parsed.u.trim() : '';
  const username = typeof parsed.n === 'string' ? parsed.n.trim() : '';
  const password = typeof parsed.p === 'string' ? parsed.p : '';
  const path = typeof parsed.f === 'string' && parsed.f.trim() ? parsed.f.trim() : 'CookieSync/cookies.txt';
  if (!url || !/^https?:\/\//i.test(url) || !username || !password) {
    throw new Error('配对口令缺少有效的 WebDAV 连接信息');
  }
  return {
    url,
    username,
    password,
    path,
    ...(parsed.w ? { allowUnsafeWrites: true } : {}),
    ...(parsed.e ? { encryptionEnabled: true } : {}),
    ...(typeof parsed.k === 'string' && parsed.k ? { encryptionPassword: parsed.k } : {}),
  };
}
