/**
 * macOS Keychain adapter (Generic Password items).
 *
 * Invocation: `security find-generic-password -s <service> -a <account> -w`.
 * The `-w` flag prints ONLY the secret value to stdout. Exit code 44 = not
 * found.
 *
 * Platform gate: macOS-only. On non-darwin, `ensureReady()` throws
 * `AdapterError("platform_unsupported", ..., "use op:// or bw:// instead")`.
 *
 * Stderr hygiene: NEVER pass `-g` to security — that flag prints
 * `password: 0x...` hex dumps. Stick to `-w`.
 *
 * Mt 6:6 — the closet sealed by the OS itself.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { safeZero } from "../memzero.js";
import { sign } from "../signer.js";
import { filterAdapterStderr } from "../stderr-filter.js";
import {
  AdapterError,
  type AdapterContext,
  type CandidatePointer,
  type EnumerateOptions,
  type Pointer,
  type ResolvedValue,
  type ValueAdapter,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 5000;
const SECURITY_BIN = "/usr/bin/security";
// Match src/values/signer.ts: MCP/launchd-launched processes may not have a
// default keychain bound. Passing the login keychain explicitly prevents the
// macOS "Keychain Not Found" dialog and keeps misses as ordinary errors.
const LOGIN_KEYCHAIN_PATH = join(homedir(), "Library", "Keychains", "login.keychain-db");

/**
 * Known unbrowse keychain service prefixes to probe for candidates. We do NOT
 * use `security dump-keychain` (too broad — exposes every credential on the
 * machine, and risks decrypting). Instead we probe a fixed allow-list of
 * unbrowse-owned services with `find-generic-password` WITHOUT `-w`/`-g`, so
 * only NON-SECRET attribute metadata (service + account names) is returned.
 */
const UNBROWSE_SERVICE_PREFIXES: readonly string[] = [
  "unbrowse",
  "unbrowse-session",
  "unbrowse-auth",
  "com.unbrowse.session",
];

/** Parse `svce` + `acct` attributes from `security find-generic-password`
 * (no `-w`/`-g`) human-readable output. NEVER parses a password. */
function parseAttrLines(out: string): { service?: string; account?: string } {
  let service: string | undefined;
  let account: string | undefined;
  for (const line of out.split("\n")) {
    // `    "svce"<blob>="unbrowse"` / `    "acct"<blob>="lewis@unbrowse.ai"`
    const svce = line.match(/"svce"[^=]*=(?:<[^>]*>)?"?([^"\n]*)"?/);
    if (svce) service = svce[1];
    const acct = line.match(/"acct"[^=]*=(?:<[^>]*>)?"?([^"\n]*)"?/);
    if (acct) account = acct[1];
  }
  return { service, account };
}

function parseKeychainPath(path: string): { service: string; account: string } {
  // `keychain://<service>/<account>` → path is `<service>/<account>`.
  // Service may NOT contain '/'; everything after the first '/' is the
  // account. (Account may contain '@' for email-like accounts.)
  const idx = path.indexOf("/");
  if (idx < 0) {
    throw new AdapterError(
      "invalid_pointer",
      `keychain pointer must be 'keychain://<service>/<account>'; got 'keychain://${path}'`,
    );
  }
  const service = path.slice(0, idx);
  const account = path.slice(idx + 1);
  if (service.length === 0 || account.length === 0) {
    throw new AdapterError(
      "invalid_pointer",
      `keychain pointer has empty service or account: 'keychain://${path}'`,
    );
  }
  return { service, account };
}

