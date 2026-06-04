/**
 * Witness: if the user has no wallet, unbrowse creates a local self-custody
 * identity wallet in their ~/.unbrowse folder — automatically, idempotently.
 *
 * The lever: "make sure if user doesnt create a wallet we create one in their
 * .unbrowse folder for them." The wallet identity is the per-identity ledger key
 * (the routing-memory namespace), so every user must have one from first use.
 *
 * No mocks (per CLAUDE.md): we spawn `bun` in a child process under a TEMP HOME
 * with a pristine ~/.unbrowse, call ensureLocalWalletAddress() for real, and
 * assert on the real files + real address it produces. Under a temp HOME on
 * macOS the keychain path does not exist, so the secret falls back to
 * ~/.unbrowse/wallet.enc and the public pointer to ~/.unbrowse/wallet.json —
 * both land in the temp folder, never the developer's real keychain/home.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SIGNER = join(REPO_ROOT, "src/values/signer.ts");

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "unbrowse-local-wallet-"));
});

afterEach(() => {
  if (tmpHome) {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  }
});

/** Run ensureLocalWalletAddress() in a child under HOME=tmpHome; return stdout addr. */
function ensure(home: string): { addr: string; status: number; stderr: string } {
  const r = spawnSync(
    "bun",
    [
      "-e",
      `const { ensureLocalWalletAddress } = await import(${JSON.stringify(SIGNER)});` +
        `process.stdout.write(ensureLocalWalletAddress());`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: home, UNBROWSE_DISABLE_LOCAL_WALLET: "0" },
    },
  );
  return { addr: (r.stdout ?? "").trim(), status: r.status ?? -1, stderr: r.stderr ?? "" };
}

/** Decode base58 to bytes — the real correctness check on the produced address. */
function base58Decode(s: string): Uint8Array {
  const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    let carry = ALPH.indexOf(s[i]);
    if (carry < 0) throw new Error(`bad base58 char: ${s[i]}`);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < zeros; i++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

test("no wallet -> a local self-custody wallet is created in ~/.unbrowse", () => {
  const unbrowseDir = join(tmpHome, ".unbrowse");
  expect(existsSync(unbrowseDir)).toBe(false); // pristine machine, no wallet yet

  const { addr, status, stderr } = ensure(tmpHome);
  expect(status, `child failed: ${stderr}`).toBe(0);

  // a real Solana-style base58 address that decodes to exactly 32 pubkey bytes
  expect(addr).toMatch(/^[1-9A-HJ-NP-Za-km-z]{40,44}$/);
  expect(base58Decode(addr).length).toBe(32);

  // the wallet now physically exists in their ~/.unbrowse folder
  const pointerPath = join(unbrowseDir, "wallet.json");
  expect(existsSync(pointerPath)).toBe(true);
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
  expect(pointer.address).toBe(addr);
  expect(pointer.provider).toBe("unbrowse-local");
  expect(pointer.pubkey_hex).toMatch(/^[0-9a-f]{64}$/);
  // the encrypted secret was persisted locally too (temp HOME -> file fallback)
  expect(existsSync(join(unbrowseDir, "wallet.enc"))).toBe(true);
});

test("idempotent: a second call returns the SAME address, pointer unchanged", () => {
  const first = ensure(tmpHome);
  expect(first.status).toBe(0);
  const pointerPath = join(tmpHome, ".unbrowse", "wallet.json");
  const created1 = JSON.parse(readFileSync(pointerPath, "utf8")).created_at;

  const second = ensure(tmpHome);
  expect(second.status).toBe(0);
  expect(second.addr).toBe(first.addr); //  — same wallet, not a new one
  const created2 = JSON.parse(readFileSync(pointerPath, "utf8")).created_at;
  expect(created2).toBe(created1); // pointer preserved, not rewritten
});

test("distinct HOMEs get distinct wallets (the address is the identity key)", () => {
  const a = ensure(tmpHome);
  const otherHome = mkdtempSync(join(tmpdir(), "unbrowse-local-wallet-b-"));
  try {
    const b = ensure(otherHome);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(a.addr).not.toBe(b.addr); // a different machine identity = a different key
  } finally {
    rmSync(otherHome, { recursive: true, force: true });
  }
});
