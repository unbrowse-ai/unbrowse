#!/usr/bin/env bun
/**
 * R2: Frontend (Playwright headed) — walks landing -> /install -> /login ->
 * /billing -> /docs against the deployed prod surface (or LOCAL if
 * UNBROWSE_FRONTEND_URL points at localhost).
 *
 * HONEST RED ON MISSING DEP: if @playwright/test is not installed in the
 * workspace, this script writes a diagnostic to summary.kv and exits 2 — it
 * does NOT silently skip. The no-stubs rule (CLAUDE.md "No stubs, no dummy
 * data") forbids fake-passing on missing surface.
 *
 * Env contract:
 *   MATRIX_CELL_ID         = R2C1 | R2C2
 *   MATRIX_ARTIFACT_DIR    = scripts/matrix/.artifacts/<cell_id>
 *   UNBROWSE_FRONTEND_URL  = default https://unbrowse.ai
 *   For C1: PRIVY_TEST_COOKIE — optional pre-seeded session cookie
 *   For C2: leave PRIVY_TEST_COOKIE unset; cold session
 *
 * Per CLAUDE.md: harness collects, agent judges. We capture screenshots +
 * network log + page error log and emit one summary.kv with sub_state. We do
 * NOT decide green/red from the harness side.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CELL_ID = process.env.MATRIX_CELL_ID;
const ART_DIR = process.env.MATRIX_ARTIFACT_DIR;
const FRONT = process.env.UNBROWSE_FRONTEND_URL || "https://unbrowse.ai";

if (!CELL_ID || !ART_DIR) {
  console.error("MATRIX_CELL_ID and MATRIX_ARTIFACT_DIR required");
  process.exit(2);
}
mkdirSync(ART_DIR, { recursive: true });

const startMs = Date.now();

// ---------------------------------------------------------------------------
// Resolve playwright at runtime so we can write an actionable diagnostic
// instead of crashing on missing module (no-fake-pass + no-blank-skip).
// ---------------------------------------------------------------------------
let chromium: any = null;
let importError: string | null = null;
try {
  // @playwright/test exposes chromium under playwright-core; try multiple shapes.
  const mod = await import("playwright").catch(() => null);
  if (mod && (mod as any).chromium) {
    chromium = (mod as any).chromium;
  } else {
    const modT = await import("@playwright/test").catch(() => null);
    if (modT && (modT as any).chromium) chromium = (modT as any).chromium;
  }
  if (!chromium) {
    importError = "playwright module exports no chromium driver";
  }
} catch (e: any) {
  importError = `playwright not installed: ${e?.message || e}`;
}

function writeSummary(rows: Record<string, string | number | boolean>) {
  const lines = Object.entries(rows).map(([k, v]) => `${k}=${v}`).join("\n");
  writeFileSync(join(ART_DIR!, "summary.kv"), lines + "\n");
}

if (!chromium) {
  const dur = Date.now() - startMs;
  writeSummary({
    cell_id: CELL_ID,
    exit_code: 2,
    duration_ms: dur,
    sub_state: "harness_red",
    diagnostic: `${importError} — install with: bun add -d playwright @playwright/test && bunx playwright install chromium`,
    UNBROWSE_WALLET_ADAPTER_present: !!process.env.UNBROWSE_WALLET_ADAPTER,
    UNBROWSE_WALLET_KEY_present: !!process.env.UNBROWSE_WALLET_KEY,
    frontend_url: FRONT,
  });
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Real headed walk
// ---------------------------------------------------------------------------
const pages = [
  { name: "landing", path: "/" },
  { name: "install", path: "/install" },
  { name: "login",   path: "/login" },
  { name: "billing", path: "/billing" },
  { name: "docs",    path: "/docs" },
];

const errors: Array<{ page: string; error: string }> = [];
const status: Array<{ page: string; status: number | null; title: string; bodyChars: number }> = [];

const browser = await chromium.launch({ headless: process.env.MATRIX_HEADLESS === "false" ? false : true });
const context = await browser.newContext();

// C1: pre-seed Privy session cookie if provided
if (process.env.PRIVY_TEST_COOKIE) {
  try {
    const cookies = JSON.parse(process.env.PRIVY_TEST_COOKIE);
    await context.addCookies(Array.isArray(cookies) ? cookies : [cookies]);
  } catch (e: any) {
    errors.push({ page: "<setup>", error: `PRIVY_TEST_COOKIE parse failed: ${e?.message}` });
  }
}

for (const p of pages) {
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e: any) => pageErrors.push(String(e?.message || e)));
  page.on("requestfailed", (req: any) => pageErrors.push(`req_failed ${req.method()} ${req.url()}: ${req.failure()?.errorText}`));

  let resp: any = null;
  try {
    resp = await page.goto(FRONT + p.path, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1500); // settle for client-side hydrate
  } catch (e: any) {
    errors.push({ page: p.name, error: `goto failed: ${e?.message}` });
  }

  try {
    const title = await page.title().catch(() => "");
    const body = await page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0);
    await page.screenshot({ path: join(ART_DIR!, `${p.name}.png`), fullPage: true });
    status.push({
      page: p.name,
      status: resp?.status() ?? null,
      title,
      bodyChars: body,
    });
  } catch (e: any) {
    errors.push({ page: p.name, error: `inspect failed: ${e?.message}` });
  }
  for (const err of pageErrors) errors.push({ page: p.name, error: err });
  await page.close();
}

await context.close();
await browser.close();

writeFileSync(join(ART_DIR!, "pages.json"), JSON.stringify(status, null, 2));
writeFileSync(join(ART_DIR!, "errors.json"), JSON.stringify(errors, null, 2));

// sub_state: this row is a UX surface walk, x402 only fires on paid-action click.
// We emit a structural sub_state describing the wallet posture; agent reads
// pages.json + errors.json + screenshots and judges in-thread.
const subState = process.env.UNBROWSE_WALLET_ADAPTER ? "wallet_present_ux_walk" : "no_wallet_ux_walk";

writeSummary({
  cell_id: CELL_ID,
  exit_code: errors.length > 0 ? 1 : 0,
  duration_ms: Date.now() - startMs,
  sub_state: subState,
  pages_walked: pages.length,
  pages_with_errors: new Set(errors.map((e) => e.page)).size,
  UNBROWSE_WALLET_ADAPTER_present: !!process.env.UNBROWSE_WALLET_ADAPTER,
  UNBROWSE_WALLET_KEY_present: !!process.env.UNBROWSE_WALLET_KEY,
  frontend_url: FRONT,
});

process.exit(errors.length > 0 ? 1 : 0);
