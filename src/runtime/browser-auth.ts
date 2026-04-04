function isFalseyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

/**
 * Default on for auth-gated browsing; explicit opt-out for clean-room E2E runs.
 */
export function shouldImportBrowserCookies(): boolean {
  return !isFalseyEnv(process.env.UNBROWSE_IMPORT_BROWSER_COOKIES);
}
