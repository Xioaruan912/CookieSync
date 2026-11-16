import {
  mergeSiteRules,
  normalizeSiteDomain,
  siteRulePrefix,
  siteRulesFromStorage,
  type SiteRules,
} from './commonSites';

// One entry per override avoids Chrome Sync's 8 KiB per-item limit. The bundled 300 sites consume no quota.
let snapshot: SiteRules | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
let writes: Promise<unknown> = Promise.resolve();
function withPolicyLock<T>(action: () => Promise<T>): Promise<T> {
  // Extension pages and the MV3 worker share this origin lock. The queue also supports test/non-browser hosts.
  const run = () =>
    globalThis.navigator?.locks ? navigator.locks.request('cookiesync-site-policy-write-v1', action) : action();
  const result = writes.then(run, run);
  writes = result.catch(() => {});
  return result;
}
export async function readSiteRules(): Promise<SiteRules> {
  const data = await chrome.storage.sync.get(null);
  return siteRulesFromStorage(data);
}
async function commitSiteRules(rules: SiteRules): Promise<void> {
  const current = await readSiteRules();
  const merged = mergeSiteRules(snapshot || {}, current, rules);
  if (Object.keys(merged).length > 400) throw new Error('自定义及关闭规则最多保留 400 条，以符合 Chrome 配置同步限额');
  const changed = Object.fromEntries(
    Object.entries(merged)
      .filter(([domain, rule]) => JSON.stringify(current[domain]) !== JSON.stringify(rule))
      .map(([domain, rule]) => [siteRulePrefix + domain, rule]),
  );
  if (Object.keys(changed).length) await chrome.storage.sync.set(changed);
  snapshot = mergeSiteRules(snapshot || {}, merged);
  emit();
}
export function storeSiteRules(rules: SiteRules): Promise<void> {
  return withPolicyLock(() => commitSiteRules(rules));
}
chrome.storage.sync.onChanged.addListener(changes => {
  if (Object.keys(changes).some(key => key.startsWith(siteRulePrefix))) {
    // Chrome can deliver an older remote write after a local edit. Repair it using the remembered LWW winner.
    const observed = Object.fromEntries(
      Object.entries(changes)
        .filter(([key, change]) => key.startsWith(siteRulePrefix) && change.newValue)
        .map(([key, change]) => [key.slice(siteRulePrefix.length), change.newValue]),
    );
    try {
      snapshot = mergeSiteRules(snapshot || {}, observed);
      emit();
    } catch {
      return;
    }
    void storeSiteRules(snapshot).catch(() => {});
  }
});
void readSiteRules()
  .then(rules => {
    snapshot = mergeSiteRules(snapshot || {}, rules);
    emit();
  })
  .catch(() => {});

export const sitePolicyStorage = {
  get: readSiteRules,
  getSnapshot: () => snapshot,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  setRule: async (input: string, enabled: boolean) => {
    const domain = normalizeSiteDomain(input);
    const current = await readSiteRules();
    const updatedAt = Math.max(Date.now(), (current[domain]?.updatedAt || 0) + 1);
    await storeSiteRules({ [domain]: { enabled, updatedAt, revision: crypto.randomUUID() } });
  },
};
