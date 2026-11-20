type StorageItem = { key: string; value: string; origin?: string };

/** Reads one storage area into a sorted, origin-tagged snapshot. */
const readAll = (area: Storage, origin: string): StorageItem[] => {
  const items: StorageItem[] = [];
  try {
    for (const key of Object.keys(area).sort()) {
      const value = area.getItem(key);
      if (value === null) continue;
      items.push({ key, value, origin });
    }
  } catch {
    /* Storage can be unavailable in sandboxed or blocked frames. */
  }
  return items;
};

export const readPageSnapshot = () => ({
  origin: location.origin,
  localStorageItems: readAll(localStorage, location.origin),
  sessionStorageItems: readAll(sessionStorage, location.origin),
});

/**
 * Signature of both areas for one origin. Comparing it keeps the automatic
 * capture quiet when nothing actually changed.
 */
export const pageSnapshotSignature = (snapshot = readPageSnapshot()) =>
  JSON.stringify([snapshot.origin, snapshot.localStorageItems, snapshot.sessionStorageItems]);
