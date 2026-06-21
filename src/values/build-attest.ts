/**
 * build-attest — the fractal build self-attestation primitive for unbrowse.
 *
 * This is the unbrowse translation of the /contract substrate's
 * `build-fractal.sh` parent_signature lineage (BUILD → TEST → SIGN → refuse-
 * unsigned). The contract binary parent-signs its successor's sha256 into an
 * append-only ledger and the runtime refuses any binary whose sha has no row.
 * Here the same shape rides unbrowse's OWN crypto: the local x402 wallet
 * (`~/.unbrowse`, Ed25519, via signer.ts `signBytes`) signs each build
 * artifact's sha256 into a lineage chain, witnessed in TWO places —
 *
 *   witness A (local):    attest/build-ledger.jsonl  (this module, offline-verifiable)
 *   witness B (on-chain): IQLabs Solana table        (iq-ledger.ts, when configured)
 *
 * A row binds {kind, artifact_sha, parent_sha, version, git_sha, code_hash, ts}
 * under one wallet signature; parent_sha = the prior row's sha for that kind, so
 * the chain is a git-style history of every build that wallet ever blessed.
 * Tampering with the artifact, the parent link, or the body breaks verify().
 *
 * Runnable: `bun src/values/build-attest.ts sign|verify|self ...` (see cli()).
 */
import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { signBytes } from "./signer.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MODULE_DIR, "..", "..");
export const LEDGER_PATH = join(REPO_ROOT, "attest", "build-ledger.jsonl");

export type AttestKind = "cli" | "server";

/** The signed body. Every field is load-bearing — change one and the sig breaks. */
export interface AttestBody {
  v: 1;
  kind: AttestKind;
  /** platform triple for cli (darwin-arm64…), or worker env for server */
  target: string;
  /** sha256 hex of the build artifact bytes */
  artifact_sha: string;
  /** sha256 of the prior row's artifact for this kind; "genesis" for the first */
  parent_sha: string;
  release_version: string;
  git_sha: string;
  code_hash: string;
  ts: number;
}

/** A persisted ledger row: the signed body + the wallet proof, plus an optional
 *  on-chain tx signature once mirrored to IQ. */
export interface AttestRow extends AttestBody {
  wallet_pubkey: string; // hex Ed25519 pubkey that signed `body`
  sig: string; // hex Ed25519 signature over canonicalBody(body)
  iq_sig?: string; // Solana tx signature once landed on-chain (witness B)
}

export const GENESIS_PARENT = "genesis";

// ─── hashing + canonicalization ──────────────────────────────────────────────

export function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha256 of a file's bytes — the artifact fingerprint the runtime self-checks. */
export function artifactSha(path: string): string {
  return sha256Hex(readFileSync(path));
}

/** Stable, sorted-key JSON projection of the signed fields. The bytes signed and
 *  verified MUST come from here so a re-encode never shifts the signature. */
export function canonicalBody(body: AttestBody): string {
  const ordered: AttestBody = {
    v: body.v,
    kind: body.kind,
    target: body.target,
    artifact_sha: body.artifact_sha,
    parent_sha: body.parent_sha,
    release_version: body.release_version,
    git_sha: body.git_sha,
    code_hash: body.code_hash,
    ts: body.ts,
  };
  return JSON.stringify(ordered);
}

// ─── Ed25519 sign / verify (raw 32-byte pubkey ⇄ SPKI for node:crypto) ────────

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function rawPubkeyToKeyObject(pubkeyHex: string) {
  const raw = Buffer.from(pubkeyHex, "hex");
  if (raw.length !== 32) throw new Error(`ed25519 pubkey must be 32 bytes, got ${raw.length}`);
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Sign a body with the local wallet → a fully-formed (unmirrored) row. */
export async function signRow(body: AttestBody): Promise<AttestRow> {
  const message = Buffer.from(canonicalBody(body), "utf8");
  const { signature, walletPubkey } = await signBytes(new Uint8Array(message));
  return { ...body, wallet_pubkey: toHex(walletPubkey), sig: toHex(signature) };
}

/** Offline-verify a row's wallet signature over its own canonical body. */
export function verifyRow(row: AttestRow): boolean {
  try {
    const message = Buffer.from(canonicalBody(row), "utf8");
    const key = rawPubkeyToKeyObject(row.wallet_pubkey);
    return nodeVerify(null, message, key, Buffer.from(row.sig, "hex"));
  } catch {
    return false;
  }
}

// ─── local ledger (witness A) ────────────────────────────────────────────────

export function readLedger(path = LEDGER_PATH): AttestRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AttestRow);
}

