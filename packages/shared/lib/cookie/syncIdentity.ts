import { webdavStorage } from '@sync-your-cookie/storage/lib/webdavStorage';
import type { PendingSyncJob } from './automatic';

type Jobs = Record<string, PendingSyncJob>;
let edits: Promise<unknown> = Promise.resolve();
export const waitSyncJobEdits = () => edits;
export function editSyncJobs(key: string, update: (jobs: Jobs) => Jobs | Promise<Jobs>) {
  const run = async () => {
    const jobs = (await chrome.storage.local.get([key]))[key] || {};
    await chrome.storage.local.set({ [key]: await update(jobs) });
  };
  edits = edits.then(run, run);
  return edits;
}

export async function syncDestinationKey() {
  // Cookies travel through WebDAV only; the destination identity is the endpoint
  // plus the remote file path so switching servers never mixes pending jobs.
  const dav = await webdavStorage.get();
  const destination = JSON.stringify(['webdav', dav?.url, dav?.username, dav?.path]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(destination));
  return 'cookiesync-pending-' + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function baselineKey(host: string) {
  return `${await syncDestinationKey()}-baseline-${encodeURIComponent(host)}`;
}
export async function getSyncBaseline(host: string): Promise<string | undefined> {
  const key = await baselineKey(host);
  return (await chrome.storage.local.get([key]))[key];
}
export async function setSyncBaseline(host: string, digest: string) {
  await chrome.storage.local.set({ [await baselineKey(host)]: digest });
}

export async function getPendingRevision(host: string): Promise<string | undefined> {
  await edits;
  const key = await syncDestinationKey();
  return (await chrome.storage.local.get([key]))[key]?.[host]?.revision;
}

export async function settleManualSync(host: string, previousRevision: string | undefined, digest: string) {
  const key = await syncDestinationKey();
  await editSyncJobs(key, jobs => {
    const pending = jobs[host];
    if (!pending) return jobs;
    const next = { ...jobs };
    if (pending.revision === previousRevision) delete next[host];
    else next[host] = { ...pending, baseHash: digest };
    return next;
  });
}