async function spawnSecurity(
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: Uint8Array; stderr: string; exit: number }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(SECURITY_BIN, args as string[], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(
        new AdapterError(
          "adapter_spawn_failed",
          `failed to spawn ${SECURITY_BIN}: ${(err as Error).message}`,
        ),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    const stderrPromise = filterAdapterStderr(child.stderr, "keychain").catch(
      (err) => `[stderr-filter-error: ${(err as Error).message}]`,
    );

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(
        new AdapterError(
          "adapter_timeout",
          `security exceeded ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new AdapterError(
          "adapter_spawn_failed",
          `security spawn error: ${(err as Error).message}`,
        ),
      );
    });

    child.on("close", async (code) => {
      clearTimeout(timer);
      const stderr = await stderrPromise;
      // security -w prints the value followed by a single newline on stdout.
      // We strip exactly one trailing \n (NOT all whitespace — secrets may
      // legitimately end in spaces).
      let stdout = new Uint8Array(Buffer.concat(stdoutChunks));
      if (stdout.length > 0 && stdout[stdout.length - 1] === 0x0a) {
        stdout = stdout.slice(0, stdout.length - 1);
      }
      for (const c of stdoutChunks) {
        try {
          c.fill(0);
        } catch {
          // ignore
        }
      }
      resolve({ stdout, stderr, exit: code ?? -1 });
    });
  });
}

export class KeychainAdapter implements ValueAdapter {
  readonly scheme = "keychain" as const;
  private readyChecked = false;

  async ensureReady(): Promise<void> {
    if (this.readyChecked) return;
    if (platform() !== "darwin") {
      throw new AdapterError(
        "platform_unsupported",
        `keychain:// is macOS-only (current platform: ${platform()})`,
        "use op:// or bw:// instead",
      );
    }
    if (!existsSync(LOGIN_KEYCHAIN_PATH)) {
      throw new AdapterError(
        "adapter_unavailable",
        `macOS login keychain not found at ${LOGIN_KEYCHAIN_PATH}`,
        "open Keychain Access or use op://, bw://, or arg:// instead",
      );
    }
    this.readyChecked = true;
  }

  /**
   * Enumerate unbrowse-owned Generic Password items as candidate POINTERS.
   * Probes a fixed allow-list of unbrowse service prefixes with
   * `find-generic-password` WITHOUT `-w`/`-g` so ONLY the non-secret
   * service + account attributes are returned (never the password). macOS-
   * only; returns [] on every other platform (honest skip).
   *
   * Pointer = `keychain://<service>/<account>`. Label = the account name
   * (non-secret). The password is never read.
   */
  async enumerate(opts: EnumerateOptions): Promise<CandidatePointer[]> {
    try {
      await this.ensureReady();
    } catch {
      // Non-darwin (or unavailable) → honest empty set.
      return [];
    }
    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const seen = new Set<string>();
    const out: CandidatePointer[] = [];
    for (const service of UNBROWSE_SERVICE_PREFIXES) {
      let result: { stdout: Uint8Array; stderr: string; exit: number };
      try {
        // NO -w, NO -g: only attribute metadata is printed (no secret).
        result = await spawnSecurity(
          ["find-generic-password", "-s", service, LOGIN_KEYCHAIN_PATH],
          timeout,
        );
      } catch {
        continue;
      }
      if (result.exit !== 0) continue; // exit 44 = not found → skip silently
      const text = new TextDecoder().decode(result.stdout);
      const { service: svc, account } = parseAttrLines(text);
      const realSvc = svc || service;
      if (!account || account.length === 0) continue;
      const pointer = `keychain://${realSvc}/${account}`;
      if (seen.has(pointer)) continue;
      seen.add(pointer);
      out.push({
        pointer,
        label: account, // account name — non-secret metadata
        scheme: "keychain",
        hint: `macOS Keychain · service ${realSvc}`,
      });
    }
    return out;
  }

  async resolve(
    pointer: Pointer,
    nonce: Uint8Array,
    ctx: AdapterContext,
  ): Promise<ResolvedValue> {
    await this.ensureReady();
    const { service, account } = parseKeychainPath(pointer.path);
    const timeout = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const result = await spawnSecurity(
      ["find-generic-password", "-s", service, "-a", account, "-w", LOGIN_KEYCHAIN_PATH],
      timeout,
    );
    if (result.exit !== 0) {
      // Exit 44 = SecKeychainSearchCopyNext failed (item not found).
      const reason = result.exit === 44 ? "item not found" : `exit ${result.exit}`;
      throw new AdapterError(
        "adapter_exit_nonzero",
        `security find-generic-password ${reason}; stderr: ${result.stderr.slice(0, 200)}`,
        result.exit === 44
          ? `add the item via Keychain Access (service='${service}', account='${account}')`
          : undefined,
      );
    }
    const value = result.stdout;
    if (value.length === 0) {
      throw new AdapterError(
        "adapter_exit_nonzero",
        `security returned empty value for keychain://${service}/${account}`,
      );
    }

    const h = createHash("sha256");
    h.update(value);
    h.update(nonce);
    const commitment = new Uint8Array(h.digest());

    const { signature, walletPubkey } = await sign(
      pointer.raw,
      nonce,
      ctx.contextHash,
      commitment,
    );

    let disposed = false;
    const resolved: ResolvedValue = {
      value,
      signature,
      walletPubkey,
      contextHash: ctx.contextHash,
      commitment,
      adapter: "keychain",
      pointer: pointer.raw,
      async [Symbol.asyncDispose](): Promise<void> {
        if (disposed) return;
        disposed = true;
        safeZero(value);
      },
    };
    return resolved;
  }
}
