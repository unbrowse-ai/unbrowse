import { existsSync, writeFileSync } from "node:fs";
import { extractRefreshConfig } from "./token-refresh.js";
import { loadJsonOr } from "./disk-io.js";

/**
 * Scan HAR entries for refresh token endpoints and persist refreshConfig to auth.json.
 *
 * Used by both OpenClaw plugin flows and standalone/CLI flows.
 */
export function detectAndSaveRefreshConfig(
  harEntries: Array<{
    request: { method: string; url: string; headers: Array<{ name: string; value: string }>; postData?: { text?: string } };
    response: { status: number; content?: { text?: string } };
  }>,
  authPath: string,
  logger: { info: (msg: string) => void },
): void {
  for (const entry of harEntries) {
    const refreshConfig = extractRefreshConfig(entry);
    if (!refreshConfig) continue;

    try {
      let auth: Record<string, any> = {};
      if (existsSync(authPath)) {
        auth = loadJsonOr<Record<string, any>>(authPath, {});
      }
      auth.refreshConfig = refreshConfig;
      writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf-8");
      logger.info(`[unbrowse] Detected refresh endpoint: ${refreshConfig.url}`);
    } catch {
      // Non-critical.
    }
    break; // Only need one.
  }
}

