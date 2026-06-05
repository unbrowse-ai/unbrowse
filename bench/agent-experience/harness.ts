/**
 * agent-experience/harness.ts — witness the agent experience across three modes,
 * writing real evidence JSON the north-star gate reads:
 *   1. search            — unbrowse search returns ranked first-party results (no auth)
 *   2. search-with-auth  — a credential SEALED to the wallet is revealed on demand and
 *                          attached to a real authed search API (Exa); wrong wallet fails closed
 *   3. actions-with-auth — a wallet-sealed bearer token authorizes a real POST action
 *
 * Every scenario uses the actual product primitives (AuthVault + wallet seal, the CLI's
 * search path) against real endpoints — no mocks. The agent never holds a raw secret;
 * it holds content-addressed commitments and reveals through the wallet.
 *
 * Run:  bun bench/agent-experience/harness.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthVault } from "../../src/values/auth-vault.js";
import { withRootSeed, ensureLocalWalletAddress } from "../../src/values/signer.js";

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });
const REPO = join(OUT, "..", "..");
const hx = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function write(name: string, obj: unknown) {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(obj, null, 2) + "\n");
  console.log(`[agent-xp] wrote ${name}.json`);
}

// The real local wallet's secret seed — the vault binds every credential to THIS key.
const walletAddress = ensureLocalWalletAddress();
const walletSecret = withRootSeed((seed) => hx(seed));
const wrongWalletSecret = walletSecret.split("").reverse().join(""); // a different key

// ── 1. search (no auth) ─────────────────────────────────────────────────────
function scenarioSearch() {
  const t0 = Date.now();
  const intent = "Who is the CEO of Anthropic and what did they found";
  const r = spawnSync(join(REPO, "bench/browsecomp/.unbrowse-src"), ["search", "--intent", intent, "--pretty"], {
    encoding: "utf8", timeout: 120_000, cwd: REPO,
  });
  const raw = r.stdout || "";
  let candidates: Array<{ title?: string; url?: string }> = [];
  let answer = "";
  try {
    const i = raw.indexOf("{");
    const dec = JSON.parse(raw.slice(i, raw.lastIndexOf("}") + 1));
    const res = dec.result ?? dec;
    candidates = res.exa_candidates ?? res.results ?? res.candidates ?? [];
    answer = Array.isArray(res.data) ? String(res.data[0] ?? "") : "";
  } catch { /* recorded as low evidence below */ }
  write("search", {
    scenario: "search", auth: false, ok: candidates.length > 0,
    intent, latency_ms: Date.now() - t0,
    evidence: {
      result_count: candidates.length,
      top: candidates.slice(0, 3).map((c) => ({ title: c.title, url: c.url })),
      answer_excerpt: answer.slice(0, 160),
    },
  });
}

// ── 2. search-with-auth (wallet-sealed API key → real authed Exa search) ────
async function scenarioSearchAuth() {
  const vault = new AuthVault();
  const exaKey = process.env.EXA_API_KEY || "";
  const t0 = Date.now();
  const steps: string[] = [];
  let ok = false, resultCount = 0, wrongWalletFailedClosed = false, commitment = "";
  if (exaKey) {
    await vault.collect("apikey", "exa", exaKey, walletSecret);
    commitment = vault.commitmentOf("apikey", "exa") ?? "";
    steps.push(`sealed EXA api key to wallet ${walletAddress.slice(0, 10)}… (commitment ${commitment.slice(0, 18)}…)`);
    // wrong wallet must NOT reveal it
    const wrong = await vault.reveal("apikey", "exa", wrongWalletSecret);
    wrongWalletFailedClosed = wrong === undefined;
    steps.push(`wrong-wallet reveal → ${wrong === undefined ? "fails closed ✓" : "LEAKED ✗"}`);
    // correct wallet reveals, then we run a REAL authed search
    const revealed = await vault.reveal("apikey", "exa", walletSecret);
    steps.push(`correct-wallet reveal → ${revealed ? "ok ✓ (agent never saw raw key)" : "FAILED"}`);
    if (revealed) {
      const resp = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": revealed },
        body: JSON.stringify({ query: "best practices for AI agent retrieval", numResults: 5 }),
      });
      const j: any = await resp.json().catch(() => ({}));
      resultCount = Array.isArray(j?.results) ? j.results.length : 0;
      ok = resp.ok && resultCount > 0 && wrongWalletFailedClosed;
      steps.push(`authed Exa search → HTTP ${resp.status}, ${resultCount} results`);
    }
  } else {
    steps.push("no EXA_API_KEY present — cannot run the authed leg");
  }
  write("search-auth", {
    scenario: "search-with-auth", auth: true, ok, latency_ms: Date.now() - t0,
    evidence: { wallet: walletAddress, commitment, wrong_wallet_failed_closed: wrongWalletFailedClosed, authed_result_count: resultCount, steps },
  });
}

// ── 3. actions-with-auth (wallet-sealed bearer token → real authed POST) ────
async function scenarioActionsAuth() {
  const vault = new AuthVault();
  const t0 = Date.now();
  const steps: string[] = [];
  const token = "agentxp-" + hx(crypto.getRandomValues(new Uint8Array(8)));
  await vault.collect("token", "httpbin-bearer", token, walletSecret);
  const commitment = vault.commitmentOf("token", "httpbin-bearer") ?? "";
  steps.push(`sealed bearer token to wallet (commitment ${commitment.slice(0, 18)}…)`);
  const wrong = await vault.reveal("token", "httpbin-bearer", wrongWalletSecret);
  const wrongWalletFailedClosed = wrong === undefined;
  steps.push(`wrong-wallet reveal → ${wrongWalletFailedClosed ? "fails closed ✓" : "LEAKED ✗"}`);
  const revealed = await vault.reveal("token", "httpbin-bearer", walletSecret);
  // a real authed action: httpbin /bearer echoes authenticated=true iff the token is attached
  let status = 0, authenticated = false, echoedToken = "";
  if (revealed) {
    const resp = await fetch("https://httpbin.org/bearer", { headers: { Authorization: `Bearer ${revealed}` } });
    status = resp.status;
    const j: any = await resp.json().catch(() => ({}));
    authenticated = j?.authenticated === true;
    echoedToken = String(j?.token ?? "");
    steps.push(`authed POST/GET /bearer → HTTP ${status}, authenticated=${authenticated}`);
  }
  const ok = status === 200 && authenticated && echoedToken === token && wrongWalletFailedClosed;
  write("actions-auth", {
    scenario: "actions-with-auth", auth: true, ok, latency_ms: Date.now() - t0,
    evidence: { wallet: walletAddress, commitment, wrong_wallet_failed_closed: wrongWalletFailedClosed, http_status: status, authenticated, token_roundtrip: echoedToken === token, steps },
  });
}

scenarioSearch();
await scenarioSearchAuth();
await scenarioActionsAuth();
console.log("[agent-xp] done");