/** Latest row for a kind (its current head of lineage), or undefined. */
export function headRow(kind: AttestKind, path = LEDGER_PATH): AttestRow | undefined {
  const rows = readLedger(path);
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === kind) return rows[i];
  return undefined;
}

export function appendLedger(row: AttestRow, path = LEDGER_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + "\n");
}

/**
 * Validate the full lineage for a kind: every row's sig verifies AND each row's
 * parent_sha equals the prior row's artifact_sha (genesis for the first). This is
 * the chain-integrity half of the gate — the contract substrate's "refuse a sha
 * with no signed parent row", expressed over the whole history.
 */
export function chainValid(kind: AttestKind, path = LEDGER_PATH): { ok: boolean; reason?: string } {
  const rows = readLedger(path).filter((r) => r.kind === kind);
  if (rows.length === 0) return { ok: false, reason: "no rows for kind" };
  let expectedParent = GENESIS_PARENT;
  for (const row of rows) {
    if (!verifyRow(row)) return { ok: false, reason: `bad signature at ts=${row.ts} sha=${row.artifact_sha.slice(0, 12)}` };
    if (row.parent_sha !== expectedParent)
      return { ok: false, reason: `broken lineage: row parent=${row.parent_sha.slice(0, 12)} expected=${expectedParent.slice(0, 12)}` };
    expectedParent = row.artifact_sha;
  }
  return { ok: true };
}

// ─── on-chain mirror (witness B) ─────────────────────────────────────────────

/**
 * Best-effort mirror of a row to the IQ on-chain ledger. Returns the Solana tx
 * signature when it lands, or null when IQ is unconfigured (local-only mode).
 * Honest negative by design: a null here is NOT a fake green — the two-witness
 * gate treats an unconfigured IQ as "witness B unmet", never as a pass.
 */
export async function mirrorToIq(row: AttestRow): Promise<string | null> {
  try {
    const { iqClientFromEnv, iqLedger } = await import("./iq-ledger.js");
    const client = await iqClientFromEnv();
    if (!client) return null;
    const ledger = iqLedger(client);
    const signed = await ledger.append(`build-attest:${row.kind}`, JSON.stringify(row), row.ts);
    return signed.sig || null;
  } catch {
    return null;
  }
}

