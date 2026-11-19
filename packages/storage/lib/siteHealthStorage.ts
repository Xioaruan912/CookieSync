import { createStorage, StorageType } from './base';

export interface SiteHealthEntry {
  /** 'ok' the site answered logged-in · 'invalid' the site answered logged-out · 'unknown' the check could not run. */
  state?: 'ok' | 'invalid' | 'unknown';
  checkedAt?: number;
  /** Why the state is what it is: server message, missing login keys, UA mismatch hint. */
  message?: string;
  userName?: string;
  /** The local snapshot lacks the profile's required login cookies. */
  loginKeysMissing?: boolean;
}

export type SiteHealthMap = Record<string, SiteHealthEntry>;

const storage = createStorage<SiteHealthMap>(
  'cookiesync-site-health',
  {},
  {
    storageType: StorageType.Local,
    liveUpdate: true,
  },
);

export const siteHealthStorage = {
  ...storage,
  updateDomain: (domain: string, value: Partial<SiteHealthEntry>) =>
    storage.set(current => ({ ...current, [domain]: { ...current[domain], ...value } })),
};
