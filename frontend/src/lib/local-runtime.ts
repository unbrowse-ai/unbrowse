/** Browser storage for the paired local Unbrowse runtime (CLI in-process app).
 *  Mutation safety and other local-only settings live on that origin, not on beta-api. */

const STORAGE_KEY = "unbrowse_local_runtime";

export function normalizeLocalRuntimeOrigin(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Strip trailing slash; keep origin + optional non-root pathname prefix if ever used.
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export function readLocalRuntimeOrigin(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeLocalRuntimeOrigin(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeLocalRuntimeOrigin(origin: string | null | undefined): string | null {
  if (typeof window === "undefined") return null;
  const next = normalizeLocalRuntimeOrigin(origin);
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode / blocked storage — panel degrades to "not paired" */
  }
  return next;
}

export function clearLocalRuntimeOrigin(): void {
  writeLocalRuntimeOrigin(null);
}
