import { autoSyncStatusStorage, type AutoSyncStatus } from '@sync-your-cookie/storage/lib/autoSyncStatusStorage';
import { domainStatusStorage } from '@sync-your-cookie/storage/lib/domainStatusStorage';

export interface BadgeDisplay {
  text: string;
  color: string;
  title: string;
}

let transientError: { message: string; at: number } | null = null;
let initialized = false;

/**
 * Pure priority state machine for the toolbar badge:
 * 1. Transient command error ('!')
 * 2. Active takeover ('⟳')
 * 3. Active push/pull transfer ('⇅' / '↑' / '↓')
 * 4. Pending upload queue count ('1'..'99')
 * 5. Idle ('')
 */
export function computeBadgeDisplay(input: {
  error?: string | null;
  phase?: AutoSyncStatus['phase'];
  pushing?: boolean;
  pulling?: boolean;
  pendingCount?: number;
  deviceRole?: 'active' | 'standby' | 'taking-over';
  activeDeviceName?: string;
}): BadgeDisplay {
  if (input.error) {
    return { text: '!', color: '#D93829', title: `CookieSync：${input.error}` };
  }
  if (input.phase === 'taking-over' || input.deviceRole === 'taking-over') {
    return { text: '⇄', color: '#248A3D', title: 'CookieSync：正在从另一台电脑接班同步…' };
  }
  if (input.pushing && input.pulling) {
    return { text: '⇅', color: '#0071E3', title: 'CookieSync：正在双向同步…' };
  }
  if (input.pushing || input.phase === 'uploading') {
    return { text: '↑', color: '#0071E3', title: 'CookieSync：正在上传登录状态…' };
  }
  if (input.pulling || input.phase === 'checking' || input.phase === 'comparing') {
    return { text: '↓', color: '#0071E3', title: 'CookieSync：正在拉取最新状态…' };
  }
  const count = input.pendingCount || 0;
  if (count > 0) {
    return {
      text: String(Math.min(count, 99)),
      color: '#C8A24A',
      title: `CookieSync：${count} 个网站待上传`,
    };
  }
  const roleLabel =
    input.deviceRole === 'standby'
      ? input.activeDeviceName
        ? `（待机中 · 当前当家：${input.activeDeviceName}）`
        : '（待机静默中）'
      : input.deviceRole === 'active'
        ? '（本机当家 · 自动同步中）'
        : '';
  return {
    text: '',
    color: '#0071E3',
    title: `CookieSync${roleLabel}`,
  };
}

export async function refreshBadge(): Promise<void> {
  if (!chrome.action?.setBadgeText) return;
  try {
    const [domainStatus, syncStatus] = await Promise.all([domainStatusStorage.get(), autoSyncStatusStorage.get()]);
    // Auto-expire transient command error after 2 minutes.
    if (transientError && Date.now() - transientError.at > 2 * 60000) {
      transientError = null;
    }
    const display = computeBadgeDisplay({
      error: transientError?.message || null,
      phase: syncStatus.phase,
      pushing: domainStatus.pushing,
      pulling: domainStatus.pulling,
      pendingCount: syncStatus.pendingCount,
      deviceRole: syncStatus.deviceRole,
      activeDeviceName: syncStatus.activeDeviceName,
    });
    await chrome.action.setBadgeBackgroundColor({ color: display.color });
    await chrome.action.setBadgeText({ text: display.text });
    if (chrome.action.setTitle) {
      await chrome.action.setTitle({ title: display.title });
    }
  } catch {
    /* Badges are cosmetic and must never break sync. */
  }
}

export function setTransientBadgeError(message: string) {
  transientError = { message, at: Date.now() };
  void refreshBadge();
}

export function clearTransientBadgeError() {
  transientError = null;
  void refreshBadge();
}

export function initBadgeController() {
  if (initialized) return;
  initialized = true;
  domainStatusStorage.subscribe(() => void refreshBadge());
  autoSyncStatusStorage.subscribe(() => void refreshBadge());
  void refreshBadge();
}
