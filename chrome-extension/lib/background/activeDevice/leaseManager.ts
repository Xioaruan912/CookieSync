import {
  buildMergedLease,
  buildWebdavUrl,
  evaluateLeaseHandover,
  evaluateSlotFlap,
  getLeaseSlot,
  readWebdavLease,
  writeWebdavLease,
  type RemoteDeviceLease,
} from '@sync-your-cookie/shared';
import { accountStorage, isLegacyProvider } from '@sync-your-cookie/storage/lib/accountStorage';
import { autoSyncStatusStorage, type DeviceSyncRole } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { settingsStorage } from '@sync-your-cookie/storage/lib/settingsStorage';
import {
  currentUserAgentFamily,
  deviceIdentityStorage,
  localLeaseStateStorage,
} from '@sync-your-cookie/storage/lib/syncRuntimeStorage';
import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import { pauseIdleSingleSessionTabs, restoreStandbySwitchedTabs } from './tabGuard';

export type ActivityTrigger = 'startup' | 'focus' | 'idle-active' | 'manual';

let currentRole: DeviceSyncRole = 'active';
let handoverInFlight: Promise<HandoverOutcome> | undefined;
let lastOwnerCheckAt = 0;
let recentTakeovers: number[] = [];
let flapCooldownUntil = 0;
const ownerRecheckCooldownMs = 15000;

function mobilePatchFromLease(lease: RemoteDeviceLease | null | undefined) {
  const mobile = getLeaseSlot(lease, 'mobile');
  if (!mobile) {
    return {
      activeMobileDeviceId: undefined,
      activeMobileDeviceName: undefined,
      activeMobileLeaseAt: undefined,
    };
  }
  return {
    activeMobileDeviceId: mobile.deviceId,
    activeMobileDeviceName: mobile.deviceName,
    activeMobileLeaseAt: mobile.leaseAt,
  };
}

export function isLeaseFlapCooldownActive(now = Date.now()): boolean {
  return flapCooldownUntil > now;
}

export interface HandoverOutcome {
  role: DeviceSyncRole;
  tookOver: boolean;
  previousDeviceName?: string;
  uaMismatch?: boolean;
}

export function getDeviceRole(): DeviceSyncRole {
  return currentRole;
}

export function isDeviceStandby(): boolean {
  return currentRole === 'standby';
}

export function isDeviceTakingOver(): boolean {
  return currentRole === 'taking-over';
}

export async function ensureDeviceMetadata() {
  const identity = await deviceIdentityStorage.ensure();
  const cached = await localLeaseStateStorage.get();
  if (cached?.role) currentRole = cached.role;
  await autoSyncStatusStorage
    .update({
      localDeviceId: identity.deviceId,
      localDeviceName: identity.deviceName,
      deviceRole: currentRole,
      activeDeviceId: cached?.activeDeviceId || identity.deviceId,
      activeDeviceName: cached?.activeDeviceName || identity.deviceName,
    })
    .catch(() => {});
  return identity;
}

async function getReadyWebdavConfig() {
  const account = await accountStorage.get();
  if (isLegacyProvider(account)) return null;
  const config = await webdavStorage.get();
  if (!config?.url?.trim() || !config?.username?.trim() || !config?.password) return null;
  try {
    buildWebdavUrl(config);
    return config;
  } catch {
    return null;
  }
}

async function setRole(role: DeviceSyncRole, patch: Partial<Parameters<typeof autoSyncStatusStorage.update>[0]> = {}) {
  currentRole = role;
  await localLeaseStateStorage.update({ role }).catch(() => {});
  await autoSyncStatusStorage.update({ deviceRole: role, ...patch }).catch(() => {});
}

/**
 * Checks the tiny cloud lease file when the user becomes active on this PC.
 * If another PC was the last active writer, runs a clean atomic takeover before
 * allowing this PC to push any local changes.
 */
