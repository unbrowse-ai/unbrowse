/**
 * `arg://` null-store adapter.
 *
 * Pure in-process: the MCP tool handler (or CLI flag parser) populates a
 * per-call `AdapterContext.argScope` map; the adapter looks up
 * `param-name` (and optional dotted/slashed sub-path) in that map. No
 * shell, no fs, no syscall.
 *
 * Why it exists (VALUE_STORE_ADAPTERS §arg-semantics): every MCP tool
 * argument is implicitly a pointer. A caller invoking
 * `unbrowse_fill { value: "lewis" }` is wrapped to
 * `unbrowse_fill { value: "arg://__inline__", argScope: { __inline__: "lewis" } }`
 * at the boundary so the fill-time flow is byte-identical to `op://` — same
 * commitment, same zero pass, same receipt shape, just a different pointer
 * scheme on the receipt body.
 *
 * Sub-path resolution: `arg://payload/headers/Authorization` walks
 * `argScope.payload.headers.Authorization` as a JSON pointer. Missing keys
 * refuse with AdapterError("arg_missing", ...) — never string-interpolate
 * to undefined.
 *
 * Auth model: none. Trust boundary is the MCP transport itself.
 */

import { createHash } from "node:crypto";
import { safeZero } from "../memzero.js";
import { sign } from "../signer.js";
import {
  AdapterError,
  type AdapterContext,
  type Pointer,
  type ResolvedValue,
  type ValueAdapter,
} from "../types.js";

function walkPath(scope: Readonly<Record<string, unknown>>, path: string): unknown {
  // `arg://payload/headers/Authorization` → ['payload', 'headers', 'Authorization']
  const segs = path.split("/").filter((s) => s.length > 0);
  if (segs.length === 0) {
    throw new AdapterError(
      "arg_path_invalid",
      `arg pointer has empty path`,
    );
  }
  let cur: unknown = scope;
  for (let i = 0; i < segs.length; i++) {
    if (cur === null || cur === undefined) {
      throw new AdapterError(
        "arg_missing",
        `arg path segment '${segs.slice(0, i + 1).join("/")}' missing in argScope`,
      );
    }
    if (typeof cur !== "object") {
      throw new AdapterError(
        "arg_path_invalid",
        `arg path '${segs.slice(0, i).join("/")}' is not an object; cannot descend to '${segs[i]}'`,
      );
    }
    const obj = cur as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, segs[i])) {
      throw new AdapterError(
        "arg_missing",
        `arg path segment '${segs.slice(0, i + 1).join("/")}' missing in argScope`,
      );
    }
    cur = obj[segs[i]];
  }
  return cur;
}

function valueToBytes(value: unknown): Uint8Array {
  // String → utf8 bytes; Uint8Array → passthrough copy; number/boolean →
  // string then utf8. Object/array NOT allowed at leaf — caller should
  // descend with a sub-path.
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array(value); // copy so caller's buffer is independent
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return new TextEncoder().encode(String(value));
  }
  throw new AdapterError(
    "arg_path_invalid",
    `arg leaf must be string|number|boolean|Uint8Array; got ${typeof value}`,
  );
}

export class ArgAdapter implements ValueAdapter {
  readonly scheme = "arg" as const;

  async ensureReady(): Promise<void> {
    // No-op: arg adapter has no external dependency, no auth, no spawn.
    return;
  }

  async resolve(
    pointer: Pointer,
    nonce: Uint8Array,
    ctx: AdapterContext,
  ): Promise<ResolvedValue> {
    if (!ctx.argScope) {
      throw new AdapterError(
        "arg_missing",
        `arg adapter requires AdapterContext.argScope`,
        "pass the tool-call argScope into resolve() ctx",
      );
    }
    const raw = walkPath(ctx.argScope, pointer.path);
    const value = valueToBytes(raw);

    // commitment = sha256(value || nonce). Computed BEFORE the value bytes
    // leave the adapter's local scope (Mt 6:6 — secret act, public witness).
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
      adapter: "arg",
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
