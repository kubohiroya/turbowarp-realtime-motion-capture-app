/**
 * Small per-browser settings an operator would otherwise re-enter every run, such as which USB
 * device each camera ID was given.
 *
 * Kept in `localStorage` under the application's own prefix. It is a convenience, not a record:
 * storage can be unavailable or cleared, and every read falls back to an empty string, so a script
 * treats a missing setting as "not set" and asks again.
 */
export interface SettingsStore {
  get(key: string): string;
  set(key: string, value: string): void;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createSettingsStore(
  prefix: string,
  storage: () => StorageLike | null,
): SettingsStore {
  const qualified = (key: string) => `${prefix}:${key.trim()}`;
  return {
    get(key) {
      try {
        return storage()?.getItem(qualified(key)) ?? '';
      } catch {
        return '';
      }
    },
    set(key, value) {
      if (key.trim() === '') return;
      try {
        storage()?.setItem(qualified(key), value);
      } catch {
        // Storage refused (private mode, quota): the setting simply is not remembered.
      }
    },
  };
}

export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
