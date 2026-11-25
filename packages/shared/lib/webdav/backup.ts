import { readWebdav, writeWebdav, type WebdavConfig, type WebdavSnapshot } from './api';
import { RUNTIME_STORAGE_KEYS } from '@sync-your-cookie/storage/lib/syncRuntimeStorage';

/**
 * Daily rolling backups next to the cookie file. The remote content is copied
 * verbatim (still encrypted when encryption is on), so a rollback never needs
 * the encryption password twice.
 */
export const backupPath = (path: string, slot: number) => `${path}.bak.${slot}`;
export const backupSlots = [1, 2, 3] as const;
const lastBackupKey = RUNTIME_STORAGE_KEYS.lastBackupAt;
const intervalMs = 24 * 60 * 60 * 1000;

const slotConfig = (config: WebdavConfig, slot: number): WebdavConfig => ({
  ...config,
  path: backupPath(config.path, slot),
  // Backups are disposable and live beside the main file; overwriting an old
  // slot must not depend on the server offering strong ETags.
  allowUnsafeWrites: true,
});

const emptySnapshot: WebdavSnapshot = { content: '', exists: false };

async function readSlot(config: WebdavConfig, slot: number): Promise<WebdavSnapshot> {
  try {
    return await readWebdav(slotConfig(config, slot));
  } catch {
    return emptySnapshot;
  }
}

/** slot3 ← old slot2, slot2 ← old slot1, slot1 ← the content about to be replaced. */
export async function rotateWebdavBackups(config: WebdavConfig, content: string) {
  const [first, second, third] = await Promise.all([1, 2, 3].map(slot => readSlot(config, slot)));
  if (second.content) await writeWebdav(slotConfig(config, 3), second.content, third);
  if (first.content) await writeWebdav(slotConfig(config, 2), first.content, second);
  if (content) await writeWebdav(slotConfig(config, 1), content, first);
}

/** Best effort: a backup failure is recorded but never blocks the main write. */
export async function backupIfDue(config: WebdavConfig, content: string) {
  if (!content) return false;
  const last = Number((await chrome.storage.local.get(lastBackupKey))[lastBackupKey]) || 0;
  if (Date.now() - last < intervalMs) return false;
  await rotateWebdavBackups(config, content);
  await chrome.storage.local.set({ [lastBackupKey]: Date.now() });
  return true;
}

export async function backupStatus(config: WebdavConfig) {
  return Promise.all(
    backupSlots.map(async slot => {
      const snapshot = await readSlot(config, slot);
      return { slot, exists: snapshot.exists && !!snapshot.content, bytes: snapshot.content.length };
    }),
  );
}

/**
 * Restores one backup into the live file. The current live content is rotated
 * into slot 1 first so the restore itself can be undone.
 */
export async function restoreBackup(config: WebdavConfig, slot: number) {
  if (!backupSlots.includes(slot as (typeof backupSlots)[number])) throw new Error('备份槽位无效');
  const source = await readWebdav(slotConfig(config, slot));
  if (!source.content) throw new Error(`备份槽位 ${slot} 没有内容`);
  const current = await readWebdav(config);
  if (current.content) await rotateWebdavBackups(config, current.content);
  await writeWebdav(config, source.content, current);
  return { slot, bytes: source.content.length };
}
