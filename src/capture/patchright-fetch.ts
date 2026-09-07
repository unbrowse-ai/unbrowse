/**
 * The JS-challenge rung of the fetch ladder — a patched, HEADED Chrome.
 *
 * `curl-impersonate-fallback.ts` documents its own boundary: it clears the
 * TLS-fingerprint-only class and explicitly not the JS-challenge class, which
 * "still needs T6.2 (real Chrome through residential proxy)". This is that rung.
 *
 * It is needed, not speculative: measured on this repo's corpus
 * (bench/sites100/CHALLENGE-RATE-FINDINGS.md), 18 of 100 sites are blocked to
 * BOTH plain HTTP and obscura. Neither a Chrome-shaped ClientHello nor a
 * from-scratch JS engine reaches them, because the block is decided by
 * JS-runtime fingerprinting rather than TLS.
 *
 * patchright is Apache-2.0. nodriver/zendriver measure slightly better but are
 * AGPL-3.0 — a licensing decision for this repo, so they are not wired here.
 *
 * OPTIONAL BY CONSTRUCTION. Nothing installs patchright, and this returns null
 * when it is absent so `walkFetchLadder` simply advances to the next rung. It is
 * the LAST rung because it is the most expensive: it launches a real browser.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCurlImpersonatePython } from "./curl-impersonate-fallback.js";

export interface PatchrightResult {
  status: number;
  html: string;
  bytes: number;
}

/** Why the rung could not run — surfaced so a skip is legible, never silent. */
export type PatchrightUnavailable =
  | "helper_missing"
  | "python_missing"
  | "patchright_not_installed"
  | "no_display_for_headed"
  | "patchright_failed";

export interface PatchrightOptions {
  url: string;
  timeoutMs?: number;
  proxy?: string;
  cookies?: Array<{ name: string; value: string; domain?: string; path?: string }>;
  /** Injected for tests: resolves the python interpreter. */
  pythonResolver?: () => Promise<string | null>;
  /** Injected for tests: runs the helper and yields its raw stdout. */
  runner?: (python: string, args: string[], timeoutMs: number) => Promise<string>;
}

/** Path to the helper script, or null when it is not shipped alongside us.
 * cwd-relative resolve is intentional: the helper lives in the repo's scripts/
 * directory, not as an installed package asset, so cwd must be the repo root.
 */
export function helperPath(cwd: string = process.cwd()): string | null {
  const p = resolve(cwd, "scripts", "patchright-fetch.py");
  return existsSync(p) ? p : null;
}

/**
 * Interpret the helper's single-JSON-object contract. Pure, so the parsing is
 * testable without a browser: `{ok:true,...}` is a result, `{ok:false,...}` is a
 * named reason, anything else is unusable output.
 */
export function parseHelperOutput(
  stdout: string,
): { ok: true; result: PatchrightResult } | { ok: false; reason: PatchrightUnavailable | "unparsable"; hint?: string } {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "unparsable" };
  }
  if (j.ok === true && typeof j.html === "string") {
    return {
      ok: true,
      result: {
        status: Number(j.status) || 0,
        html: j.html,
        bytes: Number(j.bytes) || Buffer.byteLength(j.html, "utf8"),
      },
    };
  }
  const reason = typeof j.error === "string" ? (j.error as PatchrightUnavailable) : "patchright_failed";
  return { ok: false, reason, hint: typeof j.hint === "string" ? j.hint : undefined };
}

/** Build the helper argv. Pure — the cookie jar is JSON-encoded, never shell-quoted. */
export function buildHelperArgs(helper: string, opts: PatchrightOptions): string[] {
  const args = [helper, opts.url, "--timeout-ms", String(opts.timeoutMs ?? 45_000)];
  if (opts.proxy) args.push("--proxy", opts.proxy);
  if (opts.cookies && opts.cookies.length > 0) {
    args.push(
      "--cookies",
      JSON.stringify(
        opts.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain ?? "",
          path: c.path ?? "/",
        })),
      ),
    );
  }
  return args;
}

function defaultRunner(python: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((res, rej) => {
    execFile(python, args, { timeout: timeoutMs + 10_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      // The helper always prints a JSON verdict, including for its own refusals,
      // so prefer stdout over the exit code.
      if (stdout && stdout.trim()) res(stdout);
      else rej(err ?? new Error("no output"));
    });
  });
}

/**
 * Run the rung. Returns null whenever it cannot run or did not get a page —
 * the ladder treats null as "advance", so an uninstalled patchright is a skip,
 * not an error.
 */
export async function tryPatchrightFetch(opts: PatchrightOptions): Promise<PatchrightResult | null> {
  const helper = helperPath();
  if (!helper) return null;
  const python = await (opts.pythonResolver ?? resolveCurlImpersonatePython)();
  if (!python) return null;

  try {
    const stdout = await (opts.runner ?? defaultRunner)(
      python,
      buildHelperArgs(helper, opts),
      opts.timeoutMs ?? 45_000,
    );
    const parsed = parseHelperOutput(stdout);
    return parsed.ok ? parsed.result : null;
  } catch {
    return null;
  }
}
