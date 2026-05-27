/**
 * 1Password CLI adapter.
 *
 * Invocation: `op read --no-newline 'op://Vault/Item/field'`. Stdout is the
 * raw value bytes; stderr carries auth prompts and must be scrubbed via
 * `stderr-filter.ts` before any parent log.
 *
 * Auth model: prefers `OP_SERVICE_ACCOUNT_TOKEN` for headless agents; falls
 * back to desktop-app biometric integration. `ensureReady()` calls
 * `op whoami` and throws AdapterError("adapter_locked") if neither path
 * works.
 *
 * Bin discovery: `which op` at startup, cached on the adapter instance.
 * v7 does NOT vendor `op`; it's a documented host prerequisite.
 *
 * Mt 6:6 — the closet: the value never leaves stdout-buffer scope before
 * being copied into the commitment-bound Uint8Array and zeroed.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { safeZero } from "../memzero.js";
import { sign } from "../signer.js";
import { filterAdapterStderr } from "../stderr-filter.js";
import {
  AdapterError,
  type AdapterContext,
  type Pointer,
  type ResolvedValue,
  type ValueAdapter,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 5000;

function whichOp(): string | null {
  // `which` is not portable; rely on PATH-resolution by spawn itself by
  // returning a static "op" and letting spawn-time ENOENT surface as
  // AdapterError. We still cache discovery success on the adapter instance.
  return "op";
}

async function spawnAdapter(
  bin: string,
  args: readonly string[],
  timeoutMs: number,
  scheme: "op",
  env?: Record<string, string>,
): Promise<{ stdout: Uint8Array; stderr: string; exit: number }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args as string[], {
        stdio: ["ignore", "pipe", "pipe"],
        env: env ?? process.env,
      });
    } catch (err) {
      reject(
        new AdapterError(
          "adapter_spawn_failed",
          `failed to spawn ${bin}: ${(err as Error).message}`,
          `install ${bin} and ensure it is on PATH`,
        ),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));

    const stderrPromise = filterAdapterStderr(child.stderr, scheme).catch(
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
          `${bin} exceeded ${timeoutMs}ms`,
          `increase UNBROWSE_ADAPTER_TIMEOUT_MS or check vault connectivity`,
        ),
      );
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new AdapterError(
          "adapter_spawn_failed",
          `${bin} spawn error: ${(err as Error).message}`,
          `install ${bin} and ensure it is on PATH`,
        ),
      );
    });

    child.on("close", async (code) => {
      clearTimeout(timer);
      const stderr = await stderrPromise;
      const stdout = new Uint8Array(Buffer.concat(stdoutChunks));
      // Zero the intermediate chunk buffers — the stdout copy above is now
      // the only reference.
      for (const c of stdoutChunks) {
        try {
          c.fill(0);
        } catch {
          // detached buffer; ignore.
        }
      }
      resolve({ stdout, stderr, exit: code ?? -1 });
    });
  });
}

export class OpAdapter implements ValueAdapter {
  readonly scheme = "op" as const;
  private readyChecked = false;
  private binPath: string | null = null;

  async ensureReady(): Promise<void> {
    if (this.readyChecked) return;
    const bin = whichOp();
    if (!bin) {
      throw new AdapterError(
        "adapter_unavailable",
        "op binary not found on PATH",
        "install 1Password CLI: https://developer.1password.com/docs/cli/get-started/",
      );
    }
    // `op whoami` confirms either OP_SERVICE_ACCOUNT_TOKEN or a live desktop
    // session. Failure = adapter_locked with explicit next_step.
    const result = await spawnAdapter(bin, ["whoami"], DEFAULT_TIMEOUT_MS, "op").catch(
      (err: unknown) => {
        if (err instanceof AdapterError) throw err;
        throw new AdapterError(
          "adapter_unavailable",
          `op whoami failed: ${(err as Error).message}`,
          "install op and run `op signin` or set OP_SERVICE_ACCOUNT_TOKEN",
        );
      },
    );
    if (result.exit !== 0) {
      throw new AdapterError(
        "adapter_locked",
        `op whoami exited ${result.exit}; stderr: ${result.stderr.slice(0, 200)}`,
        "set OP_SERVICE_ACCOUNT_TOKEN or run `op signin` via the desktop app",
      );
    }
    this.binPath = bin;
    this.readyChecked = true;
  }

  async resolve(
    pointer: Pointer,
    nonce: Uint8Array,
    ctx: AdapterContext,
  ): Promise<ResolvedValue> {
    await this.ensureReady();
    const bin = this.binPath ?? "op";
    const timeout = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const result = await spawnAdapter(
      bin,
      ["read", "--no-newline", pointer.raw],
      timeout,
      "op",
    );
    if (result.exit !== 0) {
      throw new AdapterError(
        "adapter_exit_nonzero",
        `op read exited ${result.exit}; stderr: ${result.stderr.slice(0, 200)}`,
        "check that the 1Password item exists and is unlocked",
      );
    }
    const value = result.stdout;
    if (value.length === 0) {
      throw new AdapterError(
        "adapter_exit_nonzero",
        `op read returned empty value for ${pointer.raw}`,
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
      adapter: "op",
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