/** Is there an on-chain row whose result-body matches this artifact_sha? */
export async function iqHasRow(kind: AttestKind, artifactSha: string): Promise<boolean | null> {
  try {
    const { iqClientFromEnv, iqLedger } = await import("./iq-ledger.js");
    const client = await iqClientFromEnv();
    if (!client) return null;
    const ledger = iqLedger(client);
    const history = await ledger.history(`build-attest:${kind}`);
    return history.some((r) => {
      try {
        return (JSON.parse(r.result) as AttestRow).artifact_sha === artifactSha;
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }
}

// ─── runnable CLI ────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function cli(): Promise<void> {
  const cmd = process.argv[2];
  const ledgerPath = arg("ledger") ?? LEDGER_PATH;
  // Lazy import so non-sign paths don't pay the cost / require build info.
  const buildInfo = await import("../build-info.generated.js").catch(() => ({} as Record<string, string>));
  const release_version = (buildInfo as Record<string, string>).BUILD_RELEASE_VERSION ?? "0.0.0";
  const git_sha = (buildInfo as Record<string, string>).BUILD_GIT_SHA ?? "unknown";
  const code_hash = (buildInfo as Record<string, string>).BUILD_CODE_HASH ?? "unknown";

  if (cmd === "sign") {
    const kind = (arg("kind") ?? "cli") as AttestKind;
    const artifactPath = arg("artifact");
    const target = arg("target") ?? "local";
    if (!artifactPath || !existsSync(artifactPath)) {
      console.error(`[attest] sign: --artifact <path> required and must exist`);
      process.exit(2);
    }
    const sha = artifactSha(artifactPath);
    const prev = headRow(kind, ledgerPath);
    const parent_sha = prev ? prev.artifact_sha : GENESIS_PARENT;
    if (prev && prev.artifact_sha === sha) {
      console.error(`[attest] sign: artifact sha unchanged (${sha.slice(0, 12)}…) — already attested as parent. Skipping duplicate row.`);
      process.exit(0);
    }
    const body: AttestBody = { v: 1, kind, target, artifact_sha: sha, parent_sha, release_version, git_sha, code_hash, ts: Date.now() };
    const row = await signRow(body);
    // --no-iq (or UNBROWSE_ATTEST_NO_IQ=1) keeps dry-runs/demos off-chain;
    // the real build pipeline omits it so witness B lands on Solana.
    const skipIq = process.argv.includes("--no-iq") || process.env.UNBROWSE_ATTEST_NO_IQ === "1";
    const iqSig = skipIq ? null : await mirrorToIq(row);
    if (iqSig) row.iq_sig = iqSig;
    appendLedger(row, ledgerPath);
    console.error(`[attest] SIGNED ${kind} ${target} sha=${sha.slice(0, 16)}… parent=${parent_sha.slice(0, 12)}… wallet=${row.wallet_pubkey.slice(0, 12)}… iq=${iqSig ? iqSig.slice(0, 12) + "…" : skipIq ? "skipped(--no-iq)" : "unconfigured"}`);
    console.log(sha);
    process.exit(0);
  }

  if (cmd === "verify") {
    const kind = (arg("kind") ?? "cli") as AttestKind;
    const chain = chainValid(kind, ledgerPath);
    console.error(`[attest] witness A (local lineage ${kind}): ${chain.ok ? "OK" : "FAIL — " + chain.reason}`);
    process.exit(chain.ok ? 0 : 1);
  }

  if (cmd === "self") {
    // Verify a running artifact: its sha must be the head row for its kind.
    const kind = (arg("kind") ?? "cli") as AttestKind;
    const artifactPath = arg("artifact") ?? process.execPath;
    const sha = artifactSha(artifactPath);
    const head = headRow(kind, ledgerPath);
    const ok = !!head && head.artifact_sha === sha && verifyRow(head);
    console.error(`[attest] self ${kind}: artifact=${sha.slice(0, 16)}… head=${head?.artifact_sha.slice(0, 16) ?? "none"}… → ${ok ? "ATTESTED" : "UNATTESTED"}`);
    process.exit(ok ? 0 : 1);
  }

  if (cmd === "mirror") {
    // Retry witness B for the current head WITHOUT minting a new lineage row.
    // Use when the on-chain mirror was throttled/unreachable at sign time.
    const kind = (arg("kind") ?? "cli") as AttestKind;
    const head = headRow(kind, ledgerPath);
    if (!head) {
      console.error(`[attest] mirror: no local head row for ${kind}`);
      process.exit(1);
    }
    const already = await iqHasRow(kind, head.artifact_sha);
    if (already === true) {
      console.error(`[attest] mirror ${kind}: already on-chain (sha=${head.artifact_sha.slice(0, 16)}…)`);
      process.exit(0);
    }
    const sig = await mirrorToIq(head);
    console.error(`[attest] mirror ${kind}: ${sig ? "landed sig=" + sig.slice(0, 16) + "…" : "FAILED (IQ unreachable/throttled)"}`);
    process.exit(sig ? 0 : 1);
  }

  if (cmd === "gate") {
    // Two-witness seal for a kind: A = local lineage valid; B = head row on-chain.
    const kind = (arg("kind") ?? "cli") as AttestKind;
    const allowUnconfigured = process.argv.includes("--allow-iq-unconfigured");
    const chain = chainValid(kind, ledgerPath);
    console.error(`[attest] witness A (local lineage ${kind}): ${chain.ok ? "OK" : "FAIL — " + chain.reason}`);
    if (!chain.ok) process.exit(1);
    const head = headRow(kind, ledgerPath)!;
    const onChain = await iqHasRow(kind, head.artifact_sha);
    if (onChain === true) {
      console.error(`[attest] witness B (IQ on-chain ${kind}): OK — sha=${head.artifact_sha.slice(0, 16)}… found on-chain`);
      console.error(`[attest] SEALED ${kind} on two witnesses`);
      process.exit(0);
    }
    if (onChain === null) {
      const msg = `[attest] witness B (IQ on-chain ${kind}): UNCONFIGURED — IQ not reachable; NOT a two-witness seal`;
      if (allowUnconfigured) {
        console.error(`${msg} (--allow-iq-unconfigured → one-witness pass)`);
        process.exit(0);
      }
      console.error(msg);
      process.exit(1);
    }
    console.error(`[attest] witness B (IQ on-chain ${kind}): FAIL — head sha not found on-chain (run sign without --no-iq)`);
    process.exit(1);
  }

  console.error("usage: build-attest.ts <sign|verify|self|gate> [--kind cli|server] [--artifact <path>] [--target <triple>] [--ledger <path>] [--no-iq] [--allow-iq-unconfigured]");
  process.exit(2);
}

if (import.meta.main) {
  cli().catch((e) => {
    console.error("[attest] fatal:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