export async function handleUserActivity(
  trigger: ActivityTrigger,
  callbacks: {
    onTakeover: (remoteLease: RemoteDeviceLease) => Promise<void>;
    onPullNewer?: () => Promise<void>;
  },
): Promise<HandoverOutcome> {
  if (handoverInFlight) return handoverInFlight;

  const settings = await settingsStorage.get();
  const identity = await ensureDeviceMetadata();
  if (settings.activeDeviceSync === false) {
    await setRole('active');
    return { role: 'active', tookOver: false };
  }

  // Avoid spamming WebDAV on rapid Alt-Tab when we are already the confirmed owner.
  if (
    trigger === 'focus' &&
    currentRole === 'active' &&
    Date.now() - lastOwnerCheckAt < ownerRecheckCooldownMs
  ) {
    return { role: 'active', tookOver: false };
  }

  const config = await getReadyWebdavConfig();
  if (!config) {
    await setRole('active');
    return { role: 'active', tookOver: false };
  }

  handoverInFlight = (async (): Promise<HandoverOutcome> => {
    const localState = await localLeaseStateStorage.get();
    const { lease: remoteLease, snapshot } = await readWebdavLease(config);
    lastOwnerCheckAt = Date.now();
    const mobilePatch = mobilePatchFromLease(remoteLease);
    const decision = evaluateLeaseHandover(identity.deviceId, localState.dataRevision, remoteLease, 'desktop');
    const localUaFamily = currentUserAgentFamily();

    if (decision.action === 'owner') {
      await localLeaseStateStorage.update({
        role: 'active',
        activeDeviceId: identity.deviceId,
        activeDeviceName: identity.deviceName,
        lastCheckedAt: Date.now(),
      });
      await setRole('active', {
        activeDeviceId: identity.deviceId,
        activeDeviceName: identity.deviceName,
        discardedTabsCount: 0,
        ...mobilePatch,
      });
      await restoreStandbySwitchedTabs();
      return { role: 'active', tookOver: false };
    }

    if (decision.action === 'claim') {
      const now = Date.now();
      const prevDesktop = getLeaseSlot(remoteLease, 'desktop');
      const nextLease = buildMergedLease(remoteLease, 'desktop', {
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        userAgentFamily: localUaFamily,
        leaseAt: now,
        epoch: (prevDesktop?.epoch || 0) + 1,
        dataRevision: localState.dataRevision || crypto.randomUUID(),
        lastDataWriteAt: now,
      });
      const claimed = await writeWebdavLease(config, nextLease, snapshot, 'desktop').catch(() => ({
        claimed: true,
        lease: nextLease,
      }));
      const claimedDesktop = getLeaseSlot(claimed.lease, 'desktop')!;
      await localLeaseStateStorage.update({
        role: 'active',
        activeDeviceId: claimedDesktop.deviceId,
        activeDeviceName: claimedDesktop.deviceName,
        dataRevision: claimedDesktop.dataRevision,
        leaseAt: claimedDesktop.leaseAt,
        lastCheckedAt: now,
      });
      await setRole('active', {
        activeDeviceId: claimedDesktop.deviceId,
        activeDeviceName: claimedDesktop.deviceName,
        ...mobilePatchFromLease(claimed.lease),
      });
      return { role: 'active', tookOver: false };
    }

    // Takeover or pull-newer: pause local pushing, adopt cloud state first, then claim desktop slot.
    const fromOtherDevice = decision.action === 'takeover';
    const remote = decision.remote;
    const remoteDesktop = decision.slot;
    const uaMismatch =
      !!remoteDesktop.userAgentFamily && !!localUaFamily && remoteDesktop.userAgentFamily !== localUaFamily;

    if (fromOtherDevice && trigger !== 'manual') {
      const flap = evaluateSlotFlap(recentTakeovers, Date.now());
      recentTakeovers = flap.recent;
      if (flap.cooldownUntil > Date.now()) {
        flapCooldownUntil = flap.cooldownUntil;
        await setRole('standby', {
          phase: 'idle',
          activeDeviceId: remoteDesktop.deviceId,
          activeDeviceName: remoteDesktop.deviceName,
          flapCooldownUntil,
          note: `检测到多台主机同时活跃（${remoteDesktop.deviceName}），已进入 60 秒只拉不推保护期`,
          ...mobilePatch,
        });
        return { role: 'standby', tookOver: false, previousDeviceName: remoteDesktop.deviceName };
      }
    }

    await setRole('taking-over', {
      phase: 'taking-over',
      activeDeviceId: remoteDesktop.deviceId,
      activeDeviceName: remoteDesktop.deviceName,
      error: '',
      ...mobilePatch,
    });

    try {
      if (fromOtherDevice) {
        await callbacks.onTakeover(remote);
      } else if (callbacks.onPullNewer) {
        await callbacks.onPullNewer();
      } else {
        await callbacks.onTakeover(remote);
      }

      const fresh = await readWebdavLease(config);
      const latestDesktop = getLeaseSlot(fresh.lease, 'desktop');
      const now = Date.now();
      const nextLease = buildMergedLease(fresh.lease, 'desktop', {
        deviceId: identity.deviceId,
        deviceName: identity.deviceName,
        userAgentFamily: localUaFamily,
        leaseAt: now,
        epoch: Math.max(remoteDesktop.epoch || 0, latestDesktop?.epoch || 0) + 1,
        dataRevision: remoteDesktop.dataRevision || crypto.randomUUID(),
        lastDataWriteAt: remoteDesktop.lastDataWriteAt || now,
      });
      const claimResult = await writeWebdavLease(config, nextLease, fresh.snapshot, 'desktop').catch(() => ({
        claimed: true,
        lease: nextLease,
      }));
      const claimedDesktop = getLeaseSlot(claimResult.lease, 'desktop')!;

      await localLeaseStateStorage.update({
        role: 'active',
        activeDeviceId: claimedDesktop.deviceId,
        activeDeviceName: claimedDesktop.deviceName,
        userAgentFamily: claimedDesktop.userAgentFamily,
        dataRevision: claimedDesktop.dataRevision,
        leaseAt: claimedDesktop.leaseAt,
        lastCheckedAt: now,
        ...(fromOtherDevice ? { lastTakeoverAt: now } : {}),
      });

      const note = fromOtherDevice
        ? uaMismatch
          ? `已从「${remoteDesktop.deviceName}」自动接班同步（注意：两端系统/浏览器不同，115 等风控站点可能要求重新验证）`
          : `已从「${remoteDesktop.deviceName}」自动接班同步`
        : '已同步云端最新改动';

      await setRole('active', {
        phase: 'idle',
        activeDeviceId: claimedDesktop.deviceId,
        activeDeviceName: claimedDesktop.deviceName,
        lastCheck: now,
        ...(fromOtherDevice ? { lastTakeoverAt: now } : {}),
        note,
        error: '',
        discardedTabsCount: 0,
        flapCooldownUntil: 0,
        ...mobilePatchFromLease(claimResult.lease),
      });

      await restoreStandbySwitchedTabs();
      return {
        role: 'active',
        tookOver: fromOtherDevice,
        previousDeviceName: remoteDesktop.deviceName,
        uaMismatch,
      };
    } catch (error) {
      await setRole('active', {
        phase: 'idle',
        error: error instanceof Error ? error.message : '换机接班同步失败，请检查网络连接',
      });
      throw error;
    }
  })()
    .catch(error => {
      // Never leave the worker stuck in taking-over state.
      if (currentRole === 'taking-over') currentRole = 'active';
      throw error;
    })
    .finally(() => {
      handoverInFlight = undefined;
    });

  return handoverInFlight;
}

