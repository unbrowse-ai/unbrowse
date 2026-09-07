import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AttestBody,
  type AttestRow,
  GENESIS_PARENT,
  appendLedger,
  artifactSha,
  canonicalBody,
  chainValid,
  headRow,
  signRow,
  verifyRow,
} from "../src/values/build-attest.ts";

function body(over: Partial<AttestBody> = {}): AttestBody {
  return {
    v: 1,
    kind: "cli",
    target: "darwin-arm64",
    artifact_sha: "a".repeat(64),
    parent_sha: GENESIS_PARENT,
    release_version: "9.10.0",
    git_sha: "deadbeef",
    code_hash: "feedface",
    ts: 1_700_000_000_000,
    ...over,
  };
}

describe("build-attest core", () => {
  test("artifactSha is the sha256 of file bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "attest-"));
    const f = join(dir, "artifact.bin");
    writeFileSync(f, "hello-fractal");
    // sha256("hello-fractal") — recomputed independently below
    const { createHash } = require("node:crypto");
    const expected = createHash("sha256").update("hello-fractal").digest("hex");
    expect(artifactSha(f)).toBe(expected);
  });

  test("sign → verify roundtrip succeeds", async () => {
    const row = await signRow(body());
    expect(row.wallet_pubkey).toHaveLength(64);
    expect(row.sig).toHaveLength(128);
    expect(verifyRow(row)).toBe(true);
  });

  test("tampering with the artifact_sha breaks the signature", async () => {
    const row = await signRow(body());
    const tampered: AttestRow = { ...row, artifact_sha: "b".repeat(64) };
    expect(verifyRow(tampered)).toBe(false);
  });

  test("tampering with the parent link breaks the signature", async () => {
    const row = await signRow(body({ parent_sha: "c".repeat(64) }));
    const tampered: AttestRow = { ...row, parent_sha: GENESIS_PARENT };
    expect(verifyRow(tampered)).toBe(false);
  });

  test("canonicalBody is stable regardless of input key order", () => {
    const a = canonicalBody(body());
    const reordered = { ts: 1_700_000_000_000, kind: "cli", v: 1, artifact_sha: "a".repeat(64), target: "darwin-arm64", parent_sha: GENESIS_PARENT, release_version: "9.10.0", git_sha: "deadbeef", code_hash: "feedface" } as unknown as AttestBody;
    expect(canonicalBody(reordered)).toBe(a);
  });

  test("chainValid links genesis → child by artifact_sha and rejects a broken parent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "attest-ledger-"));
    const ledger = join(dir, "build-ledger.jsonl");

    const sha0 = "0".repeat(64);
    const sha1 = "1".repeat(64);
    const r0 = await signRow(body({ artifact_sha: sha0, parent_sha: GENESIS_PARENT }));
    const r1 = await signRow(body({ artifact_sha: sha1, parent_sha: sha0 }));
    appendLedger(r0, ledger);
    appendLedger(r1, ledger);

    expect(headRow("cli", ledger)?.artifact_sha).toBe(sha1);
    expect(chainValid("cli", ledger).ok).toBe(true);

    // A row whose parent does not match the prior artifact breaks the lineage.
    const rBad = await signRow(body({ artifact_sha: "2".repeat(64), parent_sha: "9".repeat(64) }));
    appendLedger(rBad, ledger);
    expect(chainValid("cli", ledger).ok).toBe(false);
  });
});
