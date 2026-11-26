import { readWebdav, writeWebdav, type WebdavConfig, type WebdavSnapshot } from './api';

/**
 * Lightweight dual-slot active-device handover metadata stored beside the cookie file.
 * Supports independent `desktop` and `mobile` active slots so 1 PC + 1 Phone can
 * work side-by-side without kicking each other, while multiple PCs or multiple Phones
 * hand over cleanly inside their own slot.
 * Carries zero credentials, zero cookies, and zero encryption secrets.
 */
export const webdavLeaseFileName = 'CookieSync-lease-v1.json';
const maxLeaseSize = 24 * 1024;
const maxConflictRetries = 3;

export type DeviceSlotKind = 'desktop' | 'mobile';

export interface DeviceLeaseSlot {
  deviceId: string;
  deviceName: string;
  userAgentFamily: string;
  leaseAt: number;
  epoch: number;
  dataRevision: string;
  lastDataWriteAt: number;
}

export interface RemoteDeviceLease {
  version: 1;
  activeDeviceId: string;
  activeDeviceName: string;
  userAgentFamily: string;
  leaseAt: number;
  epoch?: number;
  dataRevision: string;
  lastDataWriteAt: number;
  slots?: {
    desktop?: DeviceLeaseSlot;
    mobile?: DeviceLeaseSlot;
  };
}

export type LeaseHandoverDecision =
  | { action: 'claim'; reason: 'no-remote-lease' }
  | { action: 'owner'; reason: 'same-device' }
  | { action: 'pull-newer'; reason: 'newer-revision'; remote: RemoteDeviceLease; slot: DeviceLeaseSlot }
  | { action: 'takeover'; reason: 'other-device-active'; remote: RemoteDeviceLease; slot: DeviceLeaseSlot };

export function webdavLeasePath(cookiePath: string): string {
  const segments = cookiePath.trim().split('/');
  segments[segments.length - 1] = webdavLeaseFileName;
  return segments.join('/');
}

export function webdavLeaseDestination(base: WebdavConfig): WebdavConfig {
  return { ...base, path: webdavLeasePath(base.path) };
}

function normalizeSlot(raw: Partial<DeviceLeaseSlot> | undefined): DeviceLeaseSlot | undefined {
  if (!raw || typeof raw.deviceId !== 'string' || !raw.deviceId.trim()) return undefined;
  const deviceId = raw.deviceId.trim();
  const deviceName = typeof raw.deviceName === 'string' && raw.deviceName.trim() ? raw.deviceName.trim() : deviceId.slice(0, 8);
  return {
    deviceId,
    deviceName,
    userAgentFamily: typeof raw.userAgentFamily === 'string' ? raw.userAgentFamily : '',
    leaseAt: Number(raw.leaseAt) || 0,
    epoch: Number.isSafeInteger(raw.epoch) && (raw.epoch as number) >= 0 ? (raw.epoch as number) : 0,
    dataRevision: typeof raw.dataRevision === 'string' ? raw.dataRevision : '',
    lastDataWriteAt: Number(raw.lastDataWriteAt) || 0,
  };
}

export function getLeaseSlot(
  lease: RemoteDeviceLease | null | undefined,
  kind: DeviceSlotKind = 'desktop',
): DeviceLeaseSlot | undefined {
  if (!lease) return undefined;
  if (kind === 'mobile') return lease.slots?.mobile;
  if (lease.slots?.desktop) return lease.slots.desktop;
  if (!lease.activeDeviceId?.trim()) return undefined;
  return {
    deviceId: lease.activeDeviceId.trim(),
    deviceName: lease.activeDeviceName.trim() || lease.activeDeviceId.slice(0, 8),
    userAgentFamily: lease.userAgentFamily || '',
    leaseAt: lease.leaseAt || 0,
    epoch: Number.isSafeInteger(lease.epoch) && (lease.epoch as number) >= 0 ? (lease.epoch as number) : 0,
    dataRevision: lease.dataRevision || '',
    lastDataWriteAt: lease.lastDataWriteAt || 0,
  };
}

/**
 * Deterministic winner check when two devices of the SAME slot race on HTTP 412.
 * Higher monotonic `epoch` wins first (immune to clock skew), then `leaseAt`, then `deviceId`.
 */
export function slotOutranks(candidate: DeviceLeaseSlot, incoming: DeviceLeaseSlot): boolean {
  if (candidate.epoch !== incoming.epoch) return candidate.epoch > incoming.epoch;
  if (candidate.leaseAt !== incoming.leaseAt) return candidate.leaseAt > incoming.leaseAt;
  return candidate.deviceId > incoming.deviceId;
}

/**
 * Builds a complete dual-slot lease by updating ONLY `kind` while preserving the
 * opposite slot (`mobile` when updating `desktop`, and vice versa) untouched.
 */
export function buildMergedLease(
  existing: RemoteDeviceLease | null,
  kind: DeviceSlotKind,
  slot: DeviceLeaseSlot,
): RemoteDeviceLease {
  const prevDesktop = getLeaseSlot(existing, 'desktop');
  const prevMobile = getLeaseSlot(existing, 'mobile');
  const desktop = kind === 'desktop' ? slot : prevDesktop;
  const mobile = kind === 'mobile' ? slot : prevMobile;
  const primary = desktop || slot;
  return {
    version: 1,
    activeDeviceId: primary.deviceId,
    activeDeviceName: primary.deviceName,
    userAgentFamily: primary.userAgentFamily,
    leaseAt: primary.leaseAt,
    epoch: primary.epoch,
    dataRevision: primary.dataRevision,
    lastDataWriteAt: primary.lastDataWriteAt,
    slots: {
      ...(desktop ? { desktop } : {}),
      ...(mobile ? { mobile } : {}),
    },
  };
}

