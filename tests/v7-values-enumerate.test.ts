/**
 * v7 value-store enumerate() candidate-API tests (W31-B).
 *
 * platform: .planning/v7-rip/DIFFUSION_POPULATE_MAP.md §2, §4.1
 *
 * The enumerate() surface lists candidate value-POINTERS (never values) so a
 * multi-slot populate has a candidate set to rank. The LOAD-BEARING invariant
 * under test: enumerate output (pointers + labels + hints) NEVER contains a
 * cleartext value.
 *
 * NO MOCKS (CLAUDE.md "Never mock in tests"). The arg adapter is pure
 * in-process and always runs; op/keychain/bw exercise the real spawn path
 * when the binary/platform is present and honestly skip otherwise.
 */

import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

import {
  enumerateCandidates,
  type CandidatePointer,
} from "../src/values/index.js";
import { ArgAdapter } from "../src/values/adapters/arg.js";
import { OpAdapter } from "../src/values/adapters/op.js";
import { KeychainAdapter } from "../src/values/adapters/keychain.js";
import { BwAdapter } from "../src/values/adapters/bw.js";

function which(bin: string): boolean {
  const r = spawnSync("/usr/bin/which", [bin], { encoding: "utf8" });
  return r.status === 0 && (r.stdout ?? "").trim().length > 0;
}

const HAS_OP = which("op");
const HAS_BW = which("bw");
const IS_DARWIN = platform() === "darwin";

/** Assert no CandidatePointer field carries the given secret substring. */
function assertNoLeak(cands: CandidatePointer[], secret: string): void {
  for (const c of cands) {
    expect(c.pointer).not.toContain(secret);
    expect(c.label).not.toContain(secret);
    if (c.hint) expect(c.hint).not.toContain(secret);
  }
}

describe("arg adapter enumerate()", () => {
  it("lists one CandidatePointer per argScope key, no values", async () => {
    const adapter = new ArgAdapter();
    const cands = await adapter.enumerate({
      argScope: { username: "x", token: "y" },
    });
    expect(cands.length).toBe(2);
    const pointers = cands.map((c) => c.pointer).sort();
    expect(pointers).toEqual(["arg://token", "arg://username"]);
    // Labels are the key NAMES, never the values.
    const labels = cands.map((c) => c.label).sort();
    expect(labels).toEqual(["token", "username"]);
    // No value ("x" / "y") leaked anywhere.
    assertNoLeak(cands, "x");
    assertNoLeak(cands, "y");
    for (const c of cands) {
      expect(c.scheme).toBe("arg");
    }
  });

  it("returns [] when argScope is absent", async () => {
    const adapter = new ArgAdapter();
    expect(await adapter.enumerate({})).toEqual([]);
  });
});

describe("enumerateCandidates intent filter", () => {
  it("ranks login-shaped candidates above unrelated ones", async () => {
    const cands = await enumerateCandidates({
      intent: "login",
      slotName: "username",
      argScope: {
        username: "alice",
        password: "secret",
        unrelated_telemetry_id: "z",
      },
    });
    // Only arg candidates exist in this scope (op/keychain/bw produce real or
    // empty sets, deduped by pointer). Find positions of relevant vs noise.
    const idxUser = cands.findIndex((c) => c.pointer === "arg://username");
    const idxPass = cands.findIndex((c) => c.pointer === "arg://password");
    const idxNoise = cands.findIndex(
      (c) => c.pointer === "arg://unrelated_telemetry_id",
    );
    expect(idxUser).toBeGreaterThanOrEqual(0);
    expect(idxNoise).toBeGreaterThanOrEqual(0);
    // "username" matches both intent/slotName → must outrank the noise key.
    expect(idxUser).toBeLessThan(idxNoise);
    if (idxPass >= 0) {
      // "password" overlaps "login" weakly; still must not rank below noise.
      expect(idxPass).toBeLessThanOrEqual(idxNoise);
    }
  });
});

