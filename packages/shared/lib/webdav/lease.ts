import { readWebdav, writeWebdav, type WebdavConfig, type WebdavSnapshot } from './api';

/**
 * Lightweight active-device handover metadata stored beside the cookie file.
 * Carries zero credentials, zero cookies, and zero encryption secrets.
 */
export const webdavLeaseFileName = 'CookieSync-lease-v1.json';
const maxLeaseSize = 16 * 1024;

export interface RemoteDeviceLease {
  version: 1;
  activeDeviceId: string;
  activeDeviceName: string;
  userAgentFamily: string;
  leaseAt: number;
  dataRevision: string;
  lastDataWriteAt: number;
}

export type LeaseHandoverDecision =
  | { action: 'claim'; reason: 'no-remote-lease' }
  | { action: 'owner'; reason: 'same-device' }
  | { action: 'pull-newer'; reason: 'newer-revision'; remote: RemoteDeviceLease }
  | { action: 'takeover'; reason: 'other-device-active'; remote: RemoteDeviceLease };

export function webdavLeasePath(cookiePath: string): string {
  const segments = cookiePath.trim().split('/');
  segments[segments.length - 1] = webdavLeaseFileName;
  return segments.join('/');
}

export function webdavLeaseDestination(base: WebdavConfig): WebdavConfig {
  return { ...base, path: webdavLeasePath(base.path) };
}

export function decodeLease(content: string): RemoteDeviceLease | null {
  if (!content || !content.trim()) return null;
  if (content.length > maxLeaseSize) throw new Error('云端设备状态文件异常过大');
  const parsed = JSON.parse(content) as Partial<RemoteDeviceLease>;
  if (
    parsed?.version !== 1 ||
    typeof parsed.activeDeviceId !== 'string' ||
    !parsed.activeDeviceId.trim() ||
    typeof parsed.activeDeviceName !== 'string'
  ) {
    throw new Error('云端设备状态文件格式无效');
  }
  return {
    version: 1,
    activeDeviceId: parsed.activeDeviceId.trim(),
    activeDeviceName: parsed.activeDeviceName.trim() || parsed.activeDeviceId.slice(0, 8),
    userAgentFamily: typeof parsed.userAgentFamily === 'string' ? parsed.userAgentFamily : '',
    leaseAt: Number(parsed.leaseAt) || 0,
    dataRevision: typeof parsed.dataRevision === 'string' ? parsed.dataRevision : '',
    lastDataWriteAt: Number(parsed.lastDataWriteAt) || 0,
  };
}

export function evaluateLeaseHandover(
  localDeviceId: string,
  localLastRevision: string | undefined,
  remote: RemoteDeviceLease | null,
): LeaseHandoverDecision {
  if (!remote) {
    return { action: 'claim', reason: 'no-remote-lease' };
  }
  if (remote.activeDeviceId !== localDeviceId) {
    return { action: 'takeover', reason: 'other-device-active', remote };
  }
  if (remote.dataRevision && localLastRevision && remote.dataRevision !== localLastRevision) {
    return { action: 'pull-newer', reason: 'newer-revision', remote };
  }
  return { action: 'owner', reason: 'same-device' };
}

export async function readWebdavLease(
  base: WebdavConfig,
): Promise<{ lease: RemoteDeviceLease | null; snapshot: WebdavSnapshot }> {
  const dest = webdavLeaseDestination(base);
  const snapshot = await readWebdav(dest);
  if (!snapshot.exists || !snapshot.content) {
    return { lease: null, snapshot };
  }
  try {
    return { lease: decodeLease(snapshot.content), snapshot };
  } catch {
    // Treat malformed lease as absent so syncing is never permanently bricked.
    return { lease: null, snapshot };
  }
}

export async function writeWebdavLease(
  base: WebdavConfig,
  lease: RemoteDeviceLease,
  previous: WebdavSnapshot,
): Promise<{ claimed: boolean; lease: RemoteDeviceLease }> {
  const dest = webdavLeaseDestination(base);
  const encoded = JSON.stringify(lease);
  try {
    await writeWebdav(dest, encoded, previous);
    return { claimed: true, lease };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // On 412 precondition failed, inspect who won the lease instead of blindly overwriting.
    if (message.includes('HTTP 412')) {
      const latest = await readWebdavLease(base);
      if (latest.lease && latest.lease.activeDeviceId !== lease.activeDeviceId && latest.lease.leaseAt > lease.leaseAt) {
        return { claimed: false, lease: latest.lease };
      }
      await writeWebdav(dest, encoded, latest.snapshot);
      return { claimed: true, lease };
    }
    throw error;
  }
}
