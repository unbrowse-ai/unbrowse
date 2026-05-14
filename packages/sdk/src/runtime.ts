/**
 * Local-binary lifecycle contracts for `@unbrowse/sdk`.
 *
 * The SDK speaks to a co-located `unbrowse` runtime over loopback HTTP.
 * `runtime.ts` owns the contract for locating, probing, and spawning that
 * runtime so `client.ts` can stay a pure HTTP transport.
 *
 * Day 3 plants the seed: the types are real and the surface compiles, but
 * the bodies throw `not yet implemented (Day 4)`. Day 4 (Luminaries) wires
 * `Bun.spawn` / `child_process.spawn`, free-port allocation, and a
 * timed-readiness probe. Anything that needs `child_process` MUST stay
 * out of this file until then.
 */

/**
 * Handle returned by a successful spawn. `owned` distinguishes processes the
 * SDK forked (kill on `.close()`) from processes the SDK adopted via probe
 * (leave running on `.close()`).
 */
export interface RuntimeHandle {
  /** Base URL the running runtime listens on, e.g. "http://127.0.0.1:6969". */
  baseUrl: string;
  /** OS process id; -1 if the runtime was adopted via probe. */
  pid: number;
  /** Stops the runtime if `owned`; no-op otherwise. */
  kill(): Promise<void>;
  /** Resolves once the runtime answers `/health` with 200. */
  ready: Promise<void>;
  /** True iff this SDK started the process and is responsible for tearing it down. */
  owned: boolean;
}

/**
 * Options for `spawnUnbrowseRuntime`. Every field has a sensible default,
 * so the zero-arg call is the documented happy path.
 */
export interface SpawnRuntimeOptions {
  /** Preferred port; default picks a free port via OS allocation. */
  port?: number;
  /** Working directory for the child; default = current process cwd. */
  cwd?: string;
  /** Extra env vars layered onto the child's inherited env. */
  env?: Record<string, string>;
  /** Explicit path to the binary; overrides `locateUnbrowseBinary`. */
  binaryPath?: string;
  /** Milliseconds to wait for `/health` readiness; default 10_000. */
  readyTimeoutMs?: number;
}

/**
 * Probe an already-running runtime by hitting `/health`. Returns true iff
 * the response is HTTP 200 and the body parses as the expected health JSON.
 *
 * Day-3 seed: throws `not yet implemented (Day 4)`.
 */
export async function probeUnbrowseRuntime(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  baseUrl: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  timeoutMs?: number,
): Promise<boolean> {
  throw new Error("not yet implemented (Day 4)");
}

/**
 * Spawn a co-located `unbrowse` runtime as a child process and wait for it
 * to answer `/health`. Returns a `RuntimeHandle` whose `.kill()` tears the
 * child down. Throws `RuntimeUnavailableError` (Day 4) on failure modes.
 *
 * Day-3 seed: throws `not yet implemented (Day 4)`.
 */
export async function spawnUnbrowseRuntime(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  opts?: SpawnRuntimeOptions,
): Promise<RuntimeHandle> {
  throw new Error("not yet implemented (Day 4)");
}

/**
 * Locate the bundled `unbrowse` binary on disk by walking
 *   1. peer dependency `unbrowse/bin/unbrowse` resolved from cwd,
 *   2. optionalDependencies fallback,
 *   3. PATH lookup.
 * Returns null when nothing is wired — Day 4 turns this into a real lookup.
 */
export function locateUnbrowseBinary(): string | null {
  return null;
}