/**
 * Updates the remote lease's dataRevision right after this device writes new
 * cookie data to WebDAV. Best effort: never fails the already-succeeded push.
 */
export async function publishDataWriteLease(): Promise<void> {
  const settings = await settingsStorage.get();
  if (settings.activeDeviceSync === false) return;
  const config = await getReadyWebdavConfig();
  if (!config) return;

  try {
    const identity = await ensureDeviceMetadata();
    const { lease: existingLease, snapshot } = await readWebdavLease(config);
    const prevDesktop = getLeaseSlot(existingLease, 'desktop');
    const now = Date.now();
    const nextLease = buildMergedLease(existingLease, 'desktop', {
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      userAgentFamily: currentUserAgentFamily(),
      leaseAt: now,
      epoch: (prevDesktop?.epoch || 0) + 1,
      dataRevision: crypto.randomUUID(),
      lastDataWriteAt: now,
    });
    const written = await writeWebdavLease(config, nextLease, snapshot, 'desktop');
    const finalDesktop = getLeaseSlot(written.lease, 'desktop')!;
    lastOwnerCheckAt = now;
    await localLeaseStateStorage.update({
      role: 'active',
      activeDeviceId: finalDesktop.deviceId,
      activeDeviceName: finalDesktop.deviceName,
      userAgentFamily: finalDesktop.userAgentFamily,
      dataRevision: finalDesktop.dataRevision,
      leaseAt: now,
      lastCheckedAt: now,
    });
    await autoSyncStatusStorage.update({
      deviceRole: 'active',
      activeDeviceId: finalDesktop.deviceId,
      activeDeviceName: finalDesktop.deviceName,
      ...mobilePatchFromLease(written.lease),
    });
  } catch {
    /* Lease update is auxiliary; main cookie data is already safely persisted. */
  }
}

