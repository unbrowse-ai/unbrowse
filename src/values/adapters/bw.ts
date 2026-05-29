/**
 * Bitwarden CLI adapter.
 *
 * Invocation:
 *  - password field: `bw get password <item-id-or-name>`
 *  - arbitrary field: `bw get item <item-id>` then parse JSON INSIDE the
 *    adapter (NOT through a shell `jq` hop — that would put the secret in
 *    argv and stdout twice).
 *
 * Auth model: BW_SESSION env var (output of `bw unlock --raw`).
 * `ensureReady()` calls `bw status` and checks for `status: "unlocked"`.
 * Throws AdapterError("adapter_locked") when locked.
 *
 * Stderr hygiene: `bw` prints "You are not logged in." to stderr when the
 * session expires mid-flight; surface that as AdapterError("adapter_locked"),
 * not a generic exec failure. All other stderr lines flow through
 * `stderr-filter.ts`.
 *
 * Mt 6:6 — the closet, even when the door is opened by a session token.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

function parseBwPath(path: string): { itemId: string; field: string } {
  // `bw://<item-id-or-name>` (defaults to password field) or
  // `bw://<item-id-or-name>/<field>`.
  const idx = path.indexOf("/");
  if (idx < 0) {
    return { itemId: path, field: "password" };
  }
  const itemId = path.slice(0, idx);
  const field = path.slice(idx + 1);
  if (itemId.length === 0) {
    throw new AdapterError(
      "invalid_pointer",
      `bw pointer has empty item-id: 'bw://${path}'`,
    );
  }
  if (field.length === 0) {
    return { itemId, field: "password" };
  }
  return { itemId, field };
}

async function spawnBw(
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: Uint8Array; stderr: string; exit: number }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("bw", args as string[], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (err) {
      reject(
        new AdapterError(
          "adapter_spawn_failed",
          `failed to spawn bw: ${(err as Error).message}`,
          "install Bitwarden CLI: https://bitwarden.com/help/cli/",
        ),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    const stderrPromise = filterAdapterStderr(child.stderr, "bw").catch(
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
          `bw exceeded ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new AdapterError(
          "adapter_spawn_failed",
          `bw spawn error: ${(err as Error).message}`,
          "install bw CLI",
        ),
      );
    });

    child.on("close", async (code) => {
      clearTimeout(timer);
      const stderr = await stderrPromise;
      const stdout = new Uint8Array(Buffer.concat(stdoutChunks));
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

function extractFieldFromItemJson(json: string, field: string): Uint8Array {
  // We parse INSIDE the adapter to keep the secret out of jq's argv/stdout.
  // bw item shape: { id, name, login: { username, password, totp }, fields: [...] }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new AdapterError(
      "adapter_exit_nonzero",
      `bw returned non-JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new AdapterError("adapter_exit_nonzero", "bw item JSON is not an object");
  }
  const item = parsed as Record<string, unknown>;
  // Standard login fields
  if (field === "password" || field === "username" || field === "totp") {
    const login = item.login as Record<string, unknown> | undefined;
    if (login && typeof login[field] === "string") {
      return new TextEncoder().encode(login[field] as string);
    }
  }
  if (field === "notes") {
    if (typeof item.notes === "string") {
      return new TextEncoder().encode(item.notes);
    }
  }
  // Custom fields
  const customFields = item.fields as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(customFields)) {
    for (const f of customFields) {
      if (f && f.name === field && typeof f.value === "string") {
        return new TextEncoder().encode(f.value);
      }
    }
  }
  throw new AdapterError(
    "adapter_exit_nonzero",
    `bw item has no field '${field}'`,
  );
}

export class BwAdapter implements ValueAdapter {
  readonly scheme = "bw" as const;
  private readyChecked = false;

  async ensureReady(): Promise<void> {
    if (this.readyChecked) return;
    if (!process.env.BW_SESSION) {
      throw new AdapterError(
        "adapter_locked",
        "BW_SESSION env var is not set",
        "run `bw unlock --raw` and export BW_SESSION=...",
      );
    }
    const result = await spawnBw(["status"], DEFAULT_TIMEOUT_MS).catch((err: unknown) => {
      if (err instanceof AdapterError) throw err;
      throw new AdapterError(
        "adapter_unavailable",
        `bw status failed: ${(err as Error).message}`,
        "install Bitwarden CLI",
      );
    });
    if (result.exit !== 0) {
      throw new AdapterError(
        "adapter_locked",
        `bw status exited ${result.exit}`,
        "run `bw unlock --raw` and export BW_SESSION=...",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(result.stdout));
    } catch {
      throw new AdapterError("adapter_unavailable", "bw status returned non-JSON");
    }
    const status = (parsed as { status?: string } | null)?.status;
    if (status !== "unlocked") {
      throw new AdapterError(
        "adapter_locked",
        `bw status: '${status}' (expected 'unlocked')`,
        "run `bw unlock --raw` and export BW_SESSION=...",
      );
    }
    this.readyChecked = true;
  }

  /**
   * Enumerate Bitwarden items as candidate POINTERS via
   * `bw list items --search <intent>`. The returned JSON CONTAINS secrets
   * (login.password etc.) — so we parse ONLY `id`, `name`, and the SET of
   * field NAMES present, then zero the source buffer. We never read a value.
   * Pointer = `bw://<item-id>/<field>`. Label = the item name (non-secret).
   *
   * Requires BW_SESSION (unlocked). Returns [] (honest skip) if locked or
   * the CLI is absent.
   */
  async enumerate(opts: EnumerateOptions): Promise<CandidatePointer[]> {
    try {
      await this.ensureReady();
    } catch {
      // Locked or bw absent → honest empty set.
      return [];
    }
    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const args = ["list", "items"];
    if (opts.intent && opts.intent.trim().length > 0) {
      args.push("--search", opts.intent.trim());
    }
    let result: { stdout: Uint8Array; stderr: string; exit: number };
    try {
      result = await spawnBw(args, timeout);
    } catch {
      return [];
    }
    if (result.exit !== 0) {
      // session expired / not logged in → honest empty set
      try {
        result.stdout.fill(0);
      } catch {
        // ignore
      }
      return [];
    }
    const out: CandidatePointer[] = [];
    try {
      const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
      if (Array.isArray(parsed)) {
        for (const raw of parsed) {
          if (!raw || typeof raw !== "object") continue;
          const item = raw as Record<string, unknown>;
          const id = typeof item.id === "string" ? item.id : undefined;
          const name = typeof item.name === "string" ? item.name : id;
          if (!id || !name) continue;
          // Determine which field-NAMES exist (NOT their values).
          const fields: string[] = [];
          const login = item.login as Record<string, unknown> | undefined;
          if (login) {
            if (typeof login.username === "string") fields.push("username");
            if (typeof login.password === "string") fields.push("password");
            if (typeof login.totp === "string") fields.push("totp");
          }
          if (typeof item.notes === "string") fields.push("notes");
          const customFields = item.fields as
            | Array<Record<string, unknown>>
            | undefined;
          if (Array.isArray(customFields)) {
            for (const f of customFields) {
              if (f && typeof f.name === "string") fields.push(f.name);
            }
          }
          if (fields.length === 0) fields.push("password");
          for (const field of fields) {
            out.push({
              pointer: `bw://${id}/${field}`,
              label: `${name} (${field})`,
              scheme: "bw",
              hint: "Bitwarden vault",
            });
          }
        }
      }
    } catch {
      // non-JSON → empty
    } finally {
      // The raw JSON held secrets — zero the source buffer.
      try {
        result.stdout.fill(0);
      } catch {
        // ignore
      }
    }
    return out;
  }

  async resolve(
    pointer: Pointer,
    nonce: Uint8Array,
    ctx: AdapterContext,
  ): Promise<ResolvedValue> {
    await this.ensureReady();
    const { itemId, field } = parseBwPath(pointer.path);
    const timeout = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let value: Uint8Array;
    if (field === "password") {
      // Fast path: bw get password emits raw value, no JSON parsing needed.
      const result = await spawnBw(["get", "password", itemId], timeout);
      if (result.exit !== 0) {
        // Watch for "You are not logged in." which means session expired
        // mid-flight; surface as adapter_locked.
        const locked = /not logged in|vault is locked/i.test(result.stderr);
        throw new AdapterError(
          locked ? "adapter_locked" : "adapter_exit_nonzero",
          `bw get password exited ${result.exit}; stderr: ${result.stderr.slice(0, 200)}`,
          locked ? "re-unlock: `bw unlock --raw` and export BW_SESSION=..." : undefined,
        );
      }
      // Strip trailing newline if bw emits one.
      let stdout = result.stdout;
      if (stdout.length > 0 && stdout[stdout.length - 1] === 0x0a) {
        stdout = stdout.slice(0, stdout.length - 1);
      }
      value = stdout;
    } else {
      // Arbitrary field: get the full item JSON, parse IN-PROCESS.
      const result = await spawnBw(["get", "item", itemId], timeout);
      if (result.exit !== 0) {
        const locked = /not logged in|vault is locked/i.test(result.stderr);
        throw new AdapterError(
          locked ? "adapter_locked" : "adapter_exit_nonzero",
          `bw get item exited ${result.exit}; stderr: ${result.stderr.slice(0, 200)}`,
        );
      }
      const json = new TextDecoder().decode(result.stdout);
      try {
        value = extractFieldFromItemJson(json, field);
      } finally {
        // The full item JSON contained the secret; zero the source buffer.
        try {
          result.stdout.fill(0);
        } catch {
          // ignore
        }
      }
    }

    if (value.length === 0) {
      throw new AdapterError(
        "adapter_exit_nonzero",
        `bw returned empty value for ${pointer.raw}`,
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
      adapter: "bw",
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
