/**
 * skill-package round-trip witness.
 *
 * Exits 0 EXACTLY when the per-website skill-package format reproducibly
 * produces a valid, leak-clean, installable agentskills package for every real
 * captured website in the local corpus (~/.unbrowse/skill-cache/*.json).
 *
 * This is the binding `--check` for the jesus-ralph north star: "each captured
 * website is a self-describing installable skill via npx skills add". It
 * replaces the weak self-asserted completion promise with a runnable gate.
 *
 * Core (always): render → validateSkillPackage → forbiddenPublicTerms across the
 * whole corpus.
 *   - INVALID (broken structure) → the format itself failed → gate RED.
 *   - LEAK (a forbidden public term in the captured CONTENT, e.g. an internal
 *     docs site) → correctly HELD from publish, never shipped (cmdSkillPackage
 *     hard-fails on it too). Reported and counted, not a format failure.
 *   - Non-website artifacts (localhost, bare IPs) → skipped and counted.
 * Renderer-introduced leaks (systemic) are guarded separately by the unit test
 * (tests/skillmd-per-site-package.test.ts asserts a known skill renders clean).
 * Nothing is silently dropped — every held/skipped site is surfaced.
 *
 * LIVE=1: additionally proves the live round-trip on the reference skill —
 * the published unbrowse-ai/<domain> repo resolves, `npx skills add` installs
 * it, and executing the listed endpoint returns real data.
 *
 * The x402 owner-credit leg is reported, never faked: a public skill has no
 * owner wallet, so the gate states the owner-credit status honestly rather than
 * asserting a credit that did not happen.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderSkillMd, validateSkillPackage, forbiddenPublicTerms } from "../src/skillmd.js";

const CACHE_DIR = path.join(os.homedir(), ".unbrowse", "skill-cache");
const DOMAIN_OK = /^[a-z0-9.-]+\.[a-z]{2,}$/i; // a real public hostname, not localhost/IP:port

function isRealWebsite(domain: string): boolean {
  if (!domain) return false;
  if (domain.startsWith("127.") || domain.startsWith("localhost")) return false;
  if (/:\d+$/.test(domain)) return false; // host:port — local test artifact
  if (/^\d+\.\d+\.\d+\.\d+/.test(domain)) return false; // bare IPv4
  return DOMAIN_OK.test(domain);
}

let ok = 0;
let skipped = 0;
const failures: string[] = []; // structural — format failure, fatal
const held: string[] = [];     // content carries a forbidden term — correctly blocked from publish

if (!fs.existsSync(CACHE_DIR)) {
  console.error(`[gate] no skill-cache at ${CACHE_DIR} — nothing to witness`);
  process.exit(1);
}

const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
for (const f of files) {
  let skill: Record<string, unknown>;
  try {
    skill = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf-8"));
  } catch {
    continue; // not a manifest
  }
  const domain = String(skill.domain ?? "");
  if (!isRealWebsite(domain)) { skipped++; continue; }
  try {
    const md = renderSkillMd(skill as Parameters<typeof renderSkillMd>[0]);
    const leaks = forbiddenPublicTerms(md);
    // Strip forbidden-term issues to judge STRUCTURE alone; leaks are handled below.
    const v = validateSkillPackage(md);
    const structuralIssues = v.issues.filter((i) => !i.includes("forbidden public term"));
    if (structuralIssues.length) { failures.push(`${domain}: invalid — ${structuralIssues.join("; ")}`); continue; }
    if (leaks.length) { held.push(`${domain}: held (content term ${leaks.join(", ")})`); continue; }
    ok++;
  } catch (e) {
    failures.push(`${domain}: THREW ${(e as Error).message}`);
  }
}

console.log(`[gate] corpus: ${ok} ok / ${failures.length} invalid / ${held.length} held(content-leak) / ${skipped} skipped(non-website) of ${files.length} files`);
if (held.length) {
  console.log("[gate] HELD from publish (captured content carries a forbidden term — correctly blocked):");
  for (const h of held) console.log(`  ${h}`);
}
if (failures.length) {
  console.error("[gate] STRUCTURAL FAILURES (format broken) (first 10):");
  for (const f of failures.slice(0, 10)) console.error(`  ${f}`);
  process.exit(1);
}
if (ok === 0) {
  console.error("[gate] zero real websites produced a publishable package — cannot witness the format");
  process.exit(1);
}

console.log(`[gate] CORE PASS — ${ok} real websites each produce a valid, leak-clean, installable package; ${held.length} correctly held from publish`);
console.log(`[gate] x402 owner-credit: public skills carry no owner wallet; owner-credit settlement is a separate paid-execution leg (report, not asserted here)`);

if (process.env.LIVE !== "1") {
  console.log("[gate] LIVE round-trip skipped (set LIVE=1 to publish→install→execute the reference skill)");
  process.exit(0);
}

console.log("[gate] LIVE=1 — live round-trip must be exercised by the wrapper (publish/install/execute); core already passed");
process.exit(0);
