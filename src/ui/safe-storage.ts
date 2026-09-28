// Storage access throws in private windows, with blocked site data, or when
// the quota is full; none of those may stop the app from rendering.

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The preference simply does not persist.
  }
}

export function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing persisted, so nothing to remove.
  }
}
