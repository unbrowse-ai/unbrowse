import { detectHostEnvironment, getBrowserConfig } from "./browser-host.js";
import { log } from "../logger.js";

/**
 * Apply browser config derived from the detected host environment to process.env
 * so that the kuri binary picks them up when it is spawned.
 *
 * Kuri reads config from environment variables (see submodules/kuri/src/bridge/config.zig):
 *   HEADLESS       — "true"/"false"
 *   STATE_DIR      — user-data / profile directory
 *   CDP_URL        — connect to existing Chrome (ws://host:port)
 *
 * Must be called before kuri.start() to take effect.
 */
export function applyBrowserConfigToEnv(): void {
  const host = detectHostEnvironment();
  const config = getBrowserConfig(host);

  log("kuri-config", `detected host environment: ${host}`);

  // HEADLESS — kuri reads this as a bool
  process.env.HEADLESS = config.headless ? "true" : "false";

  // STATE_DIR — kuri chrome launcher uses this as the user-data-dir
  if (config.user_data_dir) {
    process.env.STATE_DIR = config.user_data_dir;
  }

  // CDP_URL — if the host provides a fixed CDP port, wire it as a connect URL
  // so kuri attaches to the existing Chrome instead of launching a new one
  if (config.cdp_port && config.cdp_port > 0) {
    process.env.CDP_URL = `ws://127.0.0.1:${config.cdp_port}`;
  }

  // CHROME_PATH — surface the binary path as an env var for any future kuri support
  if (config.binary_path) {
    process.env.CHROME_PATH = config.binary_path;
  }

  log(
    "kuri-config",
    `browser config applied — headless=${config.headless}` +
    (config.user_data_dir ? ` state_dir=${config.user_data_dir}` : "") +
    (config.cdp_port ? ` cdp_port=${config.cdp_port}` : "") +
    (config.binary_path ? ` chrome_path=${config.binary_path}` : ""),
  );
}