/**
 * Transitions this PC into quiet standby mode:
 * - On idle/locked: flushes final local changes first while still owner, then goes quiet.
 * - On lost-lease: immediately discards stale queue & pauses 115 tabs without pushing.
 */
export async function enterStandby(
  reason: 'idle' | 'locked' | 'lost-lease',
  callbacks?: {
    flushBeforeStandby?: () => Promise<void>;
    clearStaleQueue?: () => Promise<void>;
    newOwner?: { deviceId: string; deviceName: string };
  },
): Promise<void> {
  const settings = await settingsStorage.get();
  if (settings.activeDeviceSync === false) return;

  if (reason !== 'lost-lease' && currentRole === 'active' && callbacks?.flushBeforeStandby) {
    await callbacks.flushBeforeStandby().catch(() => {});
  }
  if (reason === 'lost-lease' && callbacks?.clearStaleQueue) {
    await callbacks.clearStaleQueue().catch(() => {});
  }

  const patch: Partial<Parameters<typeof autoSyncStatusStorage.update>[0]> = {};
  if (callbacks?.newOwner) {
    patch.activeDeviceId = callbacks.newOwner.deviceId;
    patch.activeDeviceName = callbacks.newOwner.deviceName;
    patch.note = `已由「${callbacks.newOwner.deviceName}」接管，本机已自动进入静默待机`;
    await localLeaseStateStorage
      .update({
        activeDeviceId: callbacks.newOwner.deviceId,
        activeDeviceName: callbacks.newOwner.deviceName,
      })
      .catch(() => {});
  }

  await setRole('standby', patch);
  await pauseIdleSingleSessionTabs({
    includeActiveIfLockedOrLostLease: reason === 'locked' || reason === 'lost-lease',
  });
}

/**
 * Periodic check for an always-on PC: detects if the other PC took over the
 * lease even when this PC never locked its screen, and immediately steps down.
 */
export async function checkIfLeaseLost(clearStaleQueue: () => Promise<void>): Promise<boolean> {
  const settings = await settingsStorage.get();
  if (settings.activeDeviceSync === false) return false;
  const config = await getReadyWebdavConfig();
  if (!config) return false;

  try {
    const identity = await ensureDeviceMetadata();
    const { lease } = await readWebdavLease(config);
    lastOwnerCheckAt = Date.now();
    await autoSyncStatusStorage.update(mobilePatchFromLease(lease)).catch(() => {});
    const desktopSlot = getLeaseSlot(lease, 'desktop');
    if (desktopSlot && desktopSlot.deviceId !== identity.deviceId) {
      await enterStandby('lost-lease', {
        clearStaleQueue,
        newOwner: { deviceId: desktopSlot.deviceId, deviceName: desktopSlot.deviceName },
      });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
