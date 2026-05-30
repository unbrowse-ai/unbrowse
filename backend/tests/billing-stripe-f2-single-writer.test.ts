/**
 * Falsifier F2 — `stripe:customer:` is a single-writer prefix.
 *
 * The plan's invariant: only services/stripe.ts may write the
 * `stripe:customer:` KV prefix. This test fails the build the moment any
 * other source file references the literal — turning a structural promise
 * into an automated rock (Matt 7:24-25).
 *
 * Why string-match and not behavior: writers are spread across kv backends
 * (PgKV, EdbKV, LocalKV) so behavioral mocking is fragile. The literal
 * prefix is the agreed contract; one grep, one source of truth.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const allowedFiles = new Set([
  "backend/src/services/stripe.ts",
  "backend/src/services/stripe.types.ts",
  "backend/src/services/crypto-sub.ts",
  // test files are allowed to reference the prefix as a key shape assertion
  "backend/tests/billing-stripe-skeleton.test.ts",
  "backend/tests/billing-stripe-f2-single-writer.test.ts",
  "backend/tests/crypto-sub.test.ts",
  "backend/tests/sponsor-stripe-integration.test.ts",
  // Build-time codegen of the public "how unbrowse pays" doc. It RENDERS the
  // `stripe:customer:<id>` KV key shape as prose (sourced from
  // docs/HOW_UNBROWSE_PAYS.md via frontend/scripts/codegen-docs.mjs) to document
  // the Stripe webhook flow — a documenter, not a KV writer. Same category as the
  // test-file key-shape assertions above; the single-writer invariant still holds
  // for real source (only services/stripe.ts writes the prefix).
  "frontend/src/lib/generated/how-unbrowse-pays.html.ts",
]);

function grepLiteral(literal: string): string[] {
  // ripgrep-equivalent via grep -rn; respect .gitignore by limiting to src/
  const r = spawnSync(
    "grep",
    [
      "-rn",
      "--include=*.ts",
      "--include=*.tsx",
      literal,
      "backend/src",
      "src",
      "frontend/src",
      "backend/tests",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`grep failed: status=${r.status} stderr=${r.stderr}`);
  }
  const lines = (r.stdout ?? "").trim().split("\n").filter(Boolean);
  return lines;
}

describe("Falsifier F2 — single-writer prefix", () => {
  it("`stripe:customer:` literal appears ONLY in allowed files", () => {
    const hits = grepLiteral("stripe:customer:");
    const offenders = hits
      .map((line) => line.split(":", 1)[0])
      .filter((path) => path && !allowedFiles.has(path));
    if (offenders.length > 0) {
      throw new Error(
        `F2 violated. Unauthorized writers of 'stripe:customer:' prefix:\n  ` +
          [...new Set(offenders)].join("\n  ") +
          `\n\nAllowed: ${[...allowedFiles].join(", ")}`,
      );
    }
    expect(offenders.length).toBe(0);
  });

  it("`stripe:user:` literal also lives only in allowed files", () => {
    const hits = grepLiteral("stripe:user:");
    const offenders = hits
      .map((line) => line.split(":", 1)[0])
      .filter((path) => path && !allowedFiles.has(path));
    expect(offenders).toEqual([]);
  });
});