describe("CANARY: enumerate never leaks a value", () => {
  it("argScope value canary appears in NO enumerate output field", async () => {
    const CANARY = "UNB7-ENUM-CANARY-DO-NOT-LEAK";
    // Bind the canary as a VALUE; the key name is benign.
    const argAdapter = new ArgAdapter();
    const direct = await argAdapter.enumerate({
      argScope: { session_token: CANARY },
    });
    expect(direct.length).toBe(1);
    expect(direct[0].pointer).toBe("arg://session_token");
    expect(direct[0].label).toBe("session_token");
    assertNoLeak(direct, CANARY);

    // Same canary through the full fan-out + merge surface.
    const merged = await enumerateCandidates({
      intent: "auth session",
      argScope: { session_token: CANARY },
    });
    const serialized = JSON.stringify(merged);
    expect(serialized).not.toContain(CANARY);
    assertNoLeak(merged, CANARY);
  });
});

describe("op/keychain/bw enumerate() — skip-if-absent honesty", () => {
  it("op enumerate returns [] when binary absent, real list when present", async () => {
    const adapter = new OpAdapter();
    const cands = await adapter.enumerate({});
    expect(Array.isArray(cands)).toBe(true);
    if (!HAS_OP) {
      // Honest skip: no binary → empty candidate set, no throw.
      expect(cands).toEqual([]);
      return;
    }
    // Binary present: every candidate is pointer-only op:// with a label.
    for (const c of cands) {
      expect(c.scheme).toBe("op");
      expect(c.pointer.startsWith("op://")).toBe(true);
      expect(typeof c.label).toBe("string");
    }
  });

  it("keychain enumerate returns [] off-darwin, exercises spawn on darwin", async () => {
    const adapter = new KeychainAdapter();
    const cands = await adapter.enumerate({});
    expect(Array.isArray(cands)).toBe(true);
    if (!IS_DARWIN) {
      expect(cands).toEqual([]);
      return;
    }
    for (const c of cands) {
      expect(c.scheme).toBe("keychain");
      expect(c.pointer.startsWith("keychain://")).toBe(true);
    }
  });

  it("bw enumerate returns [] when locked/absent, real list when unlocked", async () => {
    const adapter = new BwAdapter();
    const cands = await adapter.enumerate({ intent: "github" });
    expect(Array.isArray(cands)).toBe(true);
    if (!HAS_BW || !process.env.BW_SESSION) {
      expect(cands).toEqual([]);
      return;
    }
    for (const c of cands) {
      expect(c.scheme).toBe("bw");
      expect(c.pointer.startsWith("bw://")).toBe(true);
    }
  });
});

describe("enumerateCandidates fan-out + merge", () => {
  it("merges adapter results; missing adapters contribute [] (no throw)", async () => {
    // arg has candidates; op/keychain/bw may be absent → [] each. No throw.
    // Use distinctive value tokens so the no-leak assertion can't false-match
    // a substring inside a real op/keychain/bw item title.
    const cands = await enumerateCandidates({
      argScope: {
        email: "ZZVAL-EMAIL-9081",
        api_key: "ZZVAL-APIKEY-7742",
      },
    });
    expect(Array.isArray(cands)).toBe(true);
    // The arg candidates must be present in the merged union.
    const pointers = new Set(cands.map((c) => c.pointer));
    expect(pointers.has("arg://email")).toBe(true);
    expect(pointers.has("arg://api_key")).toBe(true);
    // No value leaked through the merge.
    assertNoLeak(cands, "ZZVAL-EMAIL-9081");
    assertNoLeak(cands, "ZZVAL-APIKEY-7742");
  });

  it("dedupes by pointer across adapters", async () => {
    const cands = await enumerateCandidates({
      argScope: { dup: "1" },
    });
    const ptrs = cands.map((c) => c.pointer);
    expect(new Set(ptrs).size).toBe(ptrs.length);
  });

  it("no-args call does not throw and returns an array", async () => {
    const cands = await enumerateCandidates();
    expect(Array.isArray(cands)).toBe(true);
  });
});