export function decodeLease(content: string): RemoteDeviceLease | null {
  if (!content || !content.trim()) return null;
  if (content.length > maxLeaseSize) throw new Error('云端设备状态文件异常过大');
  const parsed = JSON.parse(content) as Partial<RemoteDeviceLease>;
  const desktopSlot = normalizeSlot(parsed?.slots?.desktop);
  const mobileSlot = normalizeSlot(parsed?.slots?.mobile);
  const topValid = typeof parsed?.activeDeviceId === 'string' && !!parsed.activeDeviceId.trim();
  if (parsed?.version !== 1 || (!topValid && !desktopSlot && !mobileSlot)) {
    throw new Error('云端设备状态文件格式无效');
  }
  const fallbackDesktop: DeviceLeaseSlot | undefined =
    desktopSlot ||
    (topValid
      ? {
          deviceId: parsed.activeDeviceId!.trim(),
          deviceName:
            typeof parsed.activeDeviceName === 'string' && parsed.activeDeviceName.trim()
              ? parsed.activeDeviceName.trim()
              : parsed.activeDeviceId!.trim().slice(0, 8),
          userAgentFamily: typeof parsed.userAgentFamily === 'string' ? parsed.userAgentFamily : '',
          leaseAt: Number(parsed.leaseAt) || 0,
          epoch: Number.isSafeInteger(parsed.epoch) && (parsed.epoch as number) >= 0 ? (parsed.epoch as number) : 0,
          dataRevision: typeof parsed.dataRevision === 'string' ? parsed.dataRevision : '',
          lastDataWriteAt: Number(parsed.lastDataWriteAt) || 0,
        }
      : undefined);

  const primary = fallbackDesktop || mobileSlot!;
  return {
    version: 1,
    activeDeviceId: primary.deviceId,
    activeDeviceName: primary.deviceName,
    userAgentFamily: primary.userAgentFamily,
    leaseAt: primary.leaseAt,
    epoch: primary.epoch,
    dataRevision: primary.dataRevision,
    lastDataWriteAt: primary.lastDataWriteAt,
    slots: {
      ...(fallbackDesktop ? { desktop: fallbackDesktop } : {}),
      ...(mobileSlot ? { mobile: mobileSlot } : {}),
    },
  };
}

export function evaluateLeaseHandover(
  localDeviceId: string,
  localLastRevision: string | undefined,
  remote: RemoteDeviceLease | null,
  kind: DeviceSlotKind = 'desktop',
): LeaseHandoverDecision {
  const slot = getLeaseSlot(remote, kind);
  if (!remote || !slot) {
    return { action: 'claim', reason: 'no-remote-lease' };
  }
  if (slot.deviceId !== localDeviceId) {
    return { action: 'takeover', reason: 'other-device-active', remote, slot };
  }
  if (slot.dataRevision && localLastRevision && slot.dataRevision !== localLastRevision) {
    return { action: 'pull-newer', reason: 'newer-revision', remote, slot };
  }
  return { action: 'owner', reason: 'same-device' };
}

/**
 * Pure anti-flap detector: if the same slot experiences >= 2 rapid handovers
 * within 30 seconds (e.g., two PCs or two Phones actively used at once), enters
 * a 60-second read-only cooldown to prevent ping-pong loops and session kicks.
 */
export function evaluateSlotFlap(
  recentTakeoverTimestamps: number[],
  now = Date.now(),
  windowMs = 30000,
  cooldownMs = 60000,
  threshold = 2,
): { recent: number[]; cooldownUntil: number } {
  const recent = [...recentTakeoverTimestamps.filter(ts => now - ts >= 0 && now - ts <= windowMs), now];
  const cooldownUntil = recent.length >= threshold ? now + cooldownMs : 0;
  return { recent, cooldownUntil };
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
  slotKind: DeviceSlotKind = 'desktop',
): Promise<{ claimed: boolean; lease: RemoteDeviceLease }> {
  const dest = webdavLeaseDestination(base);
  const incomingSlot = getLeaseSlot(lease, slotKind);
  let targetLease = lease;
  let targetSnapshot = previous;

  for (let attempt = 0; attempt < maxConflictRetries; attempt++) {
    const encoded = JSON.stringify(targetLease);
    try {
      await writeWebdav(dest, encoded, targetSnapshot);
      return { claimed: true, lease: targetLease };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('HTTP 412') || attempt === maxConflictRetries - 1) {
        throw error;
      }
      const latest = await readWebdavLease(base);
      const latestSameSlot = getLeaseSlot(latest.lease, slotKind);
      if (
        latest.lease &&
        latestSameSlot &&
        incomingSlot &&
        latestSameSlot.deviceId !== incomingSlot.deviceId &&
        slotOutranks(latestSameSlot, incomingSlot)
      ) {
        return { claimed: false, lease: latest.lease };
      }
      // Preserve the opposite slot from `latest.lease` while retrying our slot with a bumped epoch.
      const nextSlot: DeviceLeaseSlot = incomingSlot
        ? { ...incomingSlot, epoch: Math.max(incomingSlot.epoch, (latestSameSlot?.epoch || 0) + 1) }
        : {
            deviceId: lease.activeDeviceId,
            deviceName: lease.activeDeviceName,
            userAgentFamily: lease.userAgentFamily,
            leaseAt: lease.leaseAt,
            epoch: (latestSameSlot?.epoch || 0) + 1,
            dataRevision: lease.dataRevision,
            lastDataWriteAt: lease.lastDataWriteAt,
          };
      targetLease = buildMergedLease(latest.lease, slotKind, nextSlot);
      targetSnapshot = latest.snapshot;
    }
  }
  return { claimed: false, lease: targetLease };
}
