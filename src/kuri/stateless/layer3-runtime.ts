/**
 * Stateless-kuri Layer 3 — Browser-runtime layer.
 *
 * Contract: 0af18e9f
 *
 * A contract-neuron primitive that takes (chrome_binary_pointer,
 * ephemeral_user_data_dir, stealth_ext_pointer, navigator_spoof_profile) and
 * emits a chrome_runtime_pointer = {pid, cdp_port, user_data_dir, ready_at}.
 *
 * Each call spawns a fresh chrome subprocess with --user-data-dir set to a
 * unique ephemeral path; CDP port auto-assigned from the ephemeral 49152-65535
 * range, not a fixed shared port. stealth_ext_pointer references
 * /Users/lekt9/.kuri/builtin-ext as a content-addressed capability (sha256 of
 * the extension bundle), so the extension is verifiably identical across
 * spawns.
 *
 * Validation: 35 concurrent calls produce 35 distinct chrome processes with
 * 35 distinct CDP ports and 35 distinct user-data-dirs, all ready within 5s.
 *
 * NOTE: NOT IMPLEMENTED. This is the biggest layer — effectively a partial
 * stateless rewrite of the kuri broker. Wave-4 ships scaffolding only.
 * Implementation will need to either:
 *   (a) extend the existing src/kuri/client.ts spawn path to take an
 *       ephemeral_user_data_dir override + ephemeral CDP port
 *   (b) write a parallel chrome-spawn primitive next to the kuri broker
 *
 * Path (a) is touched by 8120be81's constraint: brokerClients Map must
 * become per-call-ephemeral. That means rewriting brokerCacheKey() to take
 * a unique-per-call key derived from ephemeral_user_data_dir.
 *
 * Wired in by: nothing yet.
 */

export interface ChromeRuntimePointer {
  readonly pid: number;
  readonly cdp_port: number;
  readonly user_data_dir: string;
  readonly stealth_ext_sha256: string;
  readonly navigator_spoof_profile: NavigatorSpoofProfile;
  readonly ready_at_iso: string;
  readonly ephemeral: true; // always true for layer-3 pointers
}

export interface NavigatorSpoofProfile {
  readonly user_agent: string;
  readonly platform: "MacIntel" | "Win32" | "Linux x86_64";
  readonly languages: readonly string[];
  readonly webdriver: false;
  readonly canvas_noise_seed: number;
  readonly plugins_shape: "modern-chrome" | "modern-firefox";
}

export interface Layer3Request {
  readonly chrome_binary_path?: string; // default: resolve via kuri vendor
  readonly stealth_ext_path?: string;   // default: /Users/lekt9/.kuri/builtin-ext
  readonly navigator_spoof_profile?: Partial<NavigatorSpoofProfile>;
  readonly headless?: "new" | false;     // default "new"
}

/**
 * Spawn an ephemeral chrome runtime. Each call gets:
 *   - a freshly-created --user-data-dir under os.tmpdir() / fs-ephemeral
 *   - a freshly-allocated CDP port via net.createServer().listen(0)
 *   - a clean stealth-ext load
 *
 * NOT YET IMPLEMENTED. This stub throws to make the wiring explicit.
 */
export async function spawnStatelessChrome(_req: Layer3Request): Promise<ChromeRuntimePointer> {
  throw new Error(
    "Layer 3 (stateless-kuri 0af18e9f) not implemented — scaffold only. " +
    "Implementation requires editing src/kuri/client.ts to support " +
    "per-call brokerClients keys derived from ephemeral_user_data_dir + " +
    "ephemeral CDP port from net.createServer().listen(0). See README.md."
  );
}
