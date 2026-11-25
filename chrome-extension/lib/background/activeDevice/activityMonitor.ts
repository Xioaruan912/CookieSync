import type { ActivityTrigger } from './leaseManager';

const IDLE_DETECTION_SECONDS = 90;

export interface ActivityMonitorCallbacks {
  onActive: (trigger: ActivityTrigger) => void;
  onInactive: (reason: 'idle' | 'locked') => void;
}

let started = false;

/**
 * Listens to native OS idle/lock state and Chrome window focus changes to
 * detect which computer the user is currently operating — zero intrusive popups.
 */
export function initActivityMonitor(callbacks: ActivityMonitorCallbacks) {
  if (started) return;
  started = true;

  if (chrome.idle?.setDetectionInterval && chrome.idle?.onStateChanged) {
    try {
      chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
    } catch {
      /* Ignore environments with restricted idle intervals. */
    }
    chrome.idle.onStateChanged.addListener(state => {
      if (state === 'active') {
        callbacks.onActive('idle-active');
      } else if (state === 'locked') {
        callbacks.onInactive('locked');
      } else if (state === 'idle') {
        callbacks.onInactive('idle');
      }
    });
  }

  if (chrome.windows?.onFocusChanged) {
    const noneId = chrome.windows.WINDOW_ID_NONE ?? -1;
    chrome.windows.onFocusChanged.addListener(windowId => {
      if (windowId !== noneId) {
        callbacks.onActive('focus');
      }
    });
  }
}
