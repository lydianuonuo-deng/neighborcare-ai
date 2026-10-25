export type DraftStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> & {
  readonly persistent: boolean;
};

/** Preserve the current page's recovery keys even when browser storage is denied or full. */
export function createDraftStorage(
  getStorage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">,
): DraftStorage {
  const memory = new Map<string, string>();
  let persistent = true;
  const access = <T>(action: () => T, fallback: () => T): T => {
    if (persistent) {
      try {
        return action();
      } catch {
        persistent = false;
      }
    }
    return fallback();
  };
  return {
    get persistent() {
      return persistent;
    },
    getItem(key) {
      return access(
        () => {
          const value = getStorage().getItem(key);
          if (value === null) memory.delete(key);
          else memory.set(key, value);
          return value;
        },
        () => memory.get(key) ?? null,
      );
    },
    setItem(key, value) {
      memory.set(key, value);
      access(
        () => getStorage().setItem(key, value),
        () => undefined,
      );
    },
    removeItem(key) {
      memory.delete(key);
      access(
        () => getStorage().removeItem(key),
        () => undefined,
      );
    },
  };
}

export function readCachedJson(storage: DraftStorage, key: string): unknown {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export const draftKeys = (ownerId: string) => ({
  cache: `linli.report-draft.v2:${ownerId}`,
  pending: `linli.pending-submit.v2:${ownerId}`,
});

/** Bind unscoped V0.3 recovery data before signing in to any account. */
export function migrateGuestDraft(
  storage: DraftStorage,
  guestId: string | null,
) {
  if (!guestId) return;
  const keys = draftKeys(guestId);
  for (const [old, scoped] of [
    ["linli.report-draft.v1", keys.cache],
    ["linli.pending-submit", keys.pending],
  ]) {
    const value = storage.getItem(old);
    if (value !== null && storage.getItem(scoped) === null) {
      storage.setItem(scoped, value);
      // Keep the recoverable original if a browser quota/write error occurred.
      if (storage.persistent) storage.removeItem(old);
    }
  }
}
