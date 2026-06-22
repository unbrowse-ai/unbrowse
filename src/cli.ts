#!/usr/bin/env bun
/**
 * Unbrowse CLI — shell-safe wrapper for the local API.
 * Eliminates curl + jq escaping issues. All JSON is constructed
 * and parsed in TypeScript, never through shell interpolation.
 *
 * Usage: unbrowse <command> [flags]
 */

import { config as loadEnv } from "dotenv";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { extractEmbeddedJsonBody, inferWriteMethod } from "./lib/infer-write-method.js";
import { extractAuthHeader } from "./lib/extract-auth-header.js";
import { bridgeKuriProxyEnv, kuriProxyTraceEnabled, ensureKuriProxyReachable } from "./env/kuri-proxy-bridge.js";
import { flatCommandVerb, looksLikeContractGoal } from "./cli-v7/kind-map.js";
import { peekResolution, storeResolution } from "./values/cached-resolution.js";
import { resolutionContractVerdict } from "./values/resolution-contract.js";
import { resolutionCardinalityMatches } from "./values/cardinality.js";
import { requestCacheKey, isIdempotentRequest } from "./values/cache-key.js";
import { cmdCookies } from "./cli-cookies.js";
import { cmdWallet } from "./cli-wallet.js";
import { dispatchByKind } from "./cli-v7/dispatch/index.js";
import { reportUsage } from "./telemetry/issue.js";
import {
  detectTelemetryHostType,
  ensureCliInstallTracked,
  ensureRegistered,
  createDashboardPairingToken,
  fetchAccountPreferences,
  getApiKey,
  loadConfig,
  magicRegister,
  pushAccountPreferences,
  recordFunnelTelemetryEvent,
  recordInstallTelemetryEvent,
  resetLocalRegistration,
  saveConfig,
} from "./client/index.js";
import { appendImpact, impactFromResult } from "./impact-log.js";
import { computeResolveDeadlineMs } from "./resolve-deadline.js";
import { stopServer } from "./runtime/local-server.js";
import { getInProcessApp } from "./runtime/in-process-app.js";
import { isBundledVirtualEntrypoint, isMainModule, resolveSiblingEntrypoint, runtimeArgsForEntrypoint } from "./runtime/paths.js";
import { drainPendingIndexJobs } from "./lib/indexer-core/index.js";
import { drainPendingPassivePublishes } from "./orchestrator/passive-publish.js";
import { runSetup, type SetupReport, type SetupScope } from "./runtime/setup.js";
import { checkForUpdates, maybeSpawnBackgroundUpdateCheck, recordUpdateHint } from "./runtime/update-hints.js";
import { promptContributionMode, maybeShowContributionNotice } from "./cli-setup.js";
import { getContributionConfig, setContributionConfig } from "./config/contribution.js";
import { getCapturePipelineSettings, updateCapturePipelineSettings } from "./settings.js";
import {
  api,
  output,
  die,
  info,
  openUrl,
  withPendingNotice,
  emitImpactSummary,
  emitNextActionSummary,
  BASE_URL,
  FRONTEND_URL,
} from "./cli-v7/_shared/cli-runtime.js";

loadEnv({ quiet: true });
loadEnv({ path: ".env.runtime", quiet: true });

(() => {
  const outcome = bridgeKuriProxyEnv();
  // Happy-path outcomes are diagnostic noise on every command (incl. --help);
  // surface them only under the opt-in kuri trace flag. Misconfiguration
  // warnings below stay unconditional — those are actionable.
  const trace = kuriProxyTraceEnabled();
  if (outcome.wired) {
    if (trace) console.error(`[kuri-proxy] wired KURI_PROXY (source=${outcome.source}, url=${outcome.redacted})`);
  } else if (outcome.reason === "already_set") {
    if (trace) console.error(`[kuri-proxy] respected pre-existing KURI_PROXY (${outcome.existing})`);
  } else if (outcome.reason === "opt_out") {
    // UNBROWSE_DIRECT_EGRESS=1 or UNBROWSE_KURI_PROXY=0/false — explicit
    // opt-out from the residential-proxy-default policy.
    if (trace) console.error("[kuri-proxy] direct egress (opt-out); kuri runs without --proxy-server");
  } else if (outcome.reason === "creds_missing") {
    // The common default now: no proxy configured → direct egress. This is
    // expected, not actionable, so keep it behind the trace flag (it would
    // otherwise print on every command, incl. --help).
    if (trace) console.error("[kuri-proxy] no proxy configured — kuri runs direct (set UNBROWSE_PROXY_URL / IProyal creds / UNBROWSE_PROXYKINGDOM_URL to opt in)");
  } else if (outcome.reason === "invalid_toggle") {
    console.error(`[kuri-proxy] UNBROWSE_KURI_PROXY="${outcome.value}" not recognized — expected auto|1|true|0|false or explicit http://|socks5:// URL`);
  }
})();

let walletNudgeShown = false;

function baseUrlIsLocalhost(): boolean {
  try {
    const host = new URL(BASE_URL).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Background-queue sweep (opportunistic) + hidden __drain-queue verb
// ---------------------------------------------------------------------------

import { stat as _statForQueue, readdir as _readdirForQueue } from "node:fs/promises";
import { join as _joinForQueue } from "node:path";

function _getQueueDir(): string {
  return _joinForQueue(process.env.HOME ?? "/tmp", ".unbrowse", "queue", "pending");
}
function _getCaptureSpoolDir(): string {
  return _joinForQueue(process.env.HOME ?? "/tmp", ".unbrowse", "queue", "capture-pending");
}
function _getHeartbeatPath(): string {
  return _joinForQueue(process.env.HOME ?? "/tmp", ".unbrowse", "queue", ".heartbeat");
}
async function _isHeartbeatStale(maxAgeMs: number = 10_000): Promise<boolean> {
  try {
    const s = await _statForQueue(_getHeartbeatPath());
    return Date.now() - s.mtimeMs > maxAgeMs;
  } catch {
    return true;
  }
}
async function _dirHasJobs(dir: string): Promise<boolean> {
  try {
    const entries = await _readdirForQueue(dir);
    return entries.some((e) => e.endsWith(".json") && !e.endsWith(".tmp"));
  } catch {
    return false;
  }
}
async function _hasPendingJobs(): Promise<boolean> {
  // The detached drain worker now spans two lanes: capture-pending (raw,
  // pre-enrich envelopes from a one-shot /v1/browse/go) and pending
  // (enriched BackgroundIndexJob). Either lane being non-empty must trip
  // the sweep so "drained by any later process" holds for both.
  return (await _dirHasJobs(_getQueueDir())) || (await _dirHasJobs(_getCaptureSpoolDir()));
}
async function _spawnDrainWorker(): Promise<void> {
  // Audit #6 P1 fix: mirror index.ts spawn guards. Without entry guard and
  // error/exit listeners, a packaged binary with empty argv[1] (or any spawn
  // failure) silently leaks jobs forever since stdio:"ignore" hides the child's
  // immediate exit and the heartbeat never gets written.
  const entry = process.argv[1];
  if (!entry) {
    console.error("[unbrowse:sweep] cannot spawn drain worker: process.argv[1] is empty");
    return;
  }
  // Phase 1.1 Day 5 (Model B): gate the spawn on the global worker slot.
  // Parent holds the slot just long enough to spawn; the child re-acquires
  // on its own startup and becomes the canonical holder for its lifetime.
  const { tryAcquireWorkerSlot } = await import("./lib/indexer-core/queue-store.js");
  const slot = await tryAcquireWorkerSlot(_getQueueDir());
  if (slot === null) return;
  try {
    const child = spawn(process.execPath, [entry, "__drain-queue"], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => {
      console.error(`[unbrowse:sweep] drain worker spawn failed: ${(err as Error).message}`);
    });
    child.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        console.error(`[unbrowse:sweep] drain worker exited with code ${code}`);
      } else if (signal) {
        console.error(`[unbrowse:sweep] drain worker killed by signal ${signal}`);
      }
    });
    child.unref();
  } catch (err) {
    console.error(`[unbrowse:sweep] drain worker spawn threw: ${(err as Error).message}`);
  } finally {
    await slot();
  }
}
async function _maybeSweepQueue(): Promise<void> {
  if (process.env.UNBROWSE_NO_SWEEP === "1") return;
  if (process.env.UNBROWSE_INLINE_INDEX === "1") return;
  if (!(await _hasPendingJobs())) return;
  if (!(await _isHeartbeatStale())) return;
  await _spawnDrainWorker();
}


// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean>; params: Record<string, string> } {
  const raw = argv.slice(2); // skip runtime + script
  const command = raw[0] && !raw[0].startsWith("--") ? raw[0] : "help";
  const rest = command === "help" ? raw : raw.slice(1);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const params: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-p" || a === "--param") {
      const next = rest[i + 1];
      if (next && next.includes("=")) {
        const eq = next.indexOf("=");
        params[next.slice(0, eq)] = next.slice(eq + 1);
        i++;
      } else {
        die(`-p requires key=value, got: ${next ?? "<end of args>"}`);
      }
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      // Flags that always consume the next arg as their value (even if it
      // starts with -- because nanoid IDs can begin with `-` / `--`).
      const valueExpectedFlags = new Set([
        "skill", "skill-id", "endpoint", "endpoint-id", "intent", "task", "query", "url", "domain", "params", "path", "extract", "limit",
        "session", "ref", "text", "value", "form-selector", "submit-selector", "wait-for", "timeout-ms",
        "target-origin", "target-href", "bundle-url", "bundle-source", "post-eval", "fingerprint",
        "impersonate", "origin", "bundle", "eval",
      ]);
      // Flags that NEVER consume the next arg, even if it doesn't start with --.
      // Lets `unbrowse fetch --proxy https://httpbin.org/ip` parse correctly
      // with the URL as positional and --proxy as a boolean toggle.
      const booleanOnlyFlags = new Set([
        "proxy", "raw", "pretty", "envelope", "stdin",
        "no-browser-cookies", "publish", "no-start", "skip-browser",
        "no-claude-register", "no-auto-start", "no-open", "register",
        "reset-key", "help",
      ]);
      if (booleanOnlyFlags.has(key)) {
        flags[key] = true;
      } else if (valueExpectedFlags.has(key)) {
        // Don't consume the next arg if it's clearly another flag (-p, --foo).
        // nanoid IDs may start with `-` but never `-p` or `--`.
        if (next === undefined) die(`--${key} requires a value`);
        if (next === "-p" || next === "--param" || next.startsWith("--")) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      } else if (!next || next.startsWith("--") || next === "-p" || next === "--param") {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { command, args: positional, flags, params };
}

// ---------------------------------------------------------------------------
// HTTP helpers — api/output/die/info moved to ./cli-v7/_shared/cli-runtime.ts
// (imported at top of file) so the cli-v7 handler ports can reuse them.
// ---------------------------------------------------------------------------

/// Health-check Kuri at $KURI_BASE_URL. If down, auto-spawn from
/// submodules/kuri/zig-out/bin/kuri (dev) or vendored npm path.
/// Polls until ready or 8s elapsed. die()s on failure with actionable error.
/// Health-check Kuri at $KURI_BASE_URL. If down, auto-spawn from
/// submodules/kuri/zig-out/bin/kuri (dev) or vendored npm path.
/// Polls until ready or 25s elapsed (Chrome cold-start can take ~10s).
async function ensureKuriReachable(kuriBase: string): Promise<void> {
  const probeOnce = async () => {
    try {
      const h = await fetch(`${kuriBase}/health`, { signal: AbortSignal.timeout(800) });
      return h.ok;
    } catch { return false; }
  };
  if (await probeOnce()) return;

  const { spawn } = await import("node:child_process");
  const { existsSync, openSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const kuriTarget = (() => {
    if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
    if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
    if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
    if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
    if (process.platform === "win32" && process.arch === "x64") return "win-x64";
    return null;
  })();
  const kuriBinName = process.platform === "win32" ? "kuri.exe" : "kuri";

  const candidates = [
    process.env.UNBROWSE_KURI_BIN,
    process.env.KURI_BIN,
    join(process.cwd(), "submodules/kuri/zig-out/bin/kuri"),
    kuriTarget ? join(moduleDir, "../vendor/kuri", kuriTarget, kuriBinName) : undefined,
    kuriTarget ? join(moduleDir, "../packages/skill/vendor/kuri", kuriTarget, kuriBinName) : undefined,
    "/opt/homebrew/bin/kuri",
    "/usr/local/bin/kuri",
  ].filter((p): p is string => !!p && existsSync(p));

  if (candidates.length === 0) {
    die(`Kuri unreachable at ${kuriBase} and no kuri binary found in standard paths. Set UNBROWSE_KURI_BIN, or run: submodules/kuri/zig-out/bin/kuri`);
  }

  const kuriBin = candidates[0];
  // Derive expected port from kuriBase URL so we override Kuri's $PORT
  // env var (Kuri reads PORT, defaults 8080, but Lewis's shell exports
  // PORT=6969 for unbrowse server collision).
  const expectedPort = (() => {
    try { const u = new URL(kuriBase); return u.port || "8080"; } catch { return "8080"; }
  })();
  info(`auto-spawning kuri from ${kuriBin} (port ${expectedPort}, logs: /tmp/kuri.log)`);
  const logFd = openSync("/tmp/kuri.log", "a");
  const child = spawn(kuriBin, [], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, PORT: expectedPort, HOST: "127.0.0.1" },
  });
  child.unref();

  // Poll until ready. Chrome cold-start can take ~10s on macOS.
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await probeOnce()) {
      info(`kuri ready at ${kuriBase}`);
      return;
    }
  }
  die(`auto-spawned kuri but it didn't become ready at ${kuriBase} within 25s. Check: tail /tmp/kuri.log`);
}

/// Feed routes_observed (sandbox bundle's __nativeFetch calls) into the
/// marketplace flywheel.
///
/// Phase 1 (now): aggregate by (host, path-template) so cross-domain noise
/// drops out, log a one-line summary to stderr. Surfaced in the response
/// for the agent to act on.
///
/// Phase 2 (TODO): convert each unique (method, host, path-template) into
/// an Endpoint record and call publishIndexedSkill via the local server's
/// /v1/skills/from-routes endpoint (to be added). Wires this directly into
/// the same publish pipeline `unbrowse capture` uses.
async function publishObservedRoutes(
  routes: Array<{ url: string; method: string; status: number; final_url: string; content_type: string; body_excerpt: string; body_size: number; redirected: boolean }>,
  targetOrigin: string,
  intent?: string,
): Promise<void> {
  if (routes.length === 0) return;
  const targetHost = (() => { try { return new URL(targetOrigin).hostname; } catch { return ""; } })();

  // POST to /v1/skills/from-routes — feeds through extractEndpoints +
  // indexSkillLocally + (gated) publishIndexedSkill. Same pipeline as
  // unbrowse capture, just sourced from sandbox-replay's outbound calls.
  try {
    const result = await api("POST", "/v1/skills/from-routes", {
      routes,
      target_origin: targetOrigin,
      intent,
    }) as {
      ok: boolean;
      skill_id?: string;
      indexed_count?: number;
      total_endpoints?: number;
      skipped?: number;
      publish_status?: string;
      reason?: string;
    };
    if (result.ok && result.indexed_count && result.indexed_count > 0) {
      info(`[flywheel] indexed ${result.indexed_count} new endpoint(s) into skill ${result.skill_id} for ${targetHost} (total: ${result.total_endpoints}, status: ${result.publish_status})`);
    } else if (result.reason) {
      info(`[flywheel] no endpoints indexed for ${targetHost}: ${result.reason}`);
    }
  } catch (e) {
    info(`[flywheel] publish-observed-routes failed: ${(e as Error).message}`);
  }
}

function resolveResultError(result: Record<string, unknown>): string | undefined {
  return (result.result as Record<string, unknown> | undefined)?.error as string | undefined
    ?? result.error as string | undefined;
}

function resolveLoginUrl(result: Record<string, unknown>, fallbackUrl?: string): string {
  return (result.result as Record<string, unknown> | undefined)?.login_url as string
    ?? fallbackUrl
    ?? "";
}

function isResolveSuccessResult(result: Record<string, unknown>): boolean {
  if (resolveResultError(result)) return false;
  const status = (result.result as Record<string, unknown> | undefined)?.status as string | undefined;
  if (status === "no_match" || status === "auth_required" || status === "error") return false;
  return !!result.result || Array.isArray(result.available_endpoints);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function authHandoffDomain(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function isAuthShapedDirectDocumentTask(intent: string, url?: string): boolean {
  const haystack = `${intent} ${url ?? ""}`.toLowerCase();
  return /\b(auth|authenticate|authenticated|login|logged in|sign in|signin|account|session|mail|inbox|console|dashboard|api key|credentials?)\b/.test(haystack);
}

function addDirectDocumentAgentGuidance(
  result: Record<string, unknown>,
  args: { intent: string; url?: string },
): void {
  const inner = result.result as Record<string, unknown> | undefined;
  if (!inner || typeof inner !== "object") return;

  const extraction = inner.extraction as Record<string, unknown> | undefined;
  const impact = result.impact as Record<string, unknown> | undefined;
  const isDirectDocument =
    result.source === "direct-document" ||
    impact?.source === "direct-document" ||
    extraction?.source === "direct-document" ||
    typeof inner.text_excerpt === "string" ||
    typeof inner.markdown === "string" ||
    typeof inner.data === "object";
  if (!isDirectDocument) return;

  const targetUrl =
    typeof args.url === "string" && args.url.length > 0
      ? args.url
      : typeof inner.url === "string"
        ? inner.url
        : undefined;
  const operationId = "direct-document-read";
  const domain = authHandoffDomain(targetUrl);
  const authShaped = isAuthShapedDirectDocumentTask(args.intent, targetUrl);
  if (authShaped && domain) {
    const loginUrl = `https://${domain}/`;
    const authCommand = `unbrowse auth ${shellQuote(loginUrl)}`;
    const requirements = (
      inner.requirements && typeof inner.requirements === "object" && !Array.isArray(inner.requirements)
        ? inner.requirements as Record<string, unknown>
        : {}
    );
    requirements.auth_handoff = {
      login_required: true,
      domain,
      web_login_url: loginUrl,
      reason: "auth_likely_intent",
      surfaces: [
        {
          kind: "local_browser",
          label: "Use existing Dia/Chrome session",
          description:
            `If the user is already signed into ${domain} locally, retry after browser-cookie extraction can refresh the site session.`,
        },
        {
          kind: "agent_browser",
          label: "Open an unbrowse login session",
          commands: [authCommand, "unbrowse close"],
          description:
            `Open ${loginUrl} in an unbrowse-managed browser, let the user sign in, then close to persist fresh cookies for the next resolve.`,
        },
      ],
      next_step:
        `The intent is auth-shaped, so the direct document is only a partial answer. Run \`${authCommand}\`, then retry this resolve.`,
    };
    inner.requirements = requirements;
    if (typeof inner.status !== "string") inner.status = "needs_input";
  }

  if (!Array.isArray(inner.available_operations) || inner.available_operations.length === 0) {
    const directDocumentOperation = {
        operation: "read_returned_direct_document",
        operation_id: operationId,
        endpoint_id: operationId,
        method: "GET",
        ...(targetUrl ? { url_template: targetUrl } : {}),
        requires_auth: false,
        description:
          "Use the returned direct-document data, markdown, or text_excerpt as the answer substrate; no browser was opened.",
    };
    inner.available_operations = authShaped && domain
      ? [
          {
            operation: "authenticate_site_then_retry",
            operation_id: "auth-handoff",
            endpoint_id: "auth-handoff",
            method: "GET",
            url_template: `https://${domain}/`,
            requires_auth: true,
            description:
              "The requested task is auth-shaped. Refresh site credentials, then retry resolve for authenticated data.",
          },
          directDocumentOperation,
        ]
      : [directDocumentOperation];
  }
  if (typeof inner.suggested_next_operation_id !== "string") {
    inner.suggested_next_operation_id = authShaped && domain ? "auth-handoff" : operationId;
  }
  if (authShaped && domain && !inner.next_action) {
    const loginUrl = `https://${domain}/`;
    inner.next_action = {
      title: "Authenticate with site, then retry resolve",
      command: `unbrowse auth ${shellQuote(loginUrl)}`,
      why:
        "The returned direct-document payload is browser-free, but the requested task is auth-shaped. Refresh site credentials first so the next resolve can use authenticated data instead of a public shell.",
    };
  } else if (!inner.next_action) {
    const command = targetUrl
      ? `unbrowse read resolve --intent ${shellQuote(args.intent)} --url ${shellQuote(targetUrl)} --force-capture --no-execute`
      : `unbrowse read resolve --intent ${shellQuote(args.intent)} --force-capture --no-execute`;
    inner.next_action = {
      title: "Use returned direct-document data",
      command,
      why:
        "Resolve already returned a browser-free document payload. Use it directly; run the command only if the agent needs a route shortlist or deeper capture.",
    };
  }
  if (inner.next_action && typeof inner.next_action === "object" && !Array.isArray(inner.next_action)) {
    const nextAction = inner.next_action as Record<string, unknown>;
    if (typeof nextAction.command === "string" && nextAction.command.startsWith("unbrowse resolve ")) {
      nextAction.command = nextAction.command.replace(/^unbrowse resolve\b/, "unbrowse read resolve");
    }
  }
}

function buildAuthHandoffResolveEnvelope(intent: string, targetUrl: string): Record<string, unknown> | null {
  const domain = authHandoffDomain(targetUrl);
  if (!domain) return null;
  const loginUrl = `https://${domain}/`;
  const authCommand = `unbrowse auth ${shellQuote(loginUrl)}`;
  return {
    trace: {
      trace_id: `auth-handoff:${domain}`,
      skill_id: "auth-handoff",
      endpoint_id: "auth-handoff",
      success: true,
    },
    source: "local_primitive",
    impact: {
      source: "local_primitive",
      browser_avoided: true,
    },
    result: {
      status: "needs_input",
      url: targetUrl,
      rejected: true,
      extraction: {
        source: "auth-handoff",
        rejected: true,
      },
      requirements: {
        auth_handoff: {
          login_required: true,
          domain,
          web_login_url: loginUrl,
          reason: "auth_likely_intent",
          surfaces: [
            {
              kind: "local_browser",
              label: "Use existing Dia/Chrome session",
              description:
                `If the user is already signed into ${domain} locally, retry after browser-cookie extraction can refresh the site session.`,
            },
            {
              kind: "agent_browser",
              label: "Open an unbrowse login session",
              commands: [authCommand, "unbrowse close"],
              description:
                `Open ${loginUrl} in an unbrowse-managed browser, let the user sign in, then close to persist fresh cookies for the next resolve.`,
            },
          ],
          next_step:
            `The intent is auth-shaped. Run \`${authCommand}\`, then retry \`unbrowse read resolve --intent ${shellQuote(intent)} --url ${shellQuote(targetUrl)}\`.`,
        },
      },
      available_operations: [
        {
          operation: "authenticate_site_then_retry",
          operation_id: "auth-handoff",
          endpoint_id: "auth-handoff",
          method: "GET",
          url_template: loginUrl,
          requires_auth: true,
          description:
            "The requested task is auth-shaped. Refresh site credentials, then retry resolve for authenticated data.",
        },
        {
          operation: "read_returned_direct_document",
          operation_id: "direct-document-read",
          endpoint_id: "direct-document-read",
          method: "GET",
          url_template: targetUrl,
          requires_auth: false,
          description:
            "Optional public-shell read after auth handoff; authenticated data requires signing in first.",
        },
      ],
      suggested_next_operation_id: "auth-handoff",
      next_action: {
        title: "Authenticate with site, then retry resolve",
        command: authCommand,
        why:
          "The requested task is auth-shaped. Refresh site credentials first so the next resolve can use authenticated data instead of spending time on a public shell.",
      },
    },
  };
}

function normalizeSetupScope(value: string | boolean | undefined): SetupScope {
  if (value === true || value == null) return "auto";
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "global" || normalized === "project" || normalized === "off") return normalized;
  return "auto";
}

// ---------------------------------------------------------------------------
// Slim output — keep only essential trace metadata + result
// ---------------------------------------------------------------------------

export function slimTrace(obj: Record<string, unknown>): Record<string, unknown> {
  const trace = obj.trace as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = {
    trace: trace
      ? {
          trace_id: trace.trace_id,
          skill_id: trace.skill_id,
          endpoint_id: trace.endpoint_id,
          success: trace.success,
          status_code: trace.status_code,
          trace_version: trace.trace_version,
          ...(typeof trace.error === "string" ? { error: trace.error } : {}),
          ...(trace.schema_backfilled ? { schema_backfilled: true } : {}),
        }
      : undefined,
  };
  if (typeof obj.error === "string") out.error = obj.error;
  if (typeof obj.message === "string") out.message = obj.message;
  if (typeof obj.hint === "string") out.hint = obj.hint;
  if (typeof obj.login_url === "string") out.login_url = obj.login_url;
  if (typeof obj.provider === "string") out.provider = obj.provider;
  if ("result" in obj) out.result = obj.result;
  if (Array.isArray(obj.decision_trace)) out.decision_trace = obj.decision_trace;
  if (obj.available_endpoints) out.available_endpoints = obj.available_endpoints;
  if (obj.impact) out.impact = obj.impact;
  if (obj.next_action) out.next_action = obj.next_action;
  if (obj.next_actions) out.next_actions = obj.next_actions;
  if (obj.next_step) out.next_step = obj.next_step;
  if (obj.source) out.source = obj.source;
  if (obj.skill) out.skill = obj.skill;
  // cross-skill DAG suggestion — let the CLI agent see "run skill B's endpoint to fill
  // this hole", not just the MCP/raw path (slimTrace is an allowlist; without this it's dropped).
  if (Array.isArray(obj.cross_skill_producers) && obj.cross_skill_producers.length) {
    out.cross_skill_producers = obj.cross_skill_producers;
  }
  return out;
}

function telemetryDomainFromInput(domain?: string, url?: string): string | null {
  if (domain?.trim()) return domain.trim().replace(/^www\./, "");
  if (!url?.trim()) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}


export async function cmdExplain(flags: Record<string, string | boolean>): Promise<void> {
  const intent = (flags.intent ?? flags.task) as string | undefined;
  const url = flags.url as string | undefined;
  const top = parseInt((flags.top as string) ?? "5", 10) || 5;
  if (!intent || !url) {
    process.stderr.write("usage: unbrowse explain --intent \"...\" --url \"...\" [--top N]\n");
    process.exit(2);
  }
  const body: Record<string, unknown> = {
    intent,
    params: { url },
    context: { url },
    projection: { raw: true },
    // explain bypasses the probe-only short-circuit so the orchestrator
    // returns its full deferral envelope (shortlist + suggested_next_action
    // + commands). Without this, probe wins for any URL that returns 200
    // and explain shows empty shortlist with status:"no_match".
    force_capture: true,
  };
  let result: Record<string, unknown>;
  try {
    result = (await api("POST", "/v1/intent/resolve", body)) as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`explain failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const r = (result.result as Record<string, unknown>) ?? result;
  const ae = (r.available_endpoints as Array<Record<string, unknown>> | undefined) ?? [];
  const ao = (r.available_operations as Array<Record<string, unknown>> | undefined) ?? [];
  const out = {
    intent,
    context_url: url,
    diagnostic: r.diagnostic,
    shortlist_for_judgment: ae.slice(0, top).map((ep, i) => ({
      rank: i,
      endpoint_id: ep.endpoint_id,
      method: ep.method,
      url: ep.url ?? ep.url_template,
      score: ep.score,
      description: ep.description ?? ep.description_out,
      input_params: ep.input_params,
      schema_summary: ep.schema_summary,
      example_fields: ep.example_fields,
      sample_values: ep.sample_values,
      needs_params: ep.needs_params,
      trigger_url: ep.trigger_url,
      agent_warning: ep.agent_warning,  // surfaced when ranker scored ≤0
    })),
    agent_facing_shortlist: ao.slice(0, top).map((op, i) => ({
      rank: i,
      endpoint_id: op.endpoint_id,
      method: op.method,
      url_template: op.url_template ?? op.url,
      description: op.description_out ?? op.description,
    })),
    // Pass through orchestrator's deferral guidance (resolve_hard_handoff
    // path includes suggested_next_action + commands like `unbrowse fetch
    // <url>` for SSR-data sites). Without this, cmdExplain hides the
    // orchestrator's escape-hatch from the agent.
    status: r.status,
    message: r.message,
    suggested_next_action: r.suggested_next_action,
    commands: r.commands,
    judgment_question:
      r.judgment_question
      ?? (`Given the intent ${JSON.stringify(intent)} on ${JSON.stringify(url)}, ` +
          `which of the candidate endpoints in shortlist_for_judgment best satisfies the intent? ` +
          `Reply with the endpoint_id of the best match and a one-line reason. ` +
          `If none match, say defer_to_capture.`),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

// Stable cache key for a resolve invocation — the semantic inputs only (params parse
// is guarded so a malformed --params never throws on the fast path).
function resolveCacheKeyFor(flags: Record<string, string | boolean>, intent: string): string {
  const url = flags.url as string | undefined;
  const domain = flags.domain as string | undefined;
  const cliKv = (flags as Record<string, unknown>)._params as Record<string, string> | undefined;
  let extra: Record<string, unknown> = {};
  try {
    extra = { ...(flags.params ? JSON.parse(flags.params as string) : {}), ...(cliKv && Object.keys(cliKv).length ? cliKv : {}) };
  } catch { extra = {}; }
  // The key MUST include method + body: two POSTs to the same url+intent with different bodies
  // (e.g. different GraphQL queries) must NOT collide. (Was: omitted → wrong cached result served.)
  return requestCacheKey({
    intent, url, domain, autoExecute: flags["no-execute"] !== true, params: extra,
    method: typeof flags.method === "string" ? (flags.method as string) : undefined,
    body: typeof flags.body === "string" ? (flags.body as string) : undefined,
  });
}
function resolveCacheTtlMs(): number {
  if (process.env.UNBROWSE_STATELESS === "1") return 0;
  return Math.max(0, Number(process.env.UNBROWSE_RESOLVE_CACHE_TTL_MS ?? 600_000) || 0);
}
function resolveCacheSafe(flags: Record<string, string | boolean>): boolean {
  const endpointFlag = flags["endpoint-id"] ?? flags.endpoint;
  return resolveCacheTtlMs() > 0
    && typeof endpointFlag !== "string"
    && !flags["dry-run"] && !flags["force-capture"] && !flags["require-proof"]
    // Only cache IDEMPOTENT requests: GET/HEAD or a GraphQL query. A write mutation (generic POST,
    // PUT/DELETE/PATCH, GraphQL mutation/subscription) must never be cached + replayed.
    && isIdempotentRequest(
      typeof flags.method === "string" ? (flags.method as string) : undefined,
      typeof flags.body === "string" ? (flags.body as string) : undefined,
    );
}

function markResolveCacheReplay(hit: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...hit, _cache_hit: true };
  const impact = hit.impact;
  if (impact && typeof impact === "object" && !Array.isArray(impact)) {
    out.impact = { ...(impact as Record<string, unknown>), cache_hit: true };
  }
  const timing = hit.timing;
  if (timing && typeof timing === "object" && !Array.isArray(timing)) {
    out.timing = { ...(timing as Record<string, unknown>), cache_hit: true, source: "cache" };
  }
  return out;
}

async function cmdResolve(flags: Record<string, string | boolean>): Promise<void> {
  const intent = (flags.intent ?? flags.task ?? flags.query) as string;
  if (!intent) die("--intent is required. Example: unbrowse resolve --intent 'search github for repos' --url https://github.com");
  const targetUrl = typeof flags.url === "string" ? flags.url : undefined;
  if (targetUrl && flags["force-capture"] !== true && isAuthShapedDirectDocumentTask(intent, targetUrl)) {
    const authEnvelope = buildAuthHandoffResolveEnvelope(intent, targetUrl);
    if (authEnvelope) {
      output(authEnvelope, !!flags.pretty);
      return;
    }
  }

  // FAST PATH: a fresh resolution-cache hit short-circuits BEFORE the in-process
  // backend boots (~4s) and before any telemetry — warm resolve in ~module-load time.
  // The cached value is the SAME final result the slow path prints, so output is
  // byte-identical. Skipped under stateless / explicit-endpoint / dry-run / force-capture.
  if (resolveCacheSafe(flags)) {
    const cachedHit = peekResolution<Record<string, unknown>>(resolveCacheKeyFor(flags, intent), resolveCacheTtlMs());
    // Cardinality guard (Ezekiel 47:10): a list/search intent must not replay a
    // single-item value. A poisoned row (a product detail cached under a list
    // intent) is treated as a miss so the orchestrator recomputes a real list.
    if (cachedHit && resolutionCardinalityMatches(intent, cachedHit.result ?? (cachedHit as Record<string, unknown>).data)) {
      const replay = markResolveCacheReplay(cachedHit);
      const hostType = detectTelemetryHostType();
      if (process.env.UNBROWSE_LANDING_TOKEN || process.env.UNBROWSE_ATTRIBUTION_B64) {
        // Fire-and-forget: even gated, awaiting it stalled the WARM cache-hit fast path.
        void ensureCliInstallTracked(hostType).catch(() => {});
      }
      addDirectDocumentAgentGuidance(replay, {
        intent,
        url: typeof flags.url === "string" ? flags.url : undefined,
      });
      void recordFunnelTelemetryEvent("resolve_completed", {
        source: "cli",
        hostType,
        properties: { command: "resolve", intent, cache_hit: true },
      }).catch(() => {});
      output(replay, !!flags.pretty);
      return;
    }
  }

  maybeShowContributionNotice();
  const hostType = detectTelemetryHostType();
  // Telemetry is observability, NOT on the critical path. Awaiting these backend POSTs added ~8s
  // to every cold resolve (bisected: 3 awaited network calls before the resolve even started) —
  // the dominant cold-resolve latency and a coverage killer under a fast bench budget. Fire and
  // forget (matches recordOrchestrationPerf's .catch pattern); the events still fire, just off the
  // hot path. Install tracking only matters when an attribution token is present.
  if (process.env.UNBROWSE_LANDING_TOKEN || process.env.UNBROWSE_ATTRIBUTION_B64) {
    void ensureCliInstallTracked(hostType).catch(() => {});
  }
  void recordFunnelTelemetryEvent("cli_invoked", {
    source: "cli",
    hostType,
    properties: { command: "resolve" },
  }).catch(() => {});
  void recordFunnelTelemetryEvent("resolve_started", {
    source: "cli",
    hostType,
    properties: {
      command: "resolve",
      intent,
      domain: telemetryDomainFromInput(flags.domain as string | undefined, flags.url as string | undefined),
      url: typeof flags.url === "string" ? flags.url : null,
      has_url: typeof flags.url === "string",
      has_domain: typeof flags.domain === "string",
      auto_execute: !!flags.execute,
    },
  }).catch(() => {});

  try {
    const body: Record<string, unknown> = { intent };
    const url = flags.url as string | undefined;
    const domain = flags.domain as string | undefined;
    const endpointFlag = flags["endpoint-id"] ?? flags.endpoint;
    const explicitEndpointId = typeof endpointFlag === "string" ? endpointFlag : undefined;
    const noExecute = flags["no-execute"] === true;
    const autoExecute = !noExecute;
    const cliKv = (flags as Record<string, unknown>)._params as Record<string, string> | undefined;
    const extraParams = {
      ...(flags.params ? JSON.parse(flags.params as string) : {}),
      ...(cliKv && Object.keys(cliKv).length > 0 ? cliKv : {}),
    };

    if (url) {
      body.params = { url };
      body.context = { url };
    }
    if (domain) {
      body.context = { ...(body.context as Record<string, unknown> ?? {}), domain };
    }
    if (explicitEndpointId) {
      body.params = { ...(body.params as Record<string, unknown> ?? {}), endpoint_id: explicitEndpointId };
    }
    if (flags.params) {
      body.params = { ...(body.params as Record<string, unknown> ?? {}), ...extraParams };
    }
    if (flags["dry-run"]) body.dry_run = true;
    if (flags["confirm-third-party-terms"]) body.confirm_third_party_terms = true;
    if (flags["force-capture"]) body.force_capture = true;
    if (flags["require-proof"]) body.require_proof = true;
    // Phase 8.1 — per-call latency budget for the parallel resolve race.
    // Default 8000ms when unset; sub-probe values (<200ms) return no_match fast.
    const budgetFlag = flags.budget;
    if (typeof budgetFlag === "string") {
      const parsed = parseInt(budgetFlag, 10);
      if (Number.isFinite(parsed) && parsed > 0) body.budget_ms = parsed;
    } else if (typeof budgetFlag === "number" && Number.isFinite(budgetFlag) && (budgetFlag as number) > 0) {
      body.budget_ms = budgetFlag as number;
    }
    body.projection = { raw: true };

    function execBody(endpointId: string): Record<string, unknown> {
      return {
        params: { endpoint_id: endpointId, ...extraParams },
        intent,
        projection: { raw: true },
        ...(flags["confirm-third-party-terms"] ? { confirm_third_party_terms: true } : {}),
      };
    }

    function endpointNeedsThirdPartyTermsConfirmation(endpoint: Record<string, unknown>): boolean {
      return endpoint.requires_third_party_terms_confirmation === true;
    }

    function resolveSkillId(): string | undefined {
      return (result.skill as Record<string, unknown>)?.skill_id as string
        ?? (result as Record<string, unknown>).skill_id as string
        ?? ((result as Record<string, unknown>).result as Record<string, unknown> | undefined)?.skill_id as string;
    }

    function resolveAvailableEndpoints(): Array<Record<string, unknown>> | undefined {
      return (Array.isArray(result.available_endpoints)
        ? result.available_endpoints
        : Array.isArray((result.result as Record<string, unknown> | undefined)?.available_endpoints)
          ? (result.result as Record<string, unknown>).available_endpoints
          : undefined) as Array<Record<string, unknown>> | undefined;
    }

    const startedAt = Date.now();
    async function resolveOnce(message = "Still working. Searching cached routes..."): Promise<Record<string, unknown>> {
      // CLI guard: never wait longer than the orchestrator's real budget. Floor the
      // outer deadline at the live-capture ceiling so a cold capture isn't abandoned
      // with a false cli_timeout (#838); UNBROWSE_API_TIMEOUT_MS overrides. See
      // computeResolveDeadlineMs (pure + unit-tested in tests/resolve-deadline.test.ts).
      const cliTimeoutMs = computeResolveDeadlineMs(typeof body.budget_ms === "number" ? body.budget_ms : undefined);
      return withPendingNotice(
        api("POST", "/v1/intent/resolve", body, { timeoutMs: cliTimeoutMs }) as Promise<Record<string, unknown>>,
        message,
      );
    }

    let result = await resolveOnce();
    const resultError = resolveResultError(result);
    if (resultError === "auth_required") {
      const loginUrl = resolveLoginUrl(result, url);
      if (loginUrl) info(`Authentication required. Run: unbrowse auth-capture --url "${loginUrl}"`);
    }

    // When agent explicitly picked an endpoint but resolve deferred, execute it directly
    if (explicitEndpointId && resolveAvailableEndpoints()) {
      const skillId = resolveSkillId();
      if (skillId) {
        const resolvedSource = typeof result.source === "string" ? result.source : undefined;
        result = await withPendingNotice(
          api("POST", `/v1/skills/${skillId}/execute`, execBody(explicitEndpointId)) as Promise<Record<string, unknown>>,
          "Executing selected endpoint...",
        );
        if (resolvedSource && typeof result.source !== "string") result.source = resolvedSource;
      }
    }

    function endpointIsSafeToAutoExecute(endpoint: Record<string, unknown>): boolean {
      const method = String(endpoint.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") return false;
      if (endpoint.needs_params && Object.keys(extraParams).length === 0) return false;
      return true;
    }

    // Synthetic page-artifact: capture pipeline emits these for doc_only
    // sites (SSR / JSON-LD / Redux-rehydrated SPA where the page itself is
    // the data surface). url_template === input page URL AND resource_kind
    // is in synthetic set OR description matches the auto-generated form.
    // Re-fetching via libcurl typically fails on CF/anti-bot — skip auto-
    // execute and let the agent call execute explicitly.
    function endpointIsSyntheticPageArtifact(endpoint: Record<string, unknown>): boolean {
      if (!url) return false;
      const tmpl = String(endpoint.url_template ?? endpoint.url ?? "").replace(/\/+$/, "");
      const norm = url.replace(/\/+$/, "");
      if (tmpl !== norm) return false;
      // dom_extraction:true is the structural marker on available_endpoints —
      // the capture already extracted the page; re-fetching is redundant and,
      // on antibot-gated sites, returns the challenge interstitial body.
      if (endpoint.dom_extraction === true) return true;
      const rk = String(endpoint.resource_kind ?? "").toLowerCase();
      if (["message", "form", "resource", "page", "artifact"].includes(rk)) return true;
      const desc = String(endpoint.description ?? endpoint.description_out ?? "").toLowerCase();
      if (/captured (?:search )?(?:form|page) artifact/.test(desc)) return true;
      if (/^searches .* with /.test(desc) || /^returns .* details with /.test(desc)) return true;
      // Auto-generated "Returns the rendered HTML for ..." description is
      // the synthetic page-artifact marker for SPA captures (Reddit, etc.)
      if (/returns the rendered html for/i.test(desc)) return true;
      return false;
    }

    // Agent default: when resolve has a safe read endpoint, execute it and return
    // data. Use --no-execute when the caller only wants endpoint metadata.
    const endpointsForAutoExecute = resolveAvailableEndpoints();
    if (autoExecute && endpointsForAutoExecute) {
      const endpoints = endpointsForAutoExecute;
      const skillId = resolveSkillId();
      if (skillId && endpoints.length > 0) {
        const bestEndpoint = endpoints[0];
        const resolvedSource = typeof result.source === "string" ? result.source : undefined;
        // Policy gate: never auto-execute a third-party-terms-flagged endpoint
        // without explicit confirmation. The agent must opt in via
        // --confirm-third-party-terms after reading the policy.
        if (
          endpointNeedsThirdPartyTermsConfirmation(bestEndpoint) &&
          !flags["confirm-third-party-terms"]
        ) {
          process.stderr.write(
            `Skipping auto-execute: endpoint ${bestEndpoint.endpoint_id ?? "?"} ` +
            `requires explicit third-party terms confirmation. ` +
            `Re-run with --confirm-third-party-terms to proceed.\n`,
          );
        } else if (!endpointIsSafeToAutoExecute(bestEndpoint)) {
          (result as Record<string, unknown>).next_action = {
            title: "Execute selected endpoint",
            command: `unbrowse execute --skill ${skillId} --endpoint ${bestEndpoint.endpoint_id}`,
            why: "Resolve found a candidate but did not auto-execute because the endpoint is not a safe ready GET.",
          };
        } else if (endpointIsSyntheticPageArtifact(bestEndpoint)) {
          // Capture already fetched this URL via the browser; libcurl
          // re-fetch typically fails on CF/anti-bot sites (ZlibError /
          // HTTP 400 from HEAD probe). Surface the synthetic endpoint
          // as available; the agent can call execute explicitly if it
          // wants a replay attempt.
          (result as Record<string, unknown>).next_action = {
            title: "Synthetic page artifact",
            command: `unbrowse execute --skill ${skillId} --endpoint ${bestEndpoint.endpoint_id}`,
            why: "The captured endpoint is a synthetic page artifact; the SSR/JSON-LD payload was already extracted during capture. Re-fetching may be redundant.",
          };
        } else {
          info(`Auto-executing endpoint: ${bestEndpoint.description ?? bestEndpoint.endpoint_id}`);
          result = await withPendingNotice(
            api("POST", `/v1/skills/${skillId}/execute`, execBody(bestEndpoint.endpoint_id as string)) as Promise<Record<string, unknown>>,
            "Executing best endpoint...",
          );
          if (resolvedSource && typeof result.source !== "string") result.source = resolvedSource;
        }
      }
    }

    if (Date.now() - startedAt > 3_000 && result.source === "live-capture") {
      info("Live capture finished. Future runs against this site should be much faster.");
    }

    if (isResolveSuccessResult(result)) {
      // Fire-and-forget: this backend POST added ~4.7s between the result and printing it
      // (bisected). Observability must not block the answer.
      void recordFunnelTelemetryEvent("resolve_completed", {
        source: "cli",
        hostType,
        properties: {
          command: "resolve",
          intent,
          domain: telemetryDomainFromInput(domain, url),
          url: url ?? null,
          source: result.source,
          auto_execute: autoExecute,
          explicit_endpoint: explicitEndpointId ?? null,
        },
      }).catch(() => {});
    }

    addDirectDocumentAgentGuidance(result, { intent, url });
    result = slimTrace(result);
    emitImpactSummary(result);
    {
      const entry = impactFromResult("resolve", result, { intent, domain, });
      if (entry) appendImpact(entry);
    }
    emitNextActionSummary(result);

    const skill = result.skill as Record<string, unknown> | undefined;
    const trace = result.trace as Record<string, unknown> | undefined;

    // Nudge wallet setup after successful resolve that indexed routes
    if (trace?.success && !walletNudgeShown) {
      try {
        const { checkWalletConfigured } = await import("./payments/wallet.js");
        const wallet = checkWalletConfigured();
        if (!wallet.configured) {
          info("No payout wallet — you won't earn when others reuse your routes. Run: npx @crossmint/lobster-cli setup");
          walletNudgeShown = true;
        }
      } catch (_e) { /* non-fatal */ }
    }

    if (skill?.skill_id && trace) {
      (result as Record<string, unknown>)._feedback = `unbrowse feedback --skill ${skill.skill_id} --endpoint ${trace.endpoint_id || "?"} --rating <1-5>`;
    }

    // /contract-native: render this routing decision as the substrate's OWN three-shape
    // (interpret → verify → adjudicate) and attach the verdict to the result, so a resolve no
    // longer emits an opaque payload — it CARRIES its interpret/verify/adjudicate verdict. Pure +
    // fail-open (same discipline as the IQ on-chain mirror — evidence, never a blocker).
    if (isResolveSuccessResult(result)) {
      const r = result as Record<string, unknown>;
      const winnerEndpoints =
        (skill?.endpoints as unknown[] | undefined) ??
        (r.available_endpoints as unknown[] | undefined) ??
        (r.result ? [{ used: true }] : undefined);
      const verdict = await resolutionContractVerdict({
        intent,
        skill: { skill_id: (skill?.skill_id as string | undefined) ?? (r.skill_id as string | undefined), endpoints: winnerEndpoints },
      });
      r._contract = verdict;
      process.stderr.write(
        `contract: resolution ${verdict.terminal ? "terminal (interpret/verify/adjudicate)" : "frontier=" + verdict.frontier}\n`,
      );
    }

    // Store the FINAL result so a repeated identical resolve hits the fast path above
    // (clean results only; skipped for the unsafe/stateless cases). This is the exact
    // object printed, so the warm fast-path output is byte-identical.
    // Cardinality guard (Ezekiel 47:10): never persist a single-item value under a
    // list/search intent — that is exactly the poison the peek above has to reject.
    if (
      resolveCacheSafe(flags) &&
      isResolveSuccessResult(result) &&
      resolutionCardinalityMatches(intent, (result as Record<string, unknown>).result ?? (result as Record<string, unknown>).data)
    ) {
      storeResolution(resolveCacheKeyFor(flags, intent), result, resolveCacheTtlMs());
    }

    output(result, !!flags.pretty);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void recordFunnelTelemetryEvent("resolve_failed", {
      source: "cli",
      hostType,
      properties: {
        command: "resolve",
        intent,
        domain: telemetryDomainFromInput(flags.domain as string | undefined, flags.url as string | undefined),
        url: typeof flags.url === "string" ? flags.url : null,
        failure_stage: "resolve",
        failure_reason: message,
      },
    });
    throw error;
  }
}

export function parseCmdRunArgs(
  args: string[],
  flags: Record<string, string | boolean>,
  verb = "run",
): { url: string; intent: string } | { error: string } {
  const flagUrl = typeof flags.url === "string" ? flags.url : undefined;
  const flagIntent = (typeof flags.intent === "string" ? flags.intent : undefined)
    ?? (typeof flags.task === "string" ? flags.task : undefined)
    ?? (typeof flags.query === "string" ? flags.query : undefined);

  let url: string | undefined;
  let positionalTask: string | undefined;
  if (flagUrl !== undefined) {
    // When --url is provided, ALL positionals are intent fragments.
    url = flagUrl;
    positionalTask = args.length > 0 ? args.join(" ") : undefined;
  } else {
    // Legacy: args[0] is url, remaining positionals join into intent.
    url = args[0];
    positionalTask = args.length > 1 ? args.slice(1).join(" ") : undefined;
  }

  const intent = flagIntent ?? positionalTask;
  if (!url || !intent) return { error: `usage: unbrowse ${verb} <url> "task"` };
  return { url, intent };
}

function looksLikeUrl(s: string | undefined): boolean {
  return typeof s === "string" && /^https?:\/\//i.test(s);
}

function looksLikeElementRef(s: string | undefined): boolean {
  return typeof s === "string" && /^@?e\d+$/i.test(s);
}

export function shouldFillIntent(
  args: string[],
  flags: Record<string, string | boolean>,
): boolean {
  if (typeof flags.intent === "string"
    || typeof flags.task === "string"
    || typeof flags.query === "string"
    || typeof flags.url === "string"
    || looksLikeUrl(args[0])) {
    return true;
  }
  if (args.length === 0) return false;
  return !looksLikeElementRef(args[0]);
}

function parseCmdHoleIntentArgs(
  args: string[],
  flags: Record<string, string | boolean>,
  verb: "get" | "fill",
): { url?: string; intent: string } | { error: string } {
  const flagUrl = typeof flags.url === "string" ? flags.url : undefined;
  const flagIntent = (typeof flags.intent === "string" ? flags.intent : undefined)
    ?? (typeof flags.task === "string" ? flags.task : undefined)
    ?? (typeof flags.query === "string" ? flags.query : undefined);

  if (flagUrl) {
    const intent = flagIntent ?? (args.length > 0 ? args.join(" ") : undefined);
    if (!intent) return { error: `usage: unbrowse ${verb} "task" [--url <url>]` };
    return { url: flagUrl, intent };
  }

  if (looksLikeUrl(args[0])) {
    const intent = flagIntent ?? (args.length > 1 ? args.slice(1).join(" ") : undefined);
    if (!intent) return { error: `usage: unbrowse ${verb} <url> "task"` };
    return { url: args[0], intent };
  }

  const intent = flagIntent ?? (args.length > 0 ? args.join(" ") : undefined);
  if (!intent) return { error: `usage: unbrowse ${verb} "task" [--url <url>]` };
  return { intent };
}

export function parseCmdGetArgs(
  args: string[],
  flags: Record<string, string | boolean>,
): { url?: string; intent: string } | { error: string } {
  return parseCmdHoleIntentArgs(args, flags, "get");
}

export function parseCmdFillArgs(
  args: string[],
  flags: Record<string, string | boolean>,
): { url?: string; intent: string } | { error: string } {
  return parseCmdHoleIntentArgs(args, flags, "fill");
}

export function isDraftOnlyMutationIntent(intent: string): boolean {
  const s = intent.toLowerCase();
  const asksForDraft =
    /\b(draft|write|compose|prepare|suggest)\b/.test(s) &&
    /\b(message|reply|dm|contact|inquiry|enquiry|seller|agent)\b/.test(s);
  const explicitSendSideEffect =
    (/\b(send|buy|purchase|offer|submit|click)\b/.test(s) ||
      /\b(message|dm|contact)\s+(the\s+)?(seller|agent|owner|user|them|him|her)\b/.test(s)) &&
    !/\bdo not (send|contact|message|buy|purchase|offer|submit|click)\b/.test(s) &&
    !/\bdon't (send|contact|message|buy|purchase|offer|submit|click)\b/.test(s) &&
    !/\bwithout (sending|contacting|messaging|buying|purchasing|offering|submitting|clicking)\b/.test(s) &&
    !/\b(no|never) (send|contact|message|buy|purchase|offer|submit|click)\b/.test(s);
  const forbidsSideEffect =
    /\bdo not (send|contact|message|buy|purchase|offer|submit|click)\b/.test(s) ||
    /\bdon't (send|contact|message|buy|purchase|offer|submit|click)\b/.test(s) ||
    /\bwithout (sending|contacting|messaging|buying|purchasing|offering|submitting|clicking)\b/.test(s) ||
    /\b(no|never) (send|contact|message|buy|purchase|offer|submit|click)\b/.test(s);
  return asksForDraft && (forbidsSideEffect || !explicitSendSideEffect);
}

export function draftOnlySubjectHint(intent: string): string {
  let subject = intent
    .replace(/\bdo not\b[^.?!]*(?:[.?!]|$)/gi, " ")
    .replace(/\bdon't\b[^.?!]*(?:[.?!]|$)/gi, " ")
    .replace(/\bwithout\b[^.?!]*(?:[.?!]|$)/gi, " ")
    .replace(/\b(?:no|never)\s+(?:send|contact|message|buy|purchase|offer|submit|click)\b[^.?!]*(?:[.?!]|$)/gi, " ")
    .replace(/\b(draft|write|compose|prepare|suggest)\b/gi, " ")
    .replace(/\b(polite|message|reply|dm|contact|inquiry|enquiry|seller|agent|asking|ask|whether|if|still|available|availability)\b/gi, " ")
    .replace(/\b(send|sent|buy|purchase|offer|submit|click)\b/gi, " ")
    .replace(/\b(a|an|the|to|for|with|and|or|is|are|it|this|that|me|my|please)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  subject = subject.replace(/^[,.:;!?-]+|[,.:;!?-]+$/g, "").trim();
  return subject.length >= 3 ? subject : "the first relevant visible listing";
}

export function draftOnlyReadIntent(intent: string): string {
  const subject = draftOnlySubjectHint(intent);
  const wantsAvailability = /\b(available|availability|still there|still for sale)\b/i.test(intent);
  return [
    `Find the first visible ${subject} on this public page.`,
    "Return only public listing context: title, price, condition, seller/page context, and visible availability cues.",
    wantsAvailability ? "This is read-only context for a later local availability draft." : "This is read-only context for a later local draft.",
  ].join(" ");
}

function textExcerptFromResult(result: Record<string, unknown>): string | undefined {
  const direct = result.result as Record<string, unknown> | undefined;
  const candidates = [
    direct?.text_excerpt,
    direct?.markdown,
    direct?.content,
    (direct?.result as Record<string, unknown> | undefined)?.text_excerpt,
    result.text_excerpt,
    result.markdown,
    result.content,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim().slice(0, 2400);
  }
  return undefined;
}

function buildDraftOnlyEnvelope(
  originalIntent: string,
  url: string,
  sourceResult: Record<string, unknown>,
): Record<string, unknown> {
  const excerpt = textExcerptFromResult(sourceResult);
  return {
    status: "draft_only",
    safety: {
      side_effects: "none",
      sent: false,
      offer_made: false,
      purchase_made: false,
      approval_required_before_send: true,
    },
    intent: originalIntent,
    url,
    draft: "Hi, is this still available? I am interested and would like to know the condition, what is included, and whether the price is negotiable. Thanks.",
    source_excerpt: excerpt,
    source: sourceResult.source ?? (sourceResult.result as Record<string, unknown> | undefined)?.source ?? "read_only_lookup",
    trace: sourceResult.trace,
    impact: sourceResult.impact,
    next_action: {
      title: "Human approval required before any send/contact action",
      why: "This request asked for a draft only. Unbrowse did not open a composer, send a message, make an offer, or buy anything.",
    },
  };
}

export async function cmdRun(args: string[], flags: Record<string, string | boolean>, verb = "run"): Promise<void> {
  const parsed = parseCmdRunArgs(args, flags, verb);
  if ("error" in parsed) die(parsed.error);
  const { url, intent } = parsed;

  // Agent-native one-hole WRITE. A request body (or an explicit write --method)
  // means the agent wants to WRITE, not read. Route directly to the ad-hoc write
  // execute path instead of the read resolve+capture ladder — that ladder never
  // resolves a write to a read skill, so it burns the full discovery budget and
  // returns cli_timeout (38s). The HTTP verb is inferred from intent + body via
  // inferWriteMethod; the agent never picks a method. This makes the DEFAULT
  // one-hole surface (`unbrowse "<task>" --url`, `get`, `run`) do writes, not just
  // the explicit `execute` command.
  //
  // The body comes from --body, or — when the agent expressed the write purely in
  // natural language (`unbrowse "create a record by POSTing {json}" --url`) — from
  // a JSON object embedded in the intent. Embedded-body extraction only fires
  // alongside a write VERB, so a read intent without a write verb is never
  // mis-routed (the read axes keep their GET path).
  const oneHoleWriteBody: string | undefined = typeof flags.body === "string"
    ? flags.body
    : extractEmbeddedJsonBody(intent);
  const oneHoleWriteVerb = inferWriteMethod(
    typeof flags.method === "string" ? (flags.method as string) : undefined,
    intent,
    !!oneHoleWriteBody,
  );
  if (oneHoleWriteVerb && url && (!!oneHoleWriteBody || typeof flags.method === "string")) {
    return cmdExecute({
      ...flags,
      url,
      intent,
      method: oneHoleWriteVerb,
      ...(oneHoleWriteBody ? { body: oneHoleWriteBody } : {}),
    });
  }

  // Authenticated one-hole READ. When the agent supplied auth — an explicit
  // --header, or a bearer token / API key phrased in the intent ("authenticate
  // with bearer token <t> then read …") — do a DIRECT authenticated fetch instead
  // of the resolve+capture ladder. That ladder carries no Authorization header, so
  // the upstream returns 401 and the agent falls all the way to a browser capture
  // that times out (cli_timeout). The direct fetch is sub-second and returns the
  // authenticated body. Only fires when auth is actually present, so a plain read
  // keeps its richer resolve path.
  if (url) {
    const authHeader = typeof flags.header === "string" ? (flags.header as string) : extractAuthHeader(intent);
    if (authHeader) {
      return cmdFetch([], { ...flags, url, header: authHeader });
    }
  }

  const draftOnlyIntent = isDraftOnlyMutationIntent(intent);
  const resolveIntent = draftOnlyIntent ? draftOnlyReadIntent(intent) : intent;

  maybeShowContributionNotice();
  const hostType = detectTelemetryHostType();
  // Fire-and-forget: telemetry is a side-channel, never on the value path. Awaiting
  // these (postTelemetry has a 5s timeout) stalled `run` up to 3×5s when no backend
  // was reachable, before the resolve even started.
  void ensureCliInstallTracked(hostType).catch(() => {});
  void recordFunnelTelemetryEvent("cli_invoked", {
    source: "cli",
    hostType,
    properties: { command: verb },
  }).catch(() => {});
  void recordFunnelTelemetryEvent("resolve_started", {
    source: "cli",
    hostType,
    properties: {
      command: verb,
      intent,
      domain: telemetryDomainFromInput(undefined, url),
      url,
      has_url: true,
      auto_execute: true,
    },
  }).catch(() => {});

  const cliKv = (flags as Record<string, unknown>)._params as Record<string, string> | undefined;
  const extraParams = {
    ...(flags.params ? JSON.parse(flags.params as string) : {}),
    ...(cliKv && Object.keys(cliKv).length > 0 ? cliKv : {}),
  };
  const endpointFlag = flags["endpoint-id"] ?? flags.endpoint;
  const explicitEndpointId = typeof endpointFlag === "string" ? endpointFlag : undefined;
  const noExecute = flags["no-execute"] === true;
  const runPlan: Array<Record<string, unknown>> = [];

  function resolveBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {
      intent: resolveIntent,
      params: { url, ...extraParams },
      context: { url },
      projection: { raw: true },
    };
    if (explicitEndpointId) {
      body.params = { ...(body.params as Record<string, unknown>), endpoint_id: explicitEndpointId };
    }
    if (flags["dry-run"]) body.dry_run = true;
    if (flags["confirm-third-party-terms"]) body.confirm_third_party_terms = true;
    const budgetFlag = flags.budget;
    if (typeof budgetFlag === "string") {
      const parsed = parseInt(budgetFlag, 10);
      if (Number.isFinite(parsed) && parsed > 0) body.budget_ms = parsed;
    } else {
      body.budget_ms = 8_000;
    }
    return body;
  }

  function execBody(endpointId: string): Record<string, unknown> {
    return {
      params: { endpoint_id: endpointId, url, ...extraParams },
      intent: resolveIntent,
      projection: { raw: true },
      ...(flags["confirm-third-party-terms"] ? { confirm_third_party_terms: true } : {}),
    };
  }

  function resolveSkillIdFrom(result: Record<string, unknown>): string | undefined {
    return (result.skill as Record<string, unknown>)?.skill_id as string
      ?? result.skill_id as string
      ?? (result.result as Record<string, unknown> | undefined)?.skill_id as string;
  }

  function resolveAvailableEndpointsFrom(result: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
    return (Array.isArray(result.available_endpoints)
      ? result.available_endpoints
      : Array.isArray((result.result as Record<string, unknown> | undefined)?.available_endpoints)
        ? (result.result as Record<string, unknown>).available_endpoints
        : undefined) as Array<Record<string, unknown>> | undefined;
  }

  function endpointIsSafeToAutoExecute(endpoint: Record<string, unknown>): boolean {
    const method = String(endpoint.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return false;
    if (endpoint.needs_params && Object.keys(extraParams).length === 0) return false;
    return true;
  }

  // Synthetic page-artifact endpoint: capture pipeline emits these for
  // doc_only sites where the input URL itself is the data surface (SSR /
  // JSON-LD / Redux-rehydrated SPA). Re-fetching url_template via libcurl
  // typically fails on CF/anti-bot sites (the agent already saw the page
  // during capture). Detect these and SKIP auto-execute — the agent can
  // call execute explicitly if it wants the artifact replayed.
  // url_template === pageUrl AND (resource_kind in synthetic set OR
  // description matches the auto-generated "Captured X artifact for Y" form).
  function endpointIsSyntheticPageArtifact(
    endpoint: Record<string, unknown>,
    pageUrl: string,
  ): boolean {
    const tmpl = String(endpoint.url_template ?? endpoint.url ?? "").replace(/\/+$/, "");
    const norm = pageUrl.replace(/\/+$/, "");
    if (tmpl !== norm) return false;
    const rk = String(endpoint.resource_kind ?? "").toLowerCase();
    if (["message", "form", "resource", "page", "artifact"].includes(rk)) return true;
    const desc = String(endpoint.description ?? endpoint.description_out ?? "").toLowerCase();
    if (/captured (?:search )?(?:form|page) artifact/.test(desc)) return true;
    if (/^searches .* with /.test(desc) || /^returns .* details with /.test(desc)) return true;
    return false;
  }

  async function resolveStep(label: string): Promise<Record<string, unknown>> {
    runPlan.push({ step: "resolve", mode: "direct_or_cached", status: "started", label });
    const body = resolveBody();
    // See resolveOnce: floor at the live-capture ceiling so a cold capture isn't
    // abandoned with a false cli_timeout (#838); UNBROWSE_API_TIMEOUT_MS overrides.
    // computeResolveDeadlineMs is pure + unit-tested. Cap only; fast paths stay fast.
    const cliTimeoutMs = computeResolveDeadlineMs(typeof body.budget_ms === "number" ? body.budget_ms : undefined);
    let result = await withPendingNotice(
      api("POST", "/v1/intent/resolve", body, { timeoutMs: cliTimeoutMs }) as Promise<Record<string, unknown>>,
      "Still working. Searching cached routes...",
    );
    runPlan[runPlan.length - 1] = {
      ...runPlan[runPlan.length - 1],
      status: isResolveSuccessResult(result) ? "hit" : "miss",
      error: resolveResultError(result) ?? null,
      source: typeof result.source === "string" ? result.source : null,
    };

    const endpoints = resolveAvailableEndpointsFrom(result);
    const skillId = resolveSkillIdFrom(result);
    const endpointToExecute = explicitEndpointId ?? endpoints?.[0]?.endpoint_id;
    if (!noExecute && skillId && typeof endpointToExecute === "string") {
      const bestEndpoint = endpoints?.find((endpoint) => endpoint.endpoint_id === endpointToExecute) ?? endpoints?.[0];
      if (
        bestEndpoint?.requires_third_party_terms_confirmation === true &&
        !flags["confirm-third-party-terms"]
      ) {
        runPlan.push({
          step: "execute",
          mode: "direct_api",
          status: "skipped",
          reason: "requires_third_party_terms_confirmation",
          endpoint_id: endpointToExecute,
        });
        result.next_action = {
          title: "Confirm third-party terms",
          command: `unbrowse ${verb} "${url}" "${intent}" --confirm-third-party-terms`,
          why: "The best endpoint requires explicit confirmation before execution.",
        };
      } else if (
        !explicitEndpointId
        && bestEndpoint
        && endpointIsSyntheticPageArtifact(bestEndpoint, url)
      ) {
        // Don't re-fetch the page during auto-execute. The capture already
        // ran the browser against this URL; replay via libcurl frequently
        // fails on CF/anti-bot sites (ZlibError, HTTP 400 from HEAD probe).
        // Surface as available so the agent can call execute explicitly
        // if it wants the artifact replayed.
        runPlan.push({
          step: "execute",
          mode: "direct_api",
          status: "skipped",
          reason: "synthetic_page_artifact",
          endpoint_id: endpointToExecute,
        });
        result.next_action = {
          title: "Synthetic page artifact",
          command: `unbrowse execute --skill ${skillId} --endpoint ${endpointToExecute}`,
          why: "The captured endpoint is a synthetic page artifact; the SSR/JSON-LD payload was already extracted during capture. Re-fetching is optional.",
        };
      } else if (explicitEndpointId || !bestEndpoint || endpointIsSafeToAutoExecute(bestEndpoint)) {
        runPlan.push({ step: "execute", mode: "direct_api", status: "started", endpoint_id: endpointToExecute });
        const resolvedSource = typeof result.source === "string" ? result.source : undefined;
        const deferralResult = result; // the resolve shortlist, before execute overwrites it
        const executed = await withPendingNotice(
          api("POST", `/v1/skills/${skillId}/execute`, execBody(endpointToExecute)) as Promise<Record<string, unknown>>,
          "Executing best endpoint...",
        );
        // Cardinality guard (Ezekiel 47:10): a list/search intent must not accept a
        // single-item execution result. An endpoint URL can look like a listing
        // (carousell.sg/food/q/) while its dom_extraction harvests only the lazy
        // page-level schema.org Product. Don't return one fish for a net — keep the
        // honest route shortlist so the agent escalates, never a fabricated single item.
        if (
          !explicitEndpointId &&
          isResolveSuccessResult(executed) &&
          !resolutionCardinalityMatches(intent, (executed as Record<string, unknown>).result ?? (executed as Record<string, unknown>).data)
        ) {
          runPlan[runPlan.length - 1] = {
            ...runPlan[runPlan.length - 1],
            status: "skipped",
            reason: "cardinality_mismatch_single_item",
          };
          deferralResult.next_action = {
            title: "List intent returned a single item",
            command: `unbrowse execute --skill ${skillId} --endpoint ${endpointToExecute}`,
            why: "Auto-execute yielded a single item for a list/search intent; the page's listings are likely JS-rendered behind an internal API. Returning the route shortlist instead of one item.",
          };
          result = deferralResult;
        } else {
          result = executed;
          if (resolvedSource && typeof result.source !== "string") result.source = resolvedSource;
          runPlan[runPlan.length - 1] = {
            ...runPlan[runPlan.length - 1],
            status: isResolveSuccessResult(result) ? "complete" : "error",
            error: resolveResultError(result) ?? null,
          };
        }
      } else {
        runPlan.push({
          step: "execute",
          mode: "direct_api",
          status: "skipped",
          reason: "endpoint_not_safe_or_missing_params",
          endpoint_id: endpointToExecute,
        });
        result.next_action = {
          title: "Execute selected endpoint",
          command: `unbrowse execute --skill ${skillId} --endpoint ${endpointToExecute}`,
          why: "Run found a candidate but did not auto-execute because it is not a safe ready GET.",
        };
      }
    }
    return result;
  }

  function decorate(result: Record<string, unknown>): Record<string, unknown> {
    return {
      ...result,
      ...slimTrace(result),
      run_plan: runPlan,
    };
  }

  function endpointsDiscovered(result: Record<string, unknown>): number {
    if (typeof result.endpoints_discovered === "number") return result.endpoints_discovered;
    if (Array.isArray(result.endpoints)) return result.endpoints.length;
    if (Array.isArray(result.available_endpoints)) return result.available_endpoints.length;
    return 0;
  }

  // SSR markers — fields that prove a doc_only capture's HTML embeds
  // structured data (page renders client-side without XHR). When these
  // are present, the synthetic page-artifact is a real surface — let
  // resolve see it instead of treating capture as "thin".
  const SSR_MARKERS = new Set([
    "@context", "@type", "potentialAction", "mainEntity", "@graph",
    "__NEXT_DATA__", "pageProps",
    "__NUXT__", "__INITIAL_STATE__", "__PRELOADED_STATE__",
    "initialReduxState", "initialState",
  ]);

  function captureHasSsrData(result: Record<string, unknown>): boolean {
    const note = (result.note_evidence as Record<string, unknown> | undefined) ?? {};
    const fields = note.sample_field_names;
    if (!Array.isArray(fields)) return false;
    return fields.some((f) => {
      if (typeof f !== "string") return false;
      if (SSR_MARKERS.has(f)) return true;
      // Generic JSON-LD: any field name ending in JsonLD / JsonLd / jsonld
      return /[Jj]son[-_]?[Ll][Dd]$/.test(f);
    });
  }

  function captureLooksThin(result: Record<string, unknown>): boolean {
    if (result.auth_recommended === true) return true;
    if (endpointsDiscovered(result) === 0) return true;
    if (result.capture_pattern === "doc_only") {
      // doc_only with embedded SSR / JSON-LD data is NOT thin — the
      // synthetic page-artifact endpoint is a real PASS_DOM_FALLBACK_ONLY
      // surface. Let resolve.after_index pick it up.
      return !captureHasSsrData(result);
    }
    return false;
  }

  function shouldIndexFallback(result: Record<string, unknown>): boolean {
    const error = resolveResultError(result);
    const status = (result.result as Record<string, unknown> | undefined)?.status as string | undefined
      ?? result.status as string | undefined;
    if (error === "auth_required" || status === "auth_required") return false;
    // A direct route/payment envelope is user-visible policy and must not be
    // bypassed by capture. Marketplace-search 402 without payment details may
    // still fall through to capture+index like a cache miss.
    if ((error === "payment_required" || status === "payment_required") && result.payment) {
      return false;
    }
    if (error) return ["no_match", "no_cached_match", "not_found", "payment_required"].includes(error);
    if (status) return ["no_match", "no_cached_match", "not_found", "payment_required"].includes(status);
    return !isResolveSuccessResult(result);
  }

  try {
    let result = await resolveStep("initial");
    if (draftOnlyIntent) {
      if (isResolveSuccessResult(result)) {
        runPlan.push({
          step: "execute",
          mode: "draft_only_guard",
          status: "skipped",
          reason: "no_side_effects_without_approval",
        });
        output(decorate(buildDraftOnlyEnvelope(intent, url, result)), !!flags.pretty);
        return;
      }
      const err = resolveResultError(result);
      output(decorate({
        ...result,
        status: err === "auth_required" ? "auth_required" : "draft_unavailable",
        original_intent: intent,
        safety: {
          side_effects: "none",
          sent: false,
          offer_made: false,
          purchase_made: false,
          approval_required_before_send: true,
        },
        next_action: err === "auth_required"
          ? {
              title: "Authenticate site before drafting",
              command: `unbrowse auth "${resolveLoginUrl(result, url) ?? url}"`,
              why: "The site requires a local authenticated session before Unbrowse can read enough context to draft safely.",
            }
          : {
              title: "Draft unavailable",
              why: "Unbrowse could not read enough page context to draft a message, and it did not attempt to send/contact/buy.",
            },
      }), !!flags.pretty);
      return;
    }
    const firstError = resolveResultError(result);
    if (firstError === "auth_required") {
      const loginUrl = resolveLoginUrl(result, url);
      output(decorate({
        ...result,
        next_action: {
          title: "Authenticate site",
          command: `unbrowse auth "${loginUrl}"`,
          why: "The site needs an interactive login before Unbrowse can call or index private routes.",
        },
      }), !!flags.pretty);
      return;
    }
    if (isResolveSuccessResult(result)) {
      output(decorate(result), !!flags.pretty);
      return;
    }
    if (!shouldIndexFallback(result)) {
      output(decorate(result), !!flags.pretty);
      return;
    }

    if (flags["no-index"]) {
      output(decorate({
        ...result,
        next_action: {
          title: "Index this page",
          command: `unbrowse ${verb} "${url}" "${intent}"`,
          why: "--no-index stopped the automatic capture/index fallback.",
        },
      }), !!flags.pretty);
      return;
    }

    runPlan.push({ step: "index", mode: "capture", status: "started" });
    const capture = await withPendingNotice(
      api("POST", "/v1/capture", { url, intent }) as Promise<Record<string, unknown>>,
      "No trusted route yet. Capturing and indexing the page...",
    );
    runPlan[runPlan.length - 1] = {
      ...runPlan[runPlan.length - 1],
      status: capture.error ? "error" : "complete",
      endpoints_discovered: endpointsDiscovered(capture),
      auth_recommended: capture.auth_recommended === true,
      capture_pattern: capture.capture_pattern ?? null,
    };

    if (!captureLooksThin(capture)) {
      result = await resolveStep("after_index");
      if (isResolveSuccessResult(result)) {
        output(decorate(result), !!flags.pretty);
        return;
      }
      if (resolveResultError(result) === "auth_required") {
        const loginUrl = resolveLoginUrl(result, url);
        output(decorate({
          ...result,
          next_action: {
            title: "Authenticate site",
            command: `unbrowse auth "${loginUrl}"`,
            why: "The newly indexed route needs a site session before execution.",
          },
        }), !!flags.pretty);
        return;
      }
      if (!shouldIndexFallback(result)) {
        output(decorate(result), !!flags.pretty);
        return;
      }
    }

    if (flags["no-browse"]) {
      output(decorate({
        status: "needs_browser",
        capture,
        resolve_result: result,
        next_action: {
          title: "Browse interactively",
          command: `unbrowse go "${url}"`,
          why: "--no-browse stopped the automatic live-browser fallback.",
        },
      }), !!flags.pretty);
      return;
    }

    runPlan.push({ step: "browse", mode: "kuri_session", status: "started" });
    const browse = await withPendingNotice(
      api("POST", "/v1/browse/go", { url }) as Promise<Record<string, unknown>>,
      "Opening a browser session because direct/indexed routes were not enough...",
    );
    runPlan[runPlan.length - 1] = {
      ...runPlan[runPlan.length - 1],
      status: browse.error ? "error" : "opened",
      session_id: browse.session_id ?? null,
      auth_required: browse.auth_required === true,
    };

    // When the browse path lands directly on a content-bearing surface (e.g.
    // a plain JSON API where api.coingecko.com returns `{"bitcoin":{"usd":...}}`
    // as the rendered "page.text", or a server-rendered HTML page), the bench
    // and downstream callers should see this as a real success — not a
    // "needs more interaction" envelope. Without this, probes that hit
    // payment_required → capture → browse (with the 402-fallthrough fix from
    // contract b3b148b7) get useful data in `browse.page.text` but still
    // surface as `status: "browse_required"` and the manifest classifier
    // records them as empty-source FAIL. Treat browse-direct as a first-class
    // source when the page text is non-trivial AND no interactive auth is
    // required.
    const browsePage = (browse.page as Record<string, unknown> | undefined) ?? {};
    const browsePageText = typeof browsePage.text === "string" ? browsePage.text : "";
    const browseAuthRequired = browse.auth_required === true;
    const browseErrored = browse.error === true || typeof browse.error === "string";
    const looksLikeRealContent =
      !browseErrored &&
      !browseAuthRequired &&
      browsePageText.length >= 200 &&
      !/please (wait|verify|enable|complete)|access denied|just a moment|attention required|cf-chl|datadome|captcha/i.test(browsePageText.slice(0, 2048));

    if (looksLikeRealContent) {
      output(decorate({
        status: "ok",
        source: "browse-direct",
        url,
        intent,
        capture,
        resolve_result: result,
        browse,
        // Hoist the page text + structured_data to the top-level result
        // shape so callers (and bench manifest classifiers) can read it
        // without diving into browse.page.
        result: {
          status: "ok",
          source: "browse-direct",
          page_text: browsePageText,
          structured_data: browsePage.structured_data ?? null,
          final_url: typeof browse.url === "string" ? browse.url : url,
        },
        trace: {
          trace_id: typeof browse.session_id === "string" ? browse.session_id : undefined,
          skill_id: "browse-direct",
          endpoint_id: "browse-direct",
          success: true,
          status_code: 200,
        },
      }), !!flags.pretty);
      return;
    }

    output(decorate({
      status: "browse_required",
      capture,
      resolve_result: result,
      browse,
      next_action: {
        title: "Continue in browser",
        command: browse.session_id
          ? `unbrowse snap --session ${browse.session_id} --filter interactive`
          : "unbrowse snap --filter interactive",
        why: "The task needs page interaction before Unbrowse can finish or learn the reusable route.",
      },
    }), !!flags.pretty);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void recordFunnelTelemetryEvent("resolve_failed", {
      source: "cli",
      hostType,
      properties: {
        command: verb,
        intent,
        domain: telemetryDomainFromInput(undefined, url),
        url,
        failure_stage: verb,
        failure_reason: message,
      },
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Post-processing helpers for --path, --extract, --limit, --schema
// ---------------------------------------------------------------------------

/** Drill into a value using a dot-path like "data.items[].name".
 *  `[]` flattens arrays at that level so nested arrays become flat collections. */
function drillPath(data: unknown, path: string): unknown {
  const segments = path.split(/\./).flatMap((s) => {
    // "items[]" → ["items", "[]"]
    const m = s.match(/^(.+)\[\]$/);
    return m ? [m[1], "[]"] : [s];
  });
  // Work with an array of "current values" to handle multi-level flattening
  let values: unknown[] = [data];
  for (const seg of segments) {
    if (values.length === 0) return [];
    if (seg === "[]") {
      // Flatten: each value that is an array gets its elements spread out
      values = values.flatMap((v) => (Array.isArray(v) ? v : [v]));
      continue;
    }
    // Drill into each value
    values = values.flatMap((v) => {
      if (v == null) return [];
      if (Array.isArray(v)) {
        // Auto-flatten arrays even without explicit []
        return v.map((item) => (item as Record<string, unknown>)?.[seg]).filter((x) => x !== undefined);
      }
      if (typeof v === "object") {
        const val = (v as Record<string, unknown>)[seg];
        return val !== undefined ? [val] : [];
      }
      return [];
    });
  }
  return values;
}

/** Resolve a dot-path on a single object, e.g. "core.user_results.result.core.screen_name" */
function resolveDotPath(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Apply --extract field spec: "alias:deep.path,field2,alias2:path" */
function applyExtract(items: unknown[], extractSpec: string): unknown[] {
  const fields = extractSpec.split(",").map((f) => {
    const colon = f.indexOf(":");
    if (colon > 0) return { alias: f.slice(0, colon), path: f.slice(colon + 1) };
    return { alias: f, path: f };
  });
  return items
    .map((item) => {
      const row: Record<string, unknown> = {};
      let hasValue = false;
      for (const { alias, path } of fields) {
        const val = resolveDotPath(item, path);
        row[alias] = val ?? null;
        if (val != null) hasValue = true;
      }
      return hasValue ? row : null;
    })
    .filter((row): row is Record<string, unknown> => row !== null);
}

/** Build a compact schema tree from a value (depth-limited). */
function schemaOf(value: unknown, depth = 4): unknown {
  if (value == null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return ["unknown"];
    return [schemaOf(value[0], depth - 1)];
  }
  if (typeof value === "object") {
    if (depth <= 0) return "object";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = schemaOf(v, depth - 1);
    }
    return out;
  }
  return typeof value;
}

// Skill IDs emitted by resolve that are synthesized in-orchestrator and never
// persisted to the marketplace. `execute --skill <id>` against these returns
// "Skill not found" from the backend, which is a confusing UX — the resolve
// response carries the correct `next_step` (e.g. `unbrowse fetch --url ...`)
// but agents naturally try `execute --skill X` first. Guard early and point
// them at the right command. Emission site: src/orchestrator/index.ts ~L3879.
const SYNTHETIC_SKILL_IDS = new Set<string>(["exa-web-search"]);

async function cmdExecute(flags: Record<string, string | boolean>): Promise<void> {
  // Agent-native writes: the agent expresses INTENT, not an HTTP verb. The method
  // is inferred from intent + body presence (a body ⇒ a write). `--method` stays as
  // an explicit override but is no longer required — fewer knobs for the agent.
  const explicitMethod =
    typeof flags.method === "string" ? (flags.method as string).toUpperCase() : undefined;
  const intentText = typeof (flags.intent ?? flags.task) === "string" ? String(flags.intent ?? flags.task) : "";
  const hasBody = !!flags.body || (typeof flags.params === "string" && /["']body["']\s*:/.test(flags.params as string));
  const effectiveMethod = inferWriteMethod(explicitMethod, intentText, hasBody);
  const writeMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(effectiveMethod ?? "");
  // expose the resolved method to the rest of the handler (used to forward to the API).
  if (writeMethod) flags.method = effectiveMethod as string;
  let skillId = (flags.skill ?? flags["skill-id"]) as string;
  if (!skillId && typeof flags.url === "string" && writeMethod) {
    // Collision-resistant id: a sha256 of (method+url), NOT a truncated base64 of
    // the url. A 24-char base64 prefix is identical for every same-host path
    // (e.g. all postman-echo.com/* routes), so distinct write targets clobbered
    // the same skill-cache file. A method+url hash gives each write its own route.
    const idHash = createHash("sha256")
      .update(`${effectiveMethod} ${String(flags.url)}`)
      .digest("hex")
      .slice(0, 40);
    skillId = `adhoc-write-${idHash}`;
  }
  if (!skillId) die("--skill is required. List skills: unbrowse skills. Or run unbrowse resolve --intent '...' first to get a skill_id.");
  if (SYNTHETIC_SKILL_IDS.has(skillId)) {
    die(
      `'${skillId}' is a synthetic skill from a fallback path — it is not persisted and cannot be executed directly. ` +
        `Re-run resolve and follow next_step.fetch / next_step.capture_current: ` +
        `unbrowse resolve --intent '<your intent>' --raw  (the response carries suggested_commands and exa_candidates URLs you can pass to \`unbrowse fetch --url <url>\`).`,
    );
  }
  const endpointId = (flags.endpoint ?? flags["endpoint-id"]) as string | undefined;
  maybeShowContributionNotice();
  const hostType = detectTelemetryHostType();
  // Fire-and-forget (see cmdRun): telemetry must not block execute by up to 3×5s.
  void ensureCliInstallTracked(hostType).catch(() => {});
  void recordFunnelTelemetryEvent("cli_invoked", {
    source: "cli",
    hostType,
    properties: { command: "execute" },
  }).catch(() => {});
  void recordFunnelTelemetryEvent("resolve_started", {
    source: "cli",
    hostType,
    properties: {
      command: "execute",
      intent: typeof (flags.intent ?? flags.task) === "string" ? flags.intent ?? flags.task : null,
      domain: telemetryDomainFromInput(undefined, flags.url as string | undefined),
      url: typeof flags.url === "string" ? flags.url : null,
      skill_id: skillId,
      endpoint_id: endpointId ?? null,
    },
  }).catch(() => {});

  if (flags.curl) {
    die("--curl has been removed. Use `unbrowse execute` to run endpoints through Unbrowse.");
    return;
  }

  try {
    const body: Record<string, unknown> = { params: {} };
    if (endpointId) {
      (body.params as Record<string, unknown>).endpoint_id = endpointId;
    }
    if (flags.params) {
      body.params = { ...(body.params as Record<string, unknown>), ...JSON.parse(flags.params as string) };
    }
    // --body '{json}' — the agent-driven write payload. Nests under params.body so
    // the ad-hoc write path (and pointer-field censoring) sees it as the request body.
    if (flags.body) {
      try {
        (body.params as Record<string, unknown>).body = JSON.parse(flags.body as string);
      } catch {
        (body.params as Record<string, unknown>).body = flags.body;
      }
    }
    // Merge -p key=val flags (parsed in parseArgs, stashed on flags._params).
    const cliKv = (flags as Record<string, unknown>)._params as Record<string, string> | undefined;
    if (cliKv && Object.keys(cliKv).length > 0) {
      body.params = { ...(body.params as Record<string, unknown>), ...cliKv };
    }
    if (flags.url) {
      body.context_url = flags.url;
      (body.params as Record<string, unknown>).url = flags.url;
    }
    // --method forwards the HTTP verb so the API can run an ad-hoc agent-driven
    // write (POST/PUT/PATCH/DELETE) when the agent knows the target but no
    // marketplace skill exists. Without this the verb never reaches the server.
    if (typeof flags.method === "string") body.method = (flags.method as string).toUpperCase();
    // --session scopes the disk-backed yield store: a write in one CLI invocation
    // persists its yields to disk under this id; a later invocation with the same
    // --session inherits them and auto-fills matching holes (cross-process state).
    if (typeof flags.session === "string") body.session_id = flags.session;
    // --header forwards a caller-supplied request header (e.g. "Authorization: Bearer …")
    // so an authenticated WRITE carries the credential to the target — the read/fetch path
    // already honored --header; this closes the gap where a write reached the target with
    // its body but no auth header. Multiple --header flags are accepted.
    {
      const rawHeaders = Array.isArray(flags.header)
        ? (flags.header as unknown as string[])
        : (typeof flags.header === "string" ? [flags.header as string] : []);
      const authHeaders: Record<string, string> = {};
      for (const h of rawHeaders) {
        const idx = h.indexOf(":");
        if (idx > 0) authHeaders[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
      }
      if (Object.keys(authHeaders).length > 0) body.auth_headers = authHeaders;
    }
    if (flags.intent ?? flags.task) body.intent = flags.intent ?? flags.task;
    if (flags["dry-run"]) body.dry_run = true;
    if (flags["confirm-unsafe"]) body.confirm_unsafe = true;
    if (flags["confirm-third-party-terms"]) body.confirm_third_party_terms = true;
    body.projection = { raw: true };

    let result = await withPendingNotice(
      api("POST", `/v1/skills/${skillId}/execute`, body) as Promise<Record<string, unknown>>,
      "Still working. This endpoint may require browser replay or first-time auth/capture setup.",
    );

    if (
      result?.error === "Skill not found"
      && typeof flags.url === "string"
      && typeof (flags.intent ?? flags.task) === "string"
    ) {
      const fallbackBody: Record<string, unknown> = {
        intent: flags.intent ?? flags.task,
        params: {
          ...(body.params as Record<string, unknown>),
          url: flags.url,
        },
        context: { url: flags.url },
        projection: { raw: true },
      };
      result = await withPendingNotice(
        api("POST", "/v1/intent/resolve", fallbackBody) as Promise<Record<string, unknown>>,
        "Still working. Re-resolving this marketplace skill against the supplied URL context.",
      );
    }

    if (isResolveSuccessResult(result)) {
      // Fire-and-forget: this ran BEFORE output() — awaiting it delayed printing the
      // ready result by up to 5s. The result must print first.
      void recordFunnelTelemetryEvent("resolve_completed", {
        source: "cli",
        hostType,
        properties: {
          command: "execute",
          intent: typeof (flags.intent ?? flags.task) === "string" ? flags.intent ?? flags.task : null,
          domain: telemetryDomainFromInput(undefined, flags.url as string | undefined),
          url: typeof flags.url === "string" ? flags.url : null,
          skill_id: skillId,
          endpoint_id: endpointId ?? null,
        },
      }).catch(() => {});
    }

    // Strip metadata bloat
    result = slimTrace(result);
    emitImpactSummary(result);
    {
      const entry = impactFromResult("execute", result, {
        skill_id: skillId,
        endpoint_id: endpointId,
      });
      if (entry) appendImpact(entry);
    }
    emitNextActionSummary(result);

    const pathFlag = flags.path as string | undefined;
    const extractFlag = flags.extract as string | undefined;
    const limitFlag = flags.limit ? Number(flags.limit) : undefined;
    const schemaFlag = !!flags.schema;
    const rawFlag = !!flags.raw;
    const summarizeFlag = !!flags.summarize;
    const resultError = resolveResultError(result);
    // --schema: show response structure without data
    if (schemaFlag && !rawFlag) {
      const data = result.result;
      output({
        trace: result.trace,
        schema: schemaOf(data),
        ...(result.impact ? { impact: result.impact } : {}),
        ...(result.next_actions ? { next_actions: result.next_actions } : {}),
      }, !!flags.pretty);
      return;
    }

    // Apply --path, --extract, --limit when not --raw
    if (!rawFlag && !resultError && (pathFlag || extractFlag || limitFlag)) {
      const data = pathFlag ? drillPath(result.result, pathFlag) : result.result;

      // Ensure array for extract/limit
      const items = Array.isArray(data) ? data : data != null ? [data] : [];

      // Apply --extract
      const extracted = extractFlag ? applyExtract(items, extractFlag) : items;

      // Apply --limit
      const limited = limitFlag ? extracted.slice(0, limitFlag) : extracted;

      const trace = result.trace as Record<string, unknown> | undefined;
      const out: Record<string, unknown> = {
        trace: result.trace,
        data: limited,
        count: limited.length,
        ...(result.impact ? { impact: result.impact } : {}),
        ...(result.next_actions ? { next_actions: result.next_actions } : {}),
      };

      // Prompt agent to review when this is likely a first-time execute
      if (trace?.skill_id && trace?.endpoint_id && limited.length > 0) {
        out._review_hint =
          `After presenting results, review this endpoint's contract: description plus request/response schema notes where needed. Example: unbrowse review --skill ${trace.skill_id} --endpoints '[{"endpoint_id":"${trace.endpoint_id}","description":"DESCRIBE WHAT THIS RETURNS AND ANY IMPORTANT CONSTRAINTS","action_kind":"ACTION","resource_kind":"RESOURCE","parameter_reviews":[{"location":"query","name":"q","description":"Search query text","type":"string","required":true}],"response_reviews":[{"path":"items[].url","description":"Canonical result URL","type":"string"}]}]'`;
      }

      output(out, !!flags.pretty);
      return;
    }

    // Default returns the full body. Pass --summarize to fold large responses
    // into an extraction_hints envelope (schema_tree + size). Per CLAUDE.md
    // Agent UX North Star "Works for what was asked: --raw is the default
    // truth" — agents calling execute expect data, not a schema preview.
    // Walmart's 930KB search result was hidden by the prior auto-truncation
    // even though `success:true` and the body was on the wire; opt-in via
    // --summarize keeps the convenience for interactive use without burying
    // automated callers.
    const AUTOEXTRACT_HINT_THRESHOLD = 65_536;
    if (summarizeFlag && !pathFlag && !extractFlag && !schemaFlag) {
      const raw = JSON.stringify(result.result);
      if (raw && raw.length > AUTOEXTRACT_HINT_THRESHOLD) {
        const schema = schemaOf(result.result);
        output({
          trace: result.trace,
          ...(result.impact ? { impact: result.impact } : {}),
          ...(result.next_actions ? { next_actions: result.next_actions } : {}),
          extraction_hints: {
            message: `Response is ${Math.round(raw.length / 1024)}KB (over ${AUTOEXTRACT_HINT_THRESHOLD / 1024}KB). Use --path/--extract/--limit to filter, --schema for structure, or --raw for full response.`,
            schema_tree: schema,
            response_bytes: raw.length,
          },
        }, !!flags.pretty);
        return;
      }
    }

    output(result, !!flags.pretty);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void recordFunnelTelemetryEvent("resolve_failed", {
      source: "cli",
      hostType,
      properties: {
        command: "execute",
        intent: typeof (flags.intent ?? flags.task) === "string" ? flags.intent ?? flags.task : null,
        domain: telemetryDomainFromInput(undefined, flags.url as string | undefined),
        url: typeof flags.url === "string" ? flags.url : null,
        skill_id: skillId,
        failure_stage: "execute",
        failure_reason: message,
      },
    });
    throw error;
  }
}

export async function cmdAnnotate(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  const endpointId = flags.endpoint as string;
  if (!skillId || !endpointId) die("--skill and --endpoint are required");

  const body: Record<string, unknown> = {};

  if (flags.text) {
    body.annotations = [{ text: flags.text as string }];
  }

  if (flags.constraint) {
    const parts = (flags.constraint as string).split(":");
    if (parts.length >= 3) {
      body.constraints = [{ param: parts[0], rule: parts[1], message: parts.slice(2).join(":") }];
    }
  }

  if (!body.annotations && !body.constraints) die("--text or --constraint required");

  output(await api("POST", `/v1/skills/${skillId}/endpoints/${endpointId}/annotate`, body), !!flags.pretty);
}
export async function cmdReview(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  if (!skillId) die("--skill is required");
  const endpointsJson = flags.endpoints as string;
  if (!endpointsJson) die("--endpoints is required (JSON array of {endpoint_id, description?, action_kind?, resource_kind?, parameter_reviews?, response_reviews?})");
  const endpoints = JSON.parse(endpointsJson) as Array<Record<string, unknown>>;
  if (!Array.isArray(endpoints) || endpoints.length === 0) die("--endpoints must be a non-empty JSON array");
  output(await api("POST", `/v1/skills/${skillId}/review`, { endpoints }), !!flags.pretty);
}

export async function cmdIndex(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  if (!skillId) die("--skill is required");
  output(await api("POST", `/v1/skills/${skillId}/index`, {}), !!flags.pretty);
}

export async function cmdPublish(flags: Record<string, string | boolean>): Promise<void> {
  const skillId = flags.skill as string;
  if (!skillId) die("--skill is required");
  const endpointsJson = flags.endpoints as string | undefined;
  const confirmPublish = flags["confirm-publish"] === true;
  if (endpointsJson) {
    // Phase 2: merge descriptions + publish
    const endpoints = JSON.parse(endpointsJson) as Array<Record<string, unknown>>;
    if (!Array.isArray(endpoints) || endpoints.length === 0) die("--endpoints must be a non-empty JSON array");
    output(await api("POST", `/v1/skills/${skillId}/publish`, {
      endpoints,
      ...(confirmPublish ? { confirm_publish: true } : {}),
    }), !!flags.pretty);
  } else {
    // Phase 1: return endpoints needing descriptions
    output(await api("POST", `/v1/skills/${skillId}/publish`, {
      ...(confirmPublish ? { confirm_publish: true } : {}),
    }), !!flags.pretty);
  }
}

export async function cmdPublishBundle(flags: Record<string, string | boolean>): Promise<void> {
  const presetPath = flags.preset as string;
  if (!presetPath) die("--preset is required");
  const hosts = typeof flags.hosts === "string"
    ? flags.hosts.split(",").map((host) => host.trim()).filter(Boolean)
    : undefined;
  output(await api("POST", "/v1/foundry/publish-bundle", {
    preset_path: presetPath,
    ...(typeof flags["site-url"] === "string" ? { site_url: flags["site-url"] } : {}),
    ...(hosts?.length ? { hosts } : {}),
  }), !!flags.pretty);
}

export async function cmdConfig(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const [action, key, value] = args.map((arg) => arg.trim().toLowerCase());
  if (action === "get" && key === "telemetry") {
    const contribution = getContributionConfig();
    const settings = getCapturePipelineSettings();
    output({
      telemetry: contribution.contribution.share_pointers || settings.auto_publish_checkpoints,
      share_pointers: contribution.contribution.share_pointers,
      auto_publish_checkpoints: settings.auto_publish_checkpoints,
    }, !!flags.pretty);
    return;
  }

  if (action === "set" && key === "telemetry") {
    if (["false", "off", "0", "no"].includes(value)) {
      setContributionConfig({
        contribution: { share_pointers: false, set_via: "mode-command" },
        notice_shown_count: 0,
      });
      updateCapturePipelineSettings({ auto_publish_checkpoints: false });
      output({
        ok: true,
        telemetry: false,
        share_pointers: false,
        auto_publish_checkpoints: false,
        message: "Remote pointer sharing and checkpoint auto-publish are disabled.",
      }, !!flags.pretty);
      return;
    }
    if (["true", "on", "1", "yes"].includes(value)) {
      die("Use `unbrowse mode` to opt into sharing so the privacy prompt is explicit.");
    }
  }

  die("usage: unbrowse config get telemetry | unbrowse config set telemetry false");
}

export async function cmdLogin(flags: Record<string, string | boolean>, args: string[] = []): Promise<void> {
  const url = (flags.url as string | undefined) ?? args[0];
  if (!url) die("usage: unbrowse auth <url>");
  info("[unbrowse] Opening a visible browser for site login. Complete sign-in in the Chrome window; cookies will be saved for future runs.");
  output(await api("POST", "/v1/auth/login", { url, interactive_only: true }), !!flags.pretty);
}

// Emit a publishable per-website skill package (agentskills.io format): a
// directory with SKILL.md (origin pointer + ZK credential holes + x402 reward,
// rendered from the captured manifest) and a README, ready to push to
// `unbrowse-ai/<domain>` and install with `npx skills add unbrowse-ai/<domain>`.
export async function cmdSkillPackage(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const id = args[0] ?? (flags.skill as string) ?? (flags.id as string);
  if (!id) die("skill-package <skill-id> [--out <dir>] — skill id required");
  const skill = await api("GET", `/v1/skills/${id}`) as Record<string, unknown>;
  if (!skill || skill.error) die(`skill not found: ${id}`);
  const { renderSkillMd, validateSkillPackage, forbiddenPublicTerms } = await import("./skillmd.js");
  const { sanitizeDomain } = await import("./extraction/domain-notes.js");
  const fs = require("node:fs");
  const path = require("node:path");
  const domain = sanitizeDomain(String(skill.domain ?? id));
  const outDir = (flags.out as string) || path.join(process.cwd(), `unbrowse-ai-${domain}`);
  // Skills are NOT exposed by default — exposure (publishing a standalone
  // `npx skills add` repo) is an explicit owner act. `--expose` opts in.
  if (flags.expose) (skill as Record<string, unknown>).exposed = true;
  const md = renderSkillMd(skill as unknown as Parameters<typeof renderSkillMd>[0]);
  // Publish gate: never write a malformed OR leaky package to unbrowse-ai/<domain>.
  const valid = validateSkillPackage(md);
  if (!valid.ok) die(`invalid skill package for ${domain}: ${valid.issues.join("; ")}`);
  const readme = `# unbrowse-ai/${domain}\n\nInstallable agent skill for **${domain}**, indexed and described by unbrowse.\n\n\`\`\`bash\nnpx skills add unbrowse-ai/${domain}\n\`\`\`\n\nCredentials are never embedded — they are placeholders filled at call time from your own local keychain, and never leave your machine. Executions reward the publisher via x402.\n`;
  const readmeLeaks = forbiddenPublicTerms(readme);
  if (readmeLeaks.length) die(`invalid README for ${domain}: forbidden public term(s) ${readmeLeaks.map((t) => `/${t}/`).join(", ")}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "SKILL.md"), md);
  fs.writeFileSync(path.join(outDir, "README.md"), readme);
  output({ ok: true, domain, out: outDir, files: ["SKILL.md", "README.md"], install: `npx skills add unbrowse-ai/${domain}` }, !!flags.pretty);
}

export async function cmdCleanupStale(flags: Record<string, string | boolean>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (typeof flags.skill === "string") body.skill_id = flags.skill;
  if (typeof flags.domain === "string") body.domain = flags.domain;
  if (typeof flags.limit === "string") body.limit = Number(flags.limit);
  output(
    await withPendingNotice(api("POST", "/v1/stale/cleanup", body), "Cleaning stale endpoints..."),
    !!flags.pretty,
  );
}

export async function cmdSearch(flags: Record<string, string | boolean>): Promise<void> {
  // The `search` command emits funnel telemetry (search_started /
  // search_completed) so the agent acquisition story stays measurable.
  // cmdResolve also fires resolve_* under the hood — both events are recorded.
  const intent = flags.intent as string | undefined;
  const hostType = detectTelemetryHostType();
  const { decodeTelemetryAttribution } = await import("./telemetry-attribution.js");
  const attr = decodeTelemetryAttribution(process.env.UNBROWSE_ATTRIBUTION_B64) ?? {};
  const attrProps: Record<string, unknown> = {};
  for (const k of ["channel", "campaign_id", "content_id", "variant_id"] as const) {
    const v = (attr as Record<string, unknown>)[k];
    if (v != null) attrProps[k] = v;
  }
  const domain = telemetryDomainFromInput(flags.domain as string | undefined, flags.url as string | undefined);
  if (intent) {
    // Fire-and-forget: telemetry must NEVER block the search result. Awaiting it
    // stalled warm cache-hit searches by up to 2×5s (postTelemetry's timeout)
    // when no backend was reachable. Best-effort, errors swallowed.
    void recordFunnelTelemetryEvent("search_started", {
      source: "cli",
      hostType,
      properties: {
        command: "search",
        intent,
        domain,
        url: typeof flags.url === "string" ? flags.url : null,
        ...attrProps,
      },
    }).catch(() => {});
  }
  let resultCount = 0;
  try {
    if (intent && domain) {
      try {
        const searchRes = await api(
          "GET",
          `/v1/search/domain?intent=${encodeURIComponent(intent)}&domain=${encodeURIComponent(domain)}`,
        ) as { results?: unknown[] };
        resultCount = Array.isArray(searchRes?.results) ? searchRes.results.length : 0;
      } catch { /* search/domain optional — fall through to resolve */ }
    }
    await cmdResolve(flags);
    if (intent) {
      void recordFunnelTelemetryEvent("search_completed", {
        source: "cli",
        hostType,
        properties: {
          command: "search",
          intent,
          domain,
          result_count: resultCount,
          ...attrProps,
        },
      }).catch(() => {});
    }
  } catch (err) {
    if (intent) {
      void recordFunnelTelemetryEvent("search_failed", {
        source: "cli",
        hostType,
        properties: {
          command: "search",
          intent,
          error: err instanceof Error ? err.message : String(err),
          ...attrProps,
        },
      }).catch(() => {});
    }
    throw err;
  }
}

export async function cmdSetup(flags: Record<string, string | boolean>): Promise<void> {
  const hostType = detectTelemetryHostType();
  await ensureCliInstallTracked(hostType);
  await recordFunnelTelemetryEvent("cli_invoked", {
    source: "setup",
    hostType,
    properties: { command: "setup" },
  });
  info("Running setup checks");

  // Registration is optional — setup no longer registers implicitly. Users
  // can opt in later with `unbrowse register` if they want to publish, earn,
  // or access server-side analytics.

  const report = await runSetup({
    cwd: process.cwd(),
    opencode: normalizeSetupScope(flags.opencode),
    installBrowser: !flags["skip-browser"],
  }) as SetupReport & {
    server?: {
      started: boolean;
      skipped?: boolean;
      base_url?: string;
      error?: string;
    };
  };

  if (report.browser_engine.action === "failed") {
    info("Browser engine install failed");
  } else if (report.browser_engine.action === "installed") {
    info("Browser engine installed");
  }

  if (report.opencode.action === "installed" || report.opencode.action === "updated") {
    info(`Open Code command installed at ${report.opencode.command_file}`);
  }
  for (const hook of report.update_hints) {
    if (hook.action === "installed" || hook.action === "updated") {
      info(`${hook.host} update hint hook ${hook.action} at ${hook.config_file}`);
    }
  }

  // Wallet status — tell the user if they're missing payout config
  if (report.wallet.configured) {
    info(`Wallet configured (${report.wallet.provider}): ${(report.wallet as Record<string, unknown>).wallet_address ?? "linked"}`);
  } else if ((report.wallet as Record<string, unknown>).lobster_installed) {
    info("Wallet not paired — you won't earn when other agents use routes you discovered.");
    info("Run: npx @crossmint/lobster-cli setup");
  } else {
    info("No wallet configured — local indexing works, but payout needs a wallet.");
    info("Set up a wallet to start earning:");
    info("  npx @crossmint/lobster-cli setup");
  }

  const hasGcloud = (() => { try { const { existsSync } = require("fs"); const { homedir } = require("os"); const { join } = require("path"); return existsSync(join(homedir(), ".config", "gcloud", "application_default_credentials.json")); } catch { return false; } })();
  if (hasGcloud) {
    info("Email provider: Gmail (via GWS) — autonomous login enabled");
  }

  // Install the unbrowse Agent Skill — the PRIMARY surface (the CLI's map for
  // any skill-aware agent). Default ON; opt out with `--no-skill`.
  if (flags["no-skill"]) {
    info("Skill install skipped (--no-skill).");
  } else {
    const { installUnbrowseSkill } = await import("./setup/skill-install.js");
    const sk = installUnbrowseSkill(import.meta.url);
    if (sk.action === "installed") info(`Skill: installed unbrowse SKILL.md → ${sk.path}`);
    else if (sk.action === "updated") info(`Skill: refreshed unbrowse SKILL.md → ${sk.path}`);
    else if (sk.action === "already_current") info(`Skill: already current at ${sk.path}`);
    else info(`Skill install skipped (${sk.detail ?? sk.action}).`);
  }

  if (flags["mcp"] || flags["no-claude-register"] || flags["no-mcp-host-register"]) {
    info("MCP host autoinstall has been removed. The legacy server still exists as `unbrowse mcp`, but setup does not write MCP configs.");
  } else {
    info("MCP host registration skipped — setup installs the Agent Skill/CLI only.");
  }

  await recordInstallTelemetryEvent("setup", {
    hostType,
    status: report.browser_engine.action === "failed" ? "failed" : "installed",
    properties: {
      browser_engine_action: report.browser_engine.action,
      opencode_action: report.opencode.action,
      no_start: !!flags["no-start"],
      skip_browser: !!flags["skip-browser"],
    },
  });
  await recordFunnelTelemetryEvent("setup_completed", {
    source: "setup",
    hostType,
    properties: {
      browser_engine_action: report.browser_engine.action,
      opencode_action: report.opencode.action,
      no_start: !!flags["no-start"],
    },
  });

  if (flags["no-start"]) {
    report.server = { started: false, skipped: true, base_url: BASE_URL };
    output(report, true);
    if (report.browser_engine.action === "failed") process.exit(1);
    return;
  }

  // Registration is optional. Skip during setup — users can run `unbrowse
  // register` later if they want to publish, earn, or access server-side
  // analytics. Setup just installs deps and starts the local server.

  try {
    await getInProcessApp();
    report.server = { started: true, base_url: BASE_URL };
    await recordFunnelTelemetryEvent("server_autostart_succeeded", {
      source: "setup",
      hostType,
      properties: {
        base_url: BASE_URL,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordFunnelTelemetryEvent("server_autostart_failed", {
      source: "setup",
      hostType,
      properties: {
        failure_stage: "server_autostart",
        failure_reason: message,
      },
    });
    report.server = { started: false, error: message, base_url: BASE_URL };
    output(report, true);
    process.exit(1);
  }

  output(report, true);
  if (report.browser_engine.action === "failed") process.exit(1);
  if (getApiKey()) {
    info("Dashboard connected:");
    info("  unbrowse dashboard");
  }

  // --- Guided first resolve ---
  // After setup succeeds, auto-run a resolve so the user sees what unbrowse
  // does. This directly attacks the 82% drop-off at registration→first_resolve.
  try {
    info("Trying your first resolve...");
    const demoUrl = "https://jsonplaceholder.typicode.com";
    const demoIntent = "list all posts";
    void recordFunnelTelemetryEvent("resolve_started", {
      source: "setup",
      hostType,
      properties: { command: "guided-first-resolve", intent: demoIntent, url: demoUrl },
    }).catch(() => {}); // fire-and-forget: don't add ~5s to the first-resolve onboarding

    const resolveResult = await api("POST", "/v1/intent/resolve", {
      intent: demoIntent,
      params: { url: demoUrl },
      context: { url: demoUrl },
      projection: { raw: true },
    }) as Record<string, unknown>;

    if (isResolveSuccessResult(resolveResult)) {
      void recordFunnelTelemetryEvent("resolve_completed", {
        source: "setup",
        hostType,
        properties: { command: "guided-first-resolve", intent: demoIntent, url: demoUrl, source: resolveResult.source },
      }).catch(() => {});
      const endpoints = resolveResult.available_endpoints as Array<Record<string, unknown>> | undefined;
      if (endpoints && endpoints.length > 0) {
        info(`Found ${endpoints.length} API endpoint${endpoints.length > 1 ? "s" : ""} on ${demoUrl}:`);
        for (const ep of endpoints.slice(0, 5)) {
          const method = ep.method ?? "GET";
          const desc = ep.description ?? ep.url_template ?? ep.endpoint_id ?? "";
          info(`  ${method} ${desc}`);
        }
      } else {
        info(`Resolve succeeded on ${demoUrl}`);
      }
      info("");
      info("That's unbrowse. Try your own:");
      info('  unbrowse resolve --intent "search for shoes" --url "https://amazon.com"');
    } else {
      const inner = resolveResult.result as Record<string, unknown> | undefined;
      const nextStep = inner?.next_step as Record<string, unknown> | undefined;
      const command = typeof nextStep?.command === "string"
        ? nextStep.command
        : 'unbrowse capture --url "https://jsonplaceholder.typicode.com" --intent "list all posts"';
      info("No reusable route found on the demo site yet.");
      info("Next step:");
      info(`  ${command}`);
      info("");
      info("Try your own:");
      info('  unbrowse resolve --intent "search for shoes" --url "https://amazon.com"');
    }
  } catch {
    // Guided resolve is best-effort — never fail setup because of it
    info("Setup complete. Try your first resolve:");
    info('  unbrowse resolve --intent "list posts" --url "https://jsonplaceholder.typicode.com"');
  }
}

// ---------------------------------------------------------------------------
// Phase 8.2 — `unbrowse mode` standalone command + contribution prompt at end
// of `unbrowse setup`. The prompt is no-op when the user already chose; `mode`
// always re-prompts.
// ---------------------------------------------------------------------------

export async function cmdMode(_flags: Record<string, string | boolean>): Promise<void> {
  await promptContributionMode({ force: true });
  await syncContributionPreferenceToServer();
}

/**
 * Best-effort sync of the local share_pointers preference up to the backend
 * for account-bound API keys. Anonymous keys silently skip; offline / 5xx
 * surface a single info() warning so the user knows the local change is fine
 * but server didn't pick it up.
 */
async function syncContributionPreferenceToServer(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg?.api_key) return;
  const share_pointers = !!getContributionConfig().contribution.share_pointers;
  try {
    await pushAccountPreferences({ share_pointers });
    info("Synced preference to your account.");
  } catch (err) {
    const msg = (err as Error).message ?? "";
    // Anonymous keys get 403 account_required — silent in that case.
    if (msg.includes("account_required") || msg.includes("HTTP 403")) return;
    info(`Local mode set, but server sync failed: ${msg}`);
  }
}

async function refreshContributionPreferenceFromServer(verbose = false): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg?.api_key) return false;
  try {
    const serverPrefs = await fetchAccountPreferences();
    if (!serverPrefs) return false;
    const local = getContributionConfig();
    if (local.contribution.share_pointers !== serverPrefs.share_pointers) {
      setContributionConfig({
        contribution: { share_pointers: serverPrefs.share_pointers, set_via: "mode-command" },
      });
      if (verbose) info(`Synced auto-publish from dashboard: ${serverPrefs.share_pointers ? "ON" : "off"}.`);
    }
    return true;
  } catch (err) {
    if (verbose) info(`Dashboard preference sync failed: ${(err as Error).message}`);
    return false;
  }
}

export async function cmdAccount(flags: Record<string, string | boolean>): Promise<void> {
  if (flags["reset-key"]) {
    await cmdRegister({
      reset: true,
      email: typeof flags.email === "string" ? flags.email : undefined,
      "no-prompt": flags["no-prompt"],
    });
    return;
  }

  await refreshContributionPreferenceFromServer(false);
  const cfg = loadConfig();
  const contribution = getContributionConfig();
  const { getPaymentProviderConfig } = await import("./config/payment-provider.js");
  const paymentCfg = getPaymentProviderConfig();
  // Native, zero-step onboarding: every install has a self-custody identity
  // wallet. `account` is where the user identifies themselves, so surface it.
  // READ the existing identity first (non-destructive — never touches the key),
  // and only MINT when there genuinely is no wallet yet (first run). This keeps
  // `account` a safe query: it can bootstrap a brand-new install's identity but
  // never rotates an existing one if key storage is transiently unreadable. A
  // configured payout wallet (lobster / Privy / external / OWS) still takes
  // precedence for wallet_address; the identity wallet is shown on its own too.
  let identityWallet: string | null = null;
  if (process.env.UNBROWSE_DISABLE_LOCAL_WALLET !== "1") {
    try {
      const { readLocalWalletAddress, ensureLocalWalletAddress } = await import("./values/signer.js");
      identityWallet = readLocalWalletAddress() ?? ensureLocalWalletAddress();
    } catch {
      /* best-effort: a locked-down / read-only fs still yields a usable account view */
    }
  }
  const payoutWallet = cfg?.wallet_address ?? null;
  const payload = {
    signed_in: !!cfg?.api_key,
    agent_id: cfg?.agent_id ?? null,
    agent_name: cfg?.agent_name ?? null,
    email: cfg?.email ?? null,
    user_id: cfg?.user_id ?? null,
    wallet_address: payoutWallet ?? identityWallet,
    wallet_provider: cfg?.wallet_provider ?? (payoutWallet ? null : (identityWallet ? "unbrowse-local" : null)),
    identity_wallet: identityWallet,
    payout_wallet: payoutWallet,
    payment_provider: paymentCfg.payment.provider,
    payment_provider_set_via: paymentCfg.payment.set_via ?? "default",
    dashboard_url: `${FRONTEND_URL}/dashboard`,
    local_server: BASE_URL,
    auto_publish: contribution.contribution.share_pointers,
    rev_share: contribution.rev_share.opted_in,
  };
  if (flags.json || flags.pretty) {
    output(payload, !!flags.pretty);
    return;
  }
  // Wave 3: provider-aware top-up nudge surfaces here so the user sees
  // a concrete next step every time they check `unbrowse account`. The
  // copy mirrors NEXT_STEP_BY_CHOICE in cli-payment-setup.ts so the
  // CLI and `unbrowse account` agree on the same instructions.
  const PAYMENT_NUDGE: Record<string, string> = {
    pay_sh:           "`pay-cli get_balance` to check funds, `pay-cli topup` to add USDC",
    lobster_cash:     "`lobstercash balance` to check funds, `lobstercash topup` for credit-card recharge",
    external_solana:  "Top up your Solana address manually; `unbrowse wallet` to inspect what unbrowse has on file",
    privy_embedded:   "Send SOL/USDC to the embedded wallet on https://unbrowse.ai/account (private key custody stays in Privy)",
    skip:             "Free tier active. Sponsor middleware covers your first $1/day/agent. `unbrowse payment-provider` to opt in to a paid rail.",
  };
  info("Unbrowse account");
  info(`  signed_in: ${payload.signed_in ? "yes" : "no"}`);
  info(`  email: ${payload.email ?? "(none)"}`);
  info(`  agent_id: ${payload.agent_id ?? "(none)"}`);
  info(`  identity wallet: ${payload.identity_wallet ?? "(none)"}  (self-custody, unbrowse-local)`);
  info(`  payout wallet: ${payload.payout_wallet ?? "(none — earnings route to identity wallet / sponsor pool)"}`);
  info(`  payment_provider: ${payload.payment_provider}`);
  info(`    top-up: ${PAYMENT_NUDGE[payload.payment_provider] ?? "Run `unbrowse payment-provider` to pick a rail."}`);
  info(`  auto_publish: ${payload.auto_publish ? "on" : "off"}`);
  info(`  dashboard: ${payload.dashboard_url}`);
  output(payload, false);
}

export async function cmdDashboard(flags: Record<string, string | boolean>): Promise<void> {
  await refreshContributionPreferenceFromServer(false);
  const cfg = loadConfig();
  if (!cfg?.api_key) {
    const loginUrl = `${FRONTEND_URL}/login`;
    info("No account-bound CLI key found. Opening website sign-in.");
    if (!flags["no-open"]) openUrl(loginUrl);
    output({ status: "login_required", url: loginUrl }, !!flags.pretty);
    return;
  }
  await getInProcessApp();
  const pair = createDashboardPairingToken();
  const url = `${FRONTEND_URL}/login?local=${encodeURIComponent(BASE_URL)}&pair=${encodeURIComponent(pair.token)}`;
  if (!flags["no-open"]) openUrl(url);
  info("Opening dashboard and pairing this CLI install.");
  output({
    status: "pairing_started",
url,
    local_server: BASE_URL,
    expires_at: pair.expires_at,
  }, !!flags.pretty);
}

// Hook the contribution prompt + payment-provider prompt onto the tail of
// cmdSetup. Called from main() right after cmdSetup runs. Order: contribution
// first (supply side: do we share captured routes back to the marketplace?)
// then payment-provider (demand side: which rail settles paid calls?). They
// are orthogonal but contribution runs first because it's the established
// prompt new users have seen; payment-provider lands as an additive surface.
async function runPostSetupContributionPrompt(): Promise<void> {
  try {
    await promptContributionMode({ force: false });
  } catch {
    // Never fail setup because of the prompt.
  }
  try {
    const { promptPaymentProvider } = await import("./cli-payment-setup.js");
    await promptPaymentProvider({ force: false });
  } catch {
    // Never fail setup because of the prompt.
  }
}

// ---------------------------------------------------------------------------
// Phase 8.2 — `unbrowse capture` standalone verb.
//
// Live-browser capture is no longer triggered implicitly from resolve. The
// agent calls `unbrowse capture --url <url> --intent <intent>` explicitly
// when it has decided the cost (5–15s) is worth it. Server side wraps the
// existing executeBrowserCapture pipeline at POST /v1/capture.
// ---------------------------------------------------------------------------

export async function cmdCapture(flags: Record<string, string | boolean>): Promise<void> {
  const url = flags.url as string;
  const intent = (flags.intent as string) || "capture";
  if (!url) die("--url is required");
  maybeShowContributionNotice();

  const t0 = Date.now();
  const result = await api("POST", "/v1/capture", { url, intent }) as Record<string, unknown>;

  const endpoints = Array.isArray(result.endpoints)
    ? (result.endpoints as unknown[])
    : (Array.isArray(result.available_endpoints) ? (result.available_endpoints as unknown[]) : []);
  const skill = (result.skill as Record<string, unknown> | undefined) ?? null;
  const skillId = (result.skill_id as string | undefined)
    ?? (skill?.skill_id as string | undefined)
    ?? (typeof result.learned_skill_id === "string" ? (result.learned_skill_id as string) : undefined);

  // Detect "lazy-loading SPA" shape: only one endpoint surfaced and it's the
  // document URL itself (no XHR fired during the auto-capture window). The
  // agent should drive interaction (scroll/click) so HAR catches the lazy
  // fetches. Pure structural shape — no per-host check.
  const isThinDocumentOnly = endpoints.length === 1 && (() => {
    const e0 = endpoints[0] as { method?: string; url_template?: string };
    if (!e0 || e0.method !== "GET") return false;
    const tmpl = (e0.url_template ?? "").split("?")[0].replace(/\/$/, "");
    const target = url.split("?")[0].replace(/\/$/, "");
    return tmpl === target;
  })();

  const escapedIntent = intent.replace(/"/g, "\\\"");
  const escapedUrl = url.replace(/"/g, "\\\"");

  const envelope = {
    skill_id: skillId,
    endpoints_discovered: typeof result.endpoints_discovered === "number"
      ? (result.endpoints_discovered as number)
      : endpoints.length,
    marketplace_published: !!result.marketplace_published,
    ms: typeof result.ms === "number" ? (result.ms as number) : Date.now() - t0,
    next_step: endpoints.length === 0
      ? "no endpoints discovered; site may need authentication or different intent"
      : `unbrowse resolve --intent "${escapedIntent}" --url "${escapedUrl}"`,
    ...(isThinDocumentOnly
      ? { capture_pattern: "doc_only", capture_observation: "only the input URL was captured (1 GET, no XHR fired during the auto-capture window)" }
      : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.captured_meta ? { captured_meta: result.captured_meta } : {}),
    ...(typeof result.capture_path === "string" ? { capture_path: result.capture_path } : {}),
    ...(result.prior_domain_note ? { prior_domain_note: result.prior_domain_note } : {}),
    ...(result.note_evidence ? { note_evidence: result.note_evidence } : {}),
  };

  output(envelope, !!flags.pretty);
}

// ─── sandbox-replay ────────────────────────────────────────────────────────
// Run a captured anti-bot / signed-URL / HMAC bundle through the Kuri sandbox
// (deep-reveng path). Returns harvested cookies + optional postEval result.
// ─── fetch / sandbox-replay (merged) ─────────────────────────────────────
// Single command, two modes:
//   simple  — `unbrowse fetch <url>`           → body-only output, auto-built bundle
//   advanced — pass --bundle-source / --bundle-url → full envelope, custom JS bundle
// All requests run through Kuri's sandboxed JS runtime + libcurl-impersonate
// (Chrome 131 JA4) and auto-pull cookies from the user's real browser unless
// --no-browser-cookies is set.

interface SandboxResult {
  resp: Awaited<ReturnType<typeof import("./sandbox/bundle-replay-client.js").runBundleReplay>>;
  postEvalProcessed: unknown;
  cookieHeader: string;
}

async function runSandboxCore(
  flags: Record<string, string | boolean>,
  fetchUrl?: string,
): Promise<SandboxResult> {
  const { runBundleReplay, cookiesToHeaderValue } = await import("./sandbox/bundle-replay-client.js");

  const targetOrigin = (flags["target-origin"] as string)
    ?? (flags.origin as string)
    ?? (fetchUrl ? (() => { try { return new URL(fetchUrl).origin; } catch { return fetchUrl; } })() : undefined);
  const targetHref = (flags["target-href"] as string) ?? (flags.url as string) ?? fetchUrl;
  const bundleUrl = (flags["bundle-url"] as string) ?? (flags.bundle as string);
  let bundleSource = flags["bundle-source"] as string | undefined;
  const postEval = (flags["post-eval"] as string) ?? (flags.eval as string);
  const fingerprint = (flags.fingerprint as string) ?? "chrome_mac_arm";
  const impersonate = (flags.impersonate as string) ?? "chrome131";
  const timeoutMs = flags["timeout-ms"] ? Number(flags["timeout-ms"]) : 30_000;

  // --proxy: route the libcurl-impersonate call through IPRoyal residential
  // proxy (same primitive as the 429 fallback path in executeEndpoint).
  // Caller decides — no per-domain registry, no heuristics. Closes gap §2.3
  // from docs/RUNTIME-BINDING-RECOMPUTE.md.
  let proxyUrl: string | undefined;
  if (flags.proxy === true) {
    const { resolveProxyUrl } = await import("./execution/proxy-fetch.js");
    proxyUrl = resolveProxyUrl(process.env);
    if (!proxyUrl) die("--proxy: set IPROYAL_USER / IPROYAL_PASS env vars or omit --proxy");
    info(`[fetch] routing via residential proxy (${proxyUrl.replace(/\/\/[^@]+@/, "//***@")})`);
  }

  if (bundleSource === "-" || flags["stdin"]) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    bundleSource = Buffer.concat(chunks).toString("utf8");
  }

  if (!targetOrigin) die("usage: unbrowse fetch <url>  |  unbrowse fetch <url> --bundle-source <js|-> --post-eval <expr>");
  if (!fetchUrl && !bundleUrl && !bundleSource) die("--bundle-url or --bundle-source required (or pass a URL: `unbrowse fetch <url>`)");

  const kuriBase = process.env.KURI_BASE_URL ?? "http://127.0.0.1:8080";
  await ensureKuriReachable(kuriBase);

  let seedCookies: Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite: string; expires: number }> | undefined;
  const useBrowserCookies = flags["no-browser-cookies"] !== true;
  if (useBrowserCookies) {
    const { findBestBrowserSession } = await import("./auth/browser-cookies.js");
    const host = (() => { try { return new URL(targetOrigin).hostname; } catch { return targetOrigin; } })();
    const session = findBestBrowserSession(host);
    if (session) {
      seedCookies = session.cookies;
      info(`[fetch] seeded ${session.cookies.length} cookies from ${session.browser} (${session.sessionCookies} httpOnly+secure) — pass --no-browser-cookies to skip`);
    } else {
      info(`[fetch] no logged-in browser session for ${host} (scanned Chrome/Arc/Brave/Edge/Vivaldi/Opera/Dia/Chromium)`);
    }
  }

  const resp = await runBundleReplay({
    targetOrigin,
    targetHref,
    bundleUrl,
    bundleSource,
    fingerprint: fingerprint as "chrome_mac_arm" | "chrome_windows",
    impersonate,
    postEval,
    timeoutMs,
    seedCookies,
    proxy: proxyUrl,
  }, { kuriBase });

  // Default: convert HTML body fields (>1KB, look HTML-shaped) to markdown
  // via turndown. --raw skips for reverse-engineering / debugging. --main ALSO
  // skips it here: --main runs htmlToReadableMarkdown (readability node-scoring +
  // cleanDOM) on the body downstream, which needs RAW HTML — turndown-ing first
  // feeds it markdown, so the readability pass sees no DOM and collapses (the exa
  // bench's javacodegeeks "13-word" outlier). cmdFetch re-applies the markdown
  // conversion via htmlToReadableMarkdown, so the --main output is still markdown.
  let postEvalProcessed: unknown = resp.post_eval;
  if (flags.raw !== true && flags.main !== true && resp.post_eval !== undefined) {
    try {
      const TurndownService = (await import("turndown")).default;
      const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
      turndown.remove(["script", "style", "noscript", "iframe", "svg", "link", "meta"]);
      const stripPreamble = (html: string): string => html
        .replace(/<!DOCTYPE[^>]*>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<script[^>]*?>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*?>[\s\S]*?<\/style>/gi, "");
      // --main: strip page chrome (nav/sidebar/footer/ads) and isolate the main
      // content region before converting, for higher extraction fidelity. Opt-in;
      // the default whole-page conversion is unchanged. cleanDOM is lazy-loaded
      // only when the flag is set, so default fetch pays no startup cost.
      let cleanMain: ((h: string) => string) | null = null;
      if (flags.main === true) {
        try { cleanMain = (await import("./extraction/index.js")).cleanDOM; } catch { cleanMain = null; }
      }
      const prepHtml = (html: string): string => {
        if (cleanMain) { try { return cleanMain(html); } catch { /* fall back */ } }
        return stripPreamble(html);
      };
      const isHtmlString = (s: unknown): s is string => {
        if (typeof s !== "string") return false;
        // A full HTML document (doctype / <html> / <head> / <body>) is always
        // markdown-convertible regardless of size — a short page (e.g. a 500B
        // doc, an API snippet) must not leak raw HTML to a consumer expecting
        // markdown. Only the size gate below guards bare fragments.
        if (/<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(s)) return true;
        return s.length > 1024 && /<(html|body|article|div|p|h[1-6])\b/i.test(s);
      };
      const parsed = typeof resp.post_eval === "string"
        ? JSON.parse(resp.post_eval)
        : resp.post_eval;
      const convertHtmlFields = (val: unknown): unknown => {
        if (isHtmlString(val)) {
          try { return turndown.turndown(prepHtml(val)).replace(/\n{3,}/g, "\n\n").trim(); }
          catch { return val; }
        }
        if (Array.isArray(val)) return val.map(convertHtmlFields);
        if (val && typeof val === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(val)) out[k] = convertHtmlFields(v);
          return out;
        }
        return val;
      };
      postEvalProcessed = convertHtmlFields(parsed);
    } catch (e) {
      info(`[fetch] markdown conversion failed: ${(e as Error).message}; returning raw post_eval`);
    }
  }

  // Feed observed routes through the marketplace publisher only when explicit.
  const publishObserved = flags.publish === true || process.env.UNBROWSE_PUBLISH_OBSERVED_ROUTES === "1";
  if (publishObserved && resp.routes_observed && resp.routes_observed.length > 0) {
    try {
      await publishObservedRoutes(resp.routes_observed, targetOrigin, flags.intent as string | undefined);
    } catch (e) {
      info(`[fetch] publish-observed-routes failed: ${(e as Error).message}`);
    }
  }

  return { resp, postEvalProcessed, cookieHeader: cookiesToHeaderValue(resp.cookies) };
}

// Unified URL → content command. Two modes:
//   simple  — `unbrowse fetch <url>`
//                Auto-builds a __nativeFetch bundle, runs it, prints body only.
//                HTML auto-converted to markdown unless --raw.
//   advanced — `unbrowse fetch <url> --bundle-source <js|->`
//                Runs your custom JS in the sandbox; prints full envelope
//                (cookies, post_eval, routes_observed). Use this for
//                anti-bot bundle replay, signed-URL HMAC compute, etc.
/**
 * Decide whether a `fetch` result is a success or a failure the caller should
 * see in the exit code. Pure + exported so it is unit-testable. Without this,
 * `fetch` exited 0 on a 404 (empty stdout) and on a DNS/network failure (printed
 * "null") — an agent or shell script could not distinguish success from failure
 * on the primary content tool. Mirrors `curl --fail`: a reached-but-errored
 * status (>=400) and a no-response network failure are both failures.
 */
export function fetchOutcome(status: unknown, body: unknown): { ok: boolean; reason?: string } {
  const numStatus = typeof status === "number" ? status : Number(status);
  if (!Number.isFinite(numStatus) || numStatus === 0) {
    // No usable HTTP status — a network/DNS failure or unreachable host. Only a
    // present body (rare body-sniff path without status) counts as success.
    if (body == null || body === "") {
      return { ok: false, reason: "no response (network/DNS failure or unreachable host)" };
    }
    return { ok: true };
  }
  if (numStatus >= 400) return { ok: false, reason: `HTTP ${numStatus}` };
  return { ok: true };
}

export async function cmdFetch(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const requestedUrl = args[0] ?? (flags.url as string);
  const customBundle = !!(flags["bundle-source"] || flags["bundle-url"] || flags["stdin"]);
  const wantEnvelope = flags.envelope === true || customBundle;
  const fetchMethod = ((flags.method as string) ?? "GET").toUpperCase();
  // github code-file blob → fetch the CLEAN RAW file. The rendered blob page
  // carries ~50% chrome on top of the file (the exa micro-bench measured small
  // code files at ~0.53 ROUGE-L); raw.githubusercontent serves the exact bytes.
  // Simple GET only — PRs/issues/tree views + custom bundles pass through.
  const { githubBlobToRaw } = await import("./extraction/github-raw.js");
  const url = (!customBundle && fetchMethod === "GET" && githubBlobToRaw(requestedUrl)) || requestedUrl;

  if (!url && !customBundle) die("usage: unbrowse fetch <url>  |  unbrowse fetch --help for advanced bundle mode");

  // SIMPLE mode: build the bundle ourselves.
  let bundleSource = flags["bundle-source"] as string | undefined;
  if (!customBundle && url) {
    const method = fetchMethod;
    const reqHeaders: Record<string, string> = { Accept: "*/*" };
    if (typeof flags.header === "string") {
      const idx = flags.header.indexOf(":");
      if (idx > 0) reqHeaders[flags.header.slice(0, idx).trim()] = flags.header.slice(idx + 1).trim();
    }
    const headersLiteral = JSON.stringify(reqHeaders).replace(/'/g, "\\'");
    bundleSource = `(() => {
      const r = __nativeFetch(${JSON.stringify(method)}, ${JSON.stringify(url)}, ${headersLiteral}, null);
      globalThis.r = { status: r.status, content_type: r.headers && (r.headers['content-type'] || r.headers['Content-Type']) || null, body: r.body, final_url: r.url };
    })()`;
  }

  // Hand off to the core. We pass our synthesized bundle via flags so the
  // core sees a uniform input shape regardless of mode.
  const coreFlags: Record<string, string | boolean> = { ...flags };
  if (bundleSource && !flags["bundle-source"] && !flags["bundle-url"]) coreFlags["bundle-source"] = bundleSource;
  if (!coreFlags["post-eval"] && !customBundle) coreFlags["post-eval"] = "globalThis.r";

  const { resp, postEvalProcessed, cookieHeader } = await runSandboxCore(coreFlags, url);

  if (wantEnvelope) {
    output({
      ok: resp.ok,
      ms: resp.ms,
      egress_bytes: resp.egress_bytes,
      cookies: resp.cookies,
      cookie_header: cookieHeader,
      routes_observed: resp.routes_observed,
      post_eval: postEvalProcessed,
    }, !!flags.pretty);
    return;
  }

  // SIMPLE mode output: stat line on stderr, body on stdout.
  const peo = postEvalProcessed as Record<string, unknown> | string | undefined;
  let body = (peo && typeof peo === "object" && "body" in peo) ? peo.body : peo;
  let status = (peo && typeof peo === "object" && "status" in peo) ? peo.status : "?";
  const routesCount = resp.routes_observed?.length ?? 0;

  // x402 / pay.sh: if the URL answered 402 Payment Required, pay it via the
  // configured wallet adapter and retry ONCE. Default-off — only fires when a
  // wallet adapter is configured (UNBROWSE_WALLET_ADAPTER=pay routes through the
  // pay.sh CLI and handles MPP + x402; sandbox via UNBROWSE_PAY_SANDBOX=1).
  // In-process (x402Fetch uses global fetch) — no daemon spawn.
  if (!customBundle && url && Number(status) === 402) {
    const { x402Fetch, resolveWalletConfig } = await import("./payments/x402-fetch.js");
    const adapter = resolveWalletConfig().adapter;
    if (adapter !== "none") {
      const payHeaders: Record<string, string> = { Accept: "*/*" };
      if (typeof flags.header === "string") {
        const idx = flags.header.indexOf(":");
        if (idx > 0) payHeaders[flags.header.slice(0, idx).trim()] = flags.header.slice(idx + 1).trim();
      }
      const payInit: RequestInit = { method: fetchMethod, headers: payHeaders };
      if (typeof flags.data === "string") payInit.body = flags.data;
      try {
        const { response, trace } = await x402Fetch(url, payInit);
        if (response.status >= 200 && response.status < 300) {
          body = await response.text();
          status = response.status;
          info(`[fetch] paid 402 via ${trace.adapter ?? "wallet"} (${trace.sub_state}) → ${response.status}`);
        } else {
          info(`[fetch] 402 not paid (${trace.sub_state}) — see https://pay.sh for wallet setup`);
        }
      } catch (e) {
        info(`[fetch] x402 retry failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      info("[fetch] 402 Payment Required — set UNBROWSE_WALLET_ADAPTER (e.g. =pay) to authorize payment");
    }
  }
  // Tencent Cloud WAF (TCaptcha) escalation. cmdFetch simple-mode is HTTP-first
  // (curl-impersonate has no JS engine), so a Tencent-fronted site (rootdata.com)
  // returns the captcha bootstrap stub as a 200 — not a 402 — and the block goes
  // unnoticed. When the body IS the Tencent challenge, escalate: (1) the x402
  // web-unblocker (wallet-paid, no signup) first, then (2) the Capzy TCaptcha
  // solver (extract appId+seqid → solve → POST /WafCaptcha → replay with the
  // clearance cookie over the sticky residential IP). Both degrade to null when
  // their credential is absent → the original stub is returned unchanged.
  if (!customBundle && url && typeof body === "string") {
    const { extractTencentChallenge, clearTencentWafViaCapzy } = await import("./execution/tencent-waf-solve.js");
    if (extractTencentChallenge(body)) {
      const { resolveEgressProxy } = await import("./execution/proxy-fetch.js");
      const proxyUrl = resolveEgressProxy();
      // 1) x402 200ok web-unblocker (primary, wallet-paid).
      try {
        const { tryX402UnblockerFetch } = await import("./capture/curl-impersonate-fallback.js");
        const unlocked = await tryX402UnblockerFetch({ url, timeoutMs: 240_000 });
        if (unlocked?.html && unlocked.html.length > 1024 && !extractTencentChallenge(unlocked.html)) {
          body = unlocked.html;
          status = unlocked.status || 200;
          info(`[fetch] tencent-waf cleared via x402 unblocker → ${unlocked.html.length}B`);
        }
      } catch { /* fall through to capzy */ }
      // 2) Capzy TCaptcha solver (fallback, API key).
      if (typeof body === "string" && extractTencentChallenge(body)) {
        try {
          const cleared = await clearTencentWafViaCapzy({
            url, html: body, proxyUrl,
            capzyKey: process.env.UNBROWSE_CAPZY_KEY,
            cookieHeader,
          });
          if (cleared) {
            body = cleared.html;
            status = 200;
            info(`[fetch] tencent-waf cleared via capzy → ${cleared.html.length}B`);
          } else {
            info("[fetch] tencent-waf challenge unsolved — set UNBROWSE_CAPZY_KEY and/or a Base x402 wallet (payment_provider is 'skip') to auto-clear");
          }
        } catch { /* keep the stub */ }
      }
    }
  }

  // --main: extract the page's MAIN CONTENT as clean markdown (drop nav, chrome,
  // sidebars, related-links, footers) rather than dumping the whole HTML page.
  // Only fires on HTML bodies; cleanDOM has a content-loss guard that falls back
  // to the whole page when the main-region heuristic misfires (structured files).
  // This is what closes the chrome-dilution gap on article/doc pages (the exa
  // contents bench: whole-page fetch over-extracts ~65% vs the clean golden).
  if (flags.main && typeof body === "string") {
    const ct = (peo && typeof peo === "object" && "content_type" in peo) ? String((peo as Record<string, unknown>).content_type ?? "") : "";
    const looksHtml = /html/i.test(ct) || /<html[\s>]|<!doctype html/i.test(body.slice(0, 1000));
    if (looksHtml) {
      try {
        const { htmlToReadableMarkdown } = await import("./extraction/readable-markdown.js");
        body = await htmlToReadableMarkdown(body);
      } catch { /* extraction failed — emit the raw body unchanged */ }
    }
  }
  info(`[fetch] ${status} ${resp.ms}ms ${resp.egress_bytes}B${routesCount > 0 ? ` · ${routesCount} route(s) observed` : ""}`);
  if (typeof body === "string") {
    process.stdout.write(body);
    if (!body.endsWith("\n")) process.stdout.write("\n");
  } else {
    output(body, !!flags.pretty);
  }
  // Surface failure in the exit code so an agent/script can detect it. The body
  // (an error page or error JSON) is still printed above; only the exit status
  // and a one-line stderr note change. Without this, fetch exited 0 on a 404 or
  // a DNS failure and the caller could not tell it failed.
  const outcome = fetchOutcome(status, body);
  if (!outcome.ok) {
    info(`[fetch] failed: ${outcome.reason}`);
    process.exitCode = 1;
  }
}
// ---------------------------------------------------------------------------
// CLI Reference — single source of truth for help text AND SKILL.md
// ---------------------------------------------------------------------------

export const CLI_REFERENCE = {
  // PRIMARY commands the agent should reach for first. Deprecated aliases are
  // listed separately below; they print a deprecation notice and forward to the
  // canonical command.
  commands: [
    // ── Setup & lifecycle ─────────────────────────────────────────────────
    { name: "setup", usage: "[--no-skill] [--opencode auto|global|project|off] [--no-start] [--skip-browser]", desc: "Bootstrap the browser engine, install the unbrowse Agent Skill (the primary surface) into ~/.claude/skills/unbrowse, and write the /unbrowse Open Code command. Setup does not write MCP host configs; `unbrowse mcp` remains manual-only for legacy hosts. Run once on install. Re-run is safe." },
    { name: "upgrade", usage: "", desc: "Print the right upgrade command (npm i -g unbrowse@latest or @preview)." },
    { name: "health", usage: "", desc: "Quick local runtime health check. Runs in-process by default; explicit `serve` is the compatibility daemon." },
    { name: "mcp", usage: "[--no-auto-start]", desc: "Run the stdio MCP server. Used by Claude/Cursor; not for direct shell use." },

    // ── Identity & policy ─────────────────────────────────────────────────
    { name: "account", usage: "[--register] [--email user@example.com] [--reset-key] [--json]", desc: "Show local account, wallet, and contribution mode. --register mints a new key (replaces old `register` command). Contribution mode + payment provider live under `settings`/`setup`." },
    { name: "dashboard", usage: "[--no-open]", desc: "Open the website dashboard and pair this CLI install through localhost." },
    { name: "settings", usage: "[--auto-publish on|off] [--passive-index on|off] [--publish-blacklist d1,d2] [--publish-promptlist d1,d2]", desc: "Show or update local capture/publish policy. --passive-index (default on) indexes in the background while you browse for faster checkpoints." },

    // ── The primary one-hole path + compatibility route views ─────────────
    { name: "get", usage: '"task" [--url <url>] [--mode auto|data|chooser]', desc: "PRIMARY read/search one-hole agent path. Ask for the internet result in natural language, optionally scoped to a URL; runtime chooses search, direct fetch, route graph, adapter, browser capture, cookies/HAR, and indexing while keeping private route/auth details behind typed holes. --mode (default auto) makes the post-capture data-vs-chooser switch explicit: `data` always returns the page/result payload, `chooser` always returns the available_operations list, `auto` keeps the runtime's default." },
    { name: "fetch", usage: "<url> [opts] | <url> --bundle-source <js|-> --post-eval <expr> [opts]", desc: "PRIMARY URL → content tool. SIMPLE mode (`fetch <url>`) prints body only, HTML auto-converted to markdown. ADVANCED mode (with --bundle-source) runs custom JS through the embedded browser/sandbox primitive and prints the full envelope (cookies, post_eval, observed routes). Browser/Kuri helpers are binary-owned implementation details." },
    { name: "fill", usage: '<ref> <value>  |  "task" [--url <url>]', desc: "Browser-session DOM input fill by @eN ref. Compatibility: natural-language `fill \"task\"` still routes through the one-hole path, but new read/search prompts should use `get`." },
    { name: "run", usage: '<url> "task"', desc: "Compatibility alias for the one-shot path. Prefer `get` for new read/search agent prompts; accepts positional task text or --intent/--task/--query." },
    { name: "resolve", usage: '--intent "..." [--url "..."] [--domain "..."] [--no-execute]', desc: "Advanced: resolve an intent against marketplace + local cache only. --task and --query are accepted aliases for --intent. Auto-executes the top safe GET endpoint by default; --no-execute returns metadata only." },
    { name: "execute", usage: "--skill ID --endpoint ID [-p key=val ...] [--params '{json}']", desc: "Execute a specific endpoint. Call after `unbrowse resolve --no-execute` returned a shortlist. Pass replay params via repeated -p flags or --params with a JSON object." },
    { name: "explain", usage: '--intent "..." --url "..." [--top N]', desc: "Print top-N candidate endpoints + evidence so an LLM (or you) can pick. No heuristic verdict — just primitives + evidence." },

    // ── Capture (live-browser indexing) ───────────────────────────────────
    { name: "capture", usage: "--url <url> --intent <intent> [--retries N]  |  --corpus <file> --out <file> [--retries N]", desc: "Advanced: live-browser HAR capture; discovers + indexes API endpoints. `run` calls this automatically on misses. Marketplace publish gated by `unbrowse mode`." },
    { name: "auth", usage: '<url>', desc: "Open a visible browser so you can sign in to a site; cookies persist for future run/fetch/resolve. (Old names: `auth-capture`, `login`.)" },

    // ── Skill management ──────────────────────────────────────────────────
    { name: "skills", usage: "", desc: "List all locally-cached skills (skill_id, domain, endpoint count)." },
    { name: "skill", usage: "<id>", desc: "Get full SkillManifest for one skill (intent, endpoints, schemas)." },
    { name: "skill-package", usage: "<skill-id> [--out <dir>] [--expose]", desc: "Emit a per-website skill package (SKILL.md with origin pointer + credential holes + x402 reward, plus README), ready to push to unbrowse-ai/<domain> and install via `npx skills add`. Skills are NOT exposed by default; pass --expose to mark this one as a published standalone skill." },
    { name: "feedback", usage: "--skill ID --endpoint ID --rating 1-5", desc: "Submit feedback after presenting endpoint results to the user (mandatory after resolve+execute)." },
    { name: "annotate", usage: "--skill ID --endpoint ID --text 'tip' [--constraint 'param:rule:msg']", desc: "Contribute best practices, constraints, or gotchas for an endpoint." },
    { name: "review", usage: "--skill ID --endpoints '[...]'", desc: "Push reviewed descriptions/schema metadata back to a captured skill before publish." },
    { name: "index", usage: "--skill ID", desc: "Recompute local graph/contracts/export from cached skill state. Cheap; doesn't hit the network." },
    { name: "publish", usage: "--skill ID [--confirm-publish] [--endpoints '[...]']", desc: "Publish reviewed skill to the marketplace. Re-indexes locally first; --confirm-publish bypasses the safety prompt." },
    { name: "publish-bundle", usage: "--preset path [--hosts codex,claude,openclaw] [--site-url url]", desc: "Derive foundry bundle/share/host artifacts from one preset and write the public share manifest." },
    { name: "cleanup-stale", usage: "[--skill ID] [--domain host] [--limit N]", desc: "Verify skills against live endpoints and evict stale cached entries." },
    { name: "search", usage: '--intent "..." [--domain "..."] [--url "..."]', desc: "Unified discovery: find the route/skill (or web answer) for an intent. Searches the shared route graph first, plus best-effort web enrichment. Free — you only pay when you execute a returned paid route." },
    { name: "spec", usage: "<domain-or-url> [--budget-ms N] [--graphql]", desc: "Probe spec-publishing endpoints (openapi/swagger/sitemap/robots/graphql) for a site BEFORE browse-capture. Pointer-only metadata. Delegates to the v7 eval handler shared with MCP `unbrowse_spec`." },
    { name: "auth-inventory", usage: "[--domain host]", desc: "Per-domain inventory of what the local browser profile can already authenticate against (hostnames, cookie NAMES, counts — never values). Bias resolve toward logged-in domains. Shared with MCP `unbrowse_auth_inventory`." },

    // ── Browser session (binary-owned browser primitives) ─────────────────
    // Use these when the work needs a real DOM (form submits, click flows).
    // Sequence: go → snap → click/fill/eval → submit → sync → close.
    { name: "go", usage: '<url> [--session id]', desc: "Acquire a binary-owned browser lease and open a fresh tab (or reuse via --session for legacy flows). Step 1 of the browse workflow." },
    { name: "snap", usage: "[--session id] [--filter interactive]", desc: "A11y snapshot with @eN refs. Inspect the page state — gives you the refs to click/fill." },
    { name: "click", usage: "[--session id] <ref>", desc: "Click element by @eN ref from snap." },
    { name: "type", usage: "<text>", desc: "Type into the focused element with key events (use after click)." },
    { name: "press", usage: "<key>", desc: "Press a key (Enter, Tab, Escape, ArrowDown, ...)." },
    { name: "select", usage: "<ref> <value>", desc: "Select option by @eN ref + value (for <select> elements)." },
    { name: "scroll", usage: "[up|down|left|right]", desc: "Scroll the page in a direction." },
    { name: "submit", usage: "[--session id] [--form-selector sel] [--submit-selector sel] [--wait-for hint]", desc: "Submit current form. Browser-native by default; site-state assist + same-origin rehydrate are explicit opt-ins." },
    { name: "screenshot", usage: "[--session id]", desc: "Capture screenshot (base64 PNG)." },
    { name: "text", usage: "[--session id]", desc: "Get page text content." },
    { name: "markdown", usage: "[--session id]", desc: "Get page as Markdown." },
    { name: "cookies", usage: "[--session id]", desc: "Get page cookies." },
    { name: "eval", usage: "[--session id] <expression>", desc: "Evaluate JavaScript in the page context (e.g. inspect hidden inputs, read JS state)." },
    { name: "back", usage: "[--session id]", desc: "Browser back." },
    { name: "forward", usage: "[--session id]", desc: "Browser forward." },
    { name: "sync", usage: "[--session id]", desc: "Checkpoint capture, keep tab open, queue background index + publish." },
    { name: "close", usage: "[--session id]", desc: "Final checkpoint, queue background index + publish, close session. End-of-flow." },
    { name: "inspect", usage: "[--session id] [--all]", desc: "Inspect live capture evidence, candidate endpoints, and next actions for the active session." },
    { name: "sessions", usage: '--domain "..." [--limit N]', desc: "List recent session logs for a domain (debug)." },

    // ── Telemetry ─────────────────────────────────────────────────────────
    { name: "stats", usage: "[--flywheel | --earnings] [--json]", desc: "Lifetime time/tokens/cost saved + marketplace earnings. --flywheel for funnel/index health view, --earnings for credits view. (Replaces separate `flywheel` and `earnings` commands.)" },
  ],

  globalFlags: [
    { flag: "--pretty", desc: "Pretty-print JSON output (indented)." },
    { flag: "--no-auto-start", desc: "Don't auto-spawn the local server if it's down." },
    { flag: "--raw", desc: "Skip post-processing. On fetch: keep HTML/JSON bytes (no markdown). On resolve/execute: skip server-side projection." },
    { flag: "--skip-browser", desc: "setup: skip browser-engine install." },
    { flag: "--opencode auto|global|project|off", desc: "setup: install /unbrowse command for Open Code." },
  ],
  resolveExecuteFlags: [
    { flag: "--no-execute", desc: "Resolve only; return shortlist without auto-executing." },
    { flag: "--schema", desc: "Show response schema + extraction hints (no data)." },
    { flag: '--path "data.items[]"', desc: "Drill into the result before extract/output." },
    { flag: '--extract "field1,alias:deep.path"', desc: "Pick specific fields (no piping)." },
    { flag: "--limit N", desc: "Cap array output to N items." },
    { flag: "--endpoint ID", desc: "Pick a specific endpoint by ID. (Alias: --endpoint-id.)" },
    { flag: "--dry-run", desc: "Preview mutations without applying." },
    { flag: "--params '{...}'", desc: "Extra params as JSON." },
    { flag: "-p key=val", desc: "Single param via repeated flag (alternative to --params JSON)." },
    { flag: "--require-proof", desc: "Filter resolve to only endpoints with independently verified proofs." },
  ],
  envVars: [
    { name: "UNBROWSE_URL", desc: "Compatibility server URL. When unset, the CLI uses the in-process stateless runtime." },
    { name: "UNBROWSE_API_URL", desc: "Marketplace/backend URL (default: https://beta-api.unbrowse.ai)" },
    { name: "UNBROWSE_ZK_PROOF=1", desc: "Enable commitment metadata generation helpers" },
    { name: "UNBROWSE_NOTARY_URL=<url>", desc: "Reserved for future TLSNotary integration; current client is a stub" },
    { name: "HEADLESS=false", desc: "Show browser window (dev/auth flows only; production always headless)" },
  ],
  fetchFlags: [
    { flag: "--raw", desc: "Keep HTML/JSON bytes; skip turndown markdown conversion." },
    { flag: "--no-browser-cookies", desc: "Skip auto-pulling cookies from your real Chrome/Arc/Brave/Edge/Vivaldi/Opera/Dia session." },
    { flag: "--method GET|POST|PUT|DELETE|...", desc: "HTTP method (default GET)." },
    { flag: "--header 'K: V'", desc: "Extra request header (single use)." },
    { flag: "--timeout-ms N", desc: "Request timeout in ms (default 30000)." },
    { flag: "--impersonate chrome131|chrome120|firefox120|...", desc: "TLS fingerprint impersonation target (default chrome131)." },
    { flag: "--proxy", desc: "Route the libcurl-impersonate call through the IPRoyal residential proxy. Requires IPROYAL_USER + IPROYAL_PASS env vars (optionally IPROYAL_HOST / IPROYAL_PORT for country-locked endpoints)." },
    { flag: "--publish", desc: "Explicitly publish observed routes to the marketplace." },
    { flag: "--intent \"...\"", desc: "Label for explicit marketplace publish of observed routes." },
    { flag: "--envelope", desc: "Force full envelope output (cookies + routes_observed + post_eval) instead of body-only." },
    { flag: "--bundle-source <js|->", desc: "ADVANCED: inline JS or '-' for stdin. Runs through the embedded browser/sandbox primitive." },
    { flag: "--bundle-url <url>", desc: "ADVANCED: fetch JS bundle from URL." },
    { flag: "--post-eval <expr>", desc: "ADVANCED: JS expression evaluated after bundle runs (e.g. globalThis.signedUrl)." },
    { flag: "--target-origin <url>", desc: "ADVANCED: origin used for cookie scoping. Defaults to fetch URL's origin." },
    { flag: "--target-href <url>", desc: "ADVANCED: page href the bundle thinks it's on." },
  ],
  examples: [
    "# Just give me the URL contents:",
    '  unbrowse fetch https://api.github.com/repos/oven-sh/bun',
    "",
    "# JSON without markdown conversion:",
    '  unbrowse fetch https://api.example.com/data --raw',
    "",
    "# Resolve an intent with auto-execute:",
    '  unbrowse resolve --intent "top stories" --domain "news.ycombinator.com" --pretty',
    "",
    "# Resolve metadata only, then execute explicitly:",
    '  unbrowse resolve --intent "top stories" --url "https://news.ycombinator.com" --no-execute',
    '  unbrowse execute --skill <id> --endpoint <id> --pretty',
    "",
    "# Live-browser capture with retries:",
    '  unbrowse capture --url https://example.com/listing --intent "list items" --retries 3',
    "",
    "# Browse session for forms / interactive flows:",
    '  unbrowse go https://www.mandai.com/en/ticketing/admission-and-rides/parks-selection.html',
    "  unbrowse snap --filter interactive",
    "  unbrowse click e5",
    '  unbrowse submit --wait-for "/time-selection.html"',
    "  unbrowse close",
    "",
    "# Sign into a site so future fetches have cookies:",
    '  unbrowse auth-capture --url https://x.com/login',
    "",
    "# Marketplace contribution flow:",
    '  unbrowse skill <id>',
    '  unbrowse review --skill <id> --endpoints \'[{...}]\'',
    "  unbrowse publish --skill <id> --confirm-publish",
    "",
    "# Telemetry:",
    "  unbrowse stats               # default summary",
    "  unbrowse stats --flywheel    # funnel + index health",
    "  unbrowse stats --earnings    # credits view",
  ],
};

// ---------------------------------------------------------------------------
// Deprecated verbs — one registry, one notice.
//
// The runtime is in-process and the route contracts live server-side, so the
// daemon-era management verbs (serve/stop/restart/status) have nothing to
// manage, and several local utilities were folded into a canonical verb. A
// deprecated verb is not removed mid-flight: it prints ONE consistent notice
// pointing at the canonical path and then either forwards (grace period) or,
// for the daemon verbs that have no successor, stops cleanly instead of
// dropping to a confusing "Unknown command".
// ---------------------------------------------------------------------------
function printHelp(): void {
  // Three-verb collapse: the public CLI is `unbrowse <build|breath|eval>
  // <capability> [flags]` — no flat commands, no daemon. Help reflects that
  // surface only; the per-capability detail lives behind `unbrowse <verb>
  // --help` (KIND_MAP, the single source of truth). Written to STDOUT (help is
  // requested, not an error).
  const lines: string[] = [
    "unbrowse — agent-native internet action engine (in-process stateless runtime)",
    "",
    "The public CLI is three verbs:",
    "  build   Declare patterns — skills, templates, value-sources (declarative ops).",
    "  breath  Animate the runtime — go, fetch, get, click, fill, submit, execute (side-effectful ops).",
    "  eval    Observe — resolve, snap, search, inspect, status, version (read-only ops).",
    "",
    "Usage: unbrowse <build|breath|eval> <capability> [--flag value ...]",
    "       unbrowse <verb> --help        list a verb's capabilities",
    "       unbrowse eval status           local runtime health",
    "       unbrowse eval version          build info + signing identity",
    "",
    "Runtime: every call runs in the in-process stateless runtime — no local",
    "daemon is auto-spawned. `unbrowse breath serve` is the only explicit",
    "foreground compatibility daemon; everything else is stateless.",
    "",
    "Quick paths:",
    "  Resolve an intent          → unbrowse eval resolve --intent \"...\" [--url <url>]",
    "  Fetch a URL's contents     → unbrowse breath fetch <url>",
    "  One-hole read/search       → unbrowse breath get \"task\" [--url <url>] [--mode auto|data|chooser]",
    "       --mode (default auto) forces the post-capture switch: data=always the page/result payload, chooser=always the available_operations list",
    "  Real DOM (forms, clicks)   → unbrowse breath go <url>  (then eval snap, breath click/submit/close)",
    "  Sign in to a site          → unbrowse breath auth <url>",
    "",
    "Browse session sequence (when you need a real DOM):",
    "  1. breath go <url>      acquire a binary-owned browser lease + open a tab",
    "  2. eval snap            a11y snapshot with @eN refs",
    "  3. breath click/fill/type/select   set page state",
    "  4. breath submit        DOM submit; --wait-for to confirm next page",
    "  5. breath sync          checkpoint (keeps tab open) — queues background index + publish",
    "  6. breath close         final checkpoint + close session",
    "",
    "Marketplace flow (after capture):",
    "  eval resolve                       executes top safe GET (default behavior)",
    "  eval resolve --no-execute          returns ranked shortlist (when you want to choose)",
    "  breath execute --skill <id> --endpoint <id>   explicit pick",
    "  build publish --skill <id> --confirm-publish  contribute back to the marketplace",
    "",
    "Global flags:",
    "  --json     Single-line JSON stdout (no pretty).",
    "  --pretty   Force pretty 2-space JSON stdout.",
    "  --help     Print this help (or, after a verb, that verb's capabilities).",
    "",
    "Run `unbrowse <verb> --help` for the full capability list.",
    "",
    "Learn more (the WHAT behind the runtime — read the papers for the rest):",
    "  How it pays   https://unbrowse.ai/how-unbrowse-pays   per-use x402 micropayments; bind a wallet to a domain you own to earn the owner share (paper: Unbrowse Maintenance Network)",
    "  Privacy       https://unbrowse.ai/privacy             credentials bound to your wallet by zero-knowledge proof, revealed only under signature (paper: Crypto Was All You Needed)",
    "  Papers        https://unbrowse.ai/papers",
    "",
  ];

  process.stdout.write(lines.join("\n") + "\n");
}

export async function cmdInspect(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const explicitSession = typeof flags.session === "string"
    ? flags.session
    : typeof args[0] === "string"
      ? args[0]
      : undefined;
  const sessions = await api("GET", "/v1/browse/sessions") as {
    sessions?: Array<Record<string, unknown>>;
    count?: number;
    latest_session_id?: string | null;
  };
  if (flags.all) {
    output(sessions, !!flags.pretty);
    return;
  }

  const latestSessionId = sessions.latest_session_id
    ?? (sessions.sessions?.at(-1)?.session_id as string | undefined);
  const sessionId = explicitSession ?? latestSessionId;
  if (!sessionId) {
    output({
      error: "no_active_session",
      message: "No active browse session to inspect.",
      next_action: {
        title: "Open a browser session",
        command: 'unbrowse go "https://example.com" --pretty',
        why: "Inspection reads live HAR/interceptor evidence from an active Kuri session.",
      },
    }, !!flags.pretty);
    return;
  }

  output(await api("GET", `/v1/browse/sessions/${encodeURIComponent(sessionId)}/buffer`), !!flags.pretty);
}

export async function cmdUpgrade(flags: Record<string, string | boolean>): Promise<void> {
  const hintOnly = !!flags["hint-only"];
  if (!hintOnly) info("Checking for updates...");

  try {
    const result = await checkForUpdates(import.meta.url, { force: !hintOnly });
    if (!result.latest) {
      if (!hintOnly) info("Could not check for updates right now.");
      return;
    }

    if (!result.has_update) {
      if (!hintOnly) info(`Already at latest version: ${result.installed}`);
      return;
    }

    info(`Update available: ${result.installed} -> ${result.latest}`);
    // Always attempt the background auto-apply (throttled + guarded inside): for an
    // npm-global install this spawns a detached reinstall that takes effect next run,
    // so the client keeps itself current. This is the path the SessionStart hook
    // (`upgrade --hint-only`) drives, so update is silent + automatic. Opt out with
    // UNBROWSE_NO_AUTO_UPDATE=1; repo clones + CI fall back to the printed command.
    const { maybeAutoUpdate } = await import("./runtime/update-hints.js");
    const applied = await maybeAutoUpdate(import.meta.url);
    if (applied.applied) {
      info(`Auto-updating in the background: ${applied.from} -> ${applied.to} (takes effect next run).`);
    } else {
      info(`Run: ${result.command}`);
    }
    if (!hintOnly) {
      info("Tip: `unbrowse setup` now installs session-start update hints for Codex and Claude when those hosts are present.");
    }
    recordUpdateHint(result.latest);
  } catch (err) {
    if (!hintOnly) info(`Could not check for updates: ${(err as Error).message}`);
  }
}

export async function cmdMcp(flags: Record<string, string | boolean>): Promise<void> {
  const entrypoint = resolveSiblingEntrypoint(import.meta.url, "mcp");
  const childArgs = isBundledVirtualEntrypoint(entrypoint)
    ? ["mcp-serve", ...(flags["no-auto-start"] ? ["--no-auto-start"] : [])]
    : [...runtimeArgsForEntrypoint(import.meta.url, entrypoint), ...(flags["no-auto-start"] ? ["--no-auto-start"] : [])];
  const child = spawn(
    process.execPath,
    childArgs,
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        MCP_SERVER_MODE: "1",
      },
    },
  );

  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(exitCode ?? 1);
    });
  });

  if (code !== 0) process.exit(code);
}

// Explicit long-lived foreground server. The user controls lifetime via
// SIGINT/SIGTERM — the idle reaper is disabled unless they opt in. Extracted
// verbatim from the inline `serve` dispatch so verb handlers can import it.
export async function cmdServe(flags: Record<string, string | boolean>): Promise<void> {
  // Explicit long-lived foreground server. The user controls lifetime via
  // SIGINT/SIGTERM — disable the idle reaper unless they opt in.
  process.env.UNBROWSE_SERVE_IDLE_MS = process.env.UNBROWSE_SERVE_IDLE_MS ?? "0";
  // Not MCP-spawned; clear the flag so logger/ToS behave as a normal daemon.
  delete process.env.MCP_SERVER_MODE;
  const { startUnbrowseServer, installServerExitCleanup } = await import("./server.js");
  const server = await startUnbrowseServer({ logger: true });
  console.log(`[serve] listening on http://${server.host}:${server.port}`);
  installServerExitCleanup();
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    try { await server.close({ shutdownBrowsers: true }); } catch {}
    const code = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 0;
    process.exit(code);
  };
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  // Block forever — Fastify's listener keeps the loop alive, but be explicit.
  await new Promise<void>(() => {});
  return;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function cmdGet(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const parsed = parseCmdGetArgs(args, flags);
  if ("error" in parsed) die(parsed.error);
  if (parsed.url) return cmdRun([], { ...flags, url: parsed.url, intent: parsed.intent }, "get");
  return cmdSearch({ ...flags, intent: parsed.intent });
}

export async function cmdEval(args: string[], flags: Record<string, string | boolean>): Promise<void> {
  const expression = args.join(" ");
  if (!expression) die("Usage: unbrowse eval <expression>");
  output(await api("POST", "/v1/browse/eval", {
    expression,
    ...(typeof flags.session === "string" ? { session_id: flags.session } : {}),
  }), !!flags.pretty);
}

export async function cmdBack(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("POST", "/v1/browse/back", typeof flags.session === "string" ? { session_id: flags.session } : undefined), false);
}

export async function cmdForward(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("POST", "/v1/browse/forward", typeof flags.session === "string" ? { session_id: flags.session } : undefined), false);
}

export async function cmdSync(flags: Record<string, string | boolean>): Promise<void> {
  output(await api("POST", "/v1/browse/sync", typeof flags.session === "string" ? { session_id: flags.session } : undefined), !!flags.pretty);
}

// ---------------------------------------------------------------------------
// register — opt-in registration for publishing, earnings, and backend analytics
// ---------------------------------------------------------------------------

export async function cmdRegister(flags: Record<string, unknown>) {
  const reset = flags.reset === true || flags.force === true || flags["reset-key"] === true;
  const previousConfig = reset ? loadConfig() : null;
  let ignoredEnvApiKey = false;
  const stopServerAfterReset = () => {
    if (!reset) return;
    if (stopServer(BASE_URL)) {
      info("Stopped local server so the next command starts with the fresh key.");
    }
  };
  if (reset) {
    const envKey = process.env.UNBROWSE_API_KEY?.trim();
    const result = resetLocalRegistration();
    delete process.env.UNBROWSE_API_KEY;
    if (envKey) {
      ignoredEnvApiKey = true;
      process.env.UNBROWSE_IGNORE_ENV_API_KEY = "1";
    }
    info(`${result.removed ? "Removed" : "No"} local API key cache at ${result.config_path}.`);
    if (envKey) {
      info("Ignoring UNBROWSE_API_KEY for this reset run. Future Unbrowse commands will prefer the fresh saved key; still remove or update that env var in your shell.");
    }
    if (typeof flags.email !== "string" && previousConfig?.email) {
      flags.email = previousConfig.email;
    }
  }

  if (typeof flags.email === "string" && flags.email.length > 0) {
    const email = flags.email;
    if (!reset && getApiKey()) {
      info("Already registered. Re-running with --email will mint a new key and overwrite ~/.unbrowse/config.json.");
    }
    info(`Sending magic link to ${email}…`);
    const result = await magicRegister({
      email,
      openBrowser: (url) => {
        info(`Opening browser: ${url}`);
        try {
          const cmd = process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "start"
              : "xdg-open";
          spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
        } catch { /* best-effort; user can copy/paste */ }
      },
    });
    saveConfig({
      api_key: result.api_key,
      agent_id: result.agent_id,
      agent_name: result.email,
      registered_at: new Date().toISOString(),
      tos_accepted_version: null,
      tos_accepted_at: null,
      email: result.email,
      user_id: result.user_id,
      ...(ignoredEnvApiKey ? { ignore_env_api_key: true } : {}),
    });
    process.env.UNBROWSE_API_KEY = result.api_key;
    info(`Signed in as ${result.email}. API key saved to ~/.unbrowse/config.json.`);
    info("Open your dashboard:");
    info("  unbrowse dashboard");
    // Mirror server-side preference into local contribution block so the
    // capture pipeline picks it up. Best-effort — never blocks register.
    try {
      const serverPrefs = await fetchAccountPreferences();
      if (serverPrefs) {
        setContributionConfig({
          contribution: { share_pointers: serverPrefs.share_pointers, set_via: "mode-command" },
        });
        info(`Auto-publish to marketplace: ${serverPrefs.share_pointers ? "ON" : "off"} (synced from your account).`);
      }
    } catch { /* best-effort */ }
    stopServerAfterReset();
    return;
  }
  if (!reset && getApiKey()) {
    info("Already registered. API key loaded from env or ~/.unbrowse/config.json");
    return;
  }
  await ensureRegistered({ promptForEmail: !flags["no-prompt"], exitOnFailure: false });
  if (getApiKey()) {
    // Honest: a key is minted, but publishing also depends on the share_pointers gate
    // (auto-publish can be off) and earnings require an attached wallet (L1 anon has
    // none). Don't claim "you can now publish + earn" unconditionally — point to the
    // command that shows the real state instead of overstating capability.
    info("Registration complete — API key saved. Run `unbrowse account` to see publish/earnings status (publishing needs sharing on; earnings need an attached wallet).");
    stopServerAfterReset();
  } else {
    info("Registration skipped or failed. Unbrowse still works locally — publish/earnings are disabled.");
  }
}

export async function cmdConnectChrome(): Promise<void> {
  const { execSync, spawn: spawnProc } = require("child_process");
  
  // Check if Chrome already has CDP
  try {
    const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1000) });
    if (res.ok) {
      const data = await res.json() as { "User-Agent"?: string };
      if (!data["User-Agent"]?.includes("Headless")) {
        console.log("Your Chrome is already connected with CDP on port 9222.");
        console.log("Browse commands will use your real browser with all your sessions.");
        return;
      }
    }
  } catch { /* not running */ }

  // Kill any Kuri-managed Chrome
  try { execSync("pkill -f kuri/chrome-profile", { stdio: "ignore" }); } catch {}

  // Quit Chrome fully — can't add debugging port to running instance
  console.log("Quitting Chrome to relaunch with remote debugging...");
  if (process.platform === "darwin") {
    try { execSync('osascript -e "quit app \\"Google Chrome\\""', { stdio: "ignore", timeout: 5000 }); } catch {}
  } else {
    try { execSync("pkill -f chrome", { stdio: "ignore" }); } catch {}
  }
  await new Promise(r => setTimeout(r, 2000));

  console.log("Launching Chrome with remote debugging on port 9222...");
  if (process.platform === "darwin") {
    spawnProc("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", 
      ["--remote-debugging-port=9222", "--no-first-run", "--no-default-browser-check"],
      { stdio: "ignore", detached: true }).unref();
  } else {
    spawnProc("google-chrome", ["--remote-debugging-port=9222"], { stdio: "ignore", detached: true }).unref();
  }

  // Wait for CDP
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        console.log("Connected. Your real Chrome is now available for browse commands.");
        console.log("All your logged-in sessions (LinkedIn, X, etc.) will work.");
        console.log('Run: unbrowse go "https://linkedin.com/feed/"');
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  console.error("Could not connect to Chrome. Make sure all Chrome windows are closed and try again.");
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  let { command, args, flags } = parsed;
  const cliParams = parsed.params;

  // Usage ping — the "is anyone using it?" signal the retired session store no
  // longer captures. One fire-and-forget ping per invocation (skips help/internal
  // verbs); opt-out-respecting, never blocks the command.
  if (command && command !== "help" && !command.startsWith("__")) {
    void reportUsage(command);
  }

  // Proxy resilience: a dead/flaky residential-proxy upstream wired into KURI_PROXY otherwise
  // bricks EVERY browser capture (ERR_PROXY_CONNECTION_FAILED → a chrome-error:// page) with no
  // fallback. For commands that drive the browser, probe the proxy first and fall back to DIRECT
  // egress when it can't be reached — so the capture survives instead of returning an error page.
  const BROWSE_COMMANDS = new Set([
    "get", "go", "run", "capture", "fetch", "snap", "click", "fill", "type", "press", "select",
    "scroll", "submit", "screenshot", "text", "markdown", "cookies", "eval", "back", "forward",
    "sync", "close", "inspect", "auth", "auth-capture", "login", "resolve", "execute", "explain",
    "create", "act", "read",
  ]);
  if (process.env.KURI_PROXY && BROWSE_COMMANDS.has(command)) {
    try {
      const probe = await ensureKuriProxyReachable();
      if (probe.unwired) {
        console.error(`[kuri-proxy] proxy ${probe.target} unreachable — falling back to direct egress`);
      }
    } catch { /* probe is best-effort; never block a command on it */ }
  }
  // Agent-UX / contract-harness invariant: when stdout is MACHINE-CONSUMED
  // (piped to an agent/subprocess, or explicit --json), it MUST carry ONLY the
  // payload. Every payload is emitted via process.stdout.write (output() and the
  // snap/text/markdown/billing/contract handlers), so it is immune to this
  // reroute. All console.log/info/warn is diagnostic chatter
  // ([trace]/[perf]/[lifecycle]/[exa]/[probe]/…) → send it to stderr so a naive
  // `unbrowse resolve … | jq` works without --json. A human at a TTY still sees
  // the chatter inline (no reroute when stdout is a TTY).
  if (flags.json || !process.stdout.isTTY) {
    const _stderrLog = (...rest: unknown[]) => process.stderr.write(rest.map(String).join(" ") + "\n");
    console.log = _stderrLog;
    console.info = _stderrLog;
    console.warn = _stderrLog;
  }
  if (command === "browse") {
    const subcommand = args.shift();
    if (!subcommand || subcommand === "help") {
      printHelp();
      process.exit(subcommand === "help" ? 0 : 1);
    }
    command = subcommand;
  }

  if (command === "__drain-queue") {
    try {
      const queueDir = _getQueueDir();
      const { tryAcquireWorkerSlot } = await import("./lib/indexer-core/queue-store.js");
      // Phase 1.1 Day 5 (Model B): child holds the slot for its lifetime.
      // If another worker already holds it, exit cleanly — the sibling drains.
      const slot = await tryAcquireWorkerSlot(queueDir);
      if (slot === null) {
        process.exit(0);
      }
      try {
        const { drainUntilEmpty } = await import("./lib/indexer-core/worker.js");
        const { _processIndexJobForCli } = await import("./lib/indexer-core/index.js");
        // Two-lane drain, one worker slot: capture-pending FIRST so any
        // reconstructed BackgroundIndexJob lands in `pending/` and is
        // processed in the same worker lifetime (no second spawn needed).
        // Failure here never blocks the legacy pending drain.
        try {
          const { drainCaptureSpoolOnce } = await import("./lib/indexer-core/capture-spool.js");
          const { makeCaptureSpoolProcessor } = await import("./lib/indexer-core/capture-spool-bridge.js");
          const captureDir = _getCaptureSpoolDir();
          let totalProcessed = 0;
          // Drain in a loop until idle so envelopes that produced new pending
          // jobs all flow through before we switch lanes.
          for (;;) {
            const r = await drainCaptureSpoolOnce(captureDir, makeCaptureSpoolProcessor());
            totalProcessed += r.processed;
            if (r.processed === 0 && r.failed === 0) break;
          }
          if (totalProcessed > 0) {
            console.error(`[__drain-queue] capture-pending: drained ${totalProcessed} envelope(s)`);
          }
        } catch (err) {
          console.error(`[__drain-queue] capture-pending pass failed: ${(err as Error)?.message ?? err}`);
        }
        await drainUntilEmpty(queueDir, _processIndexJobForCli);
      } finally {
        await slot();
      }
      process.exit(0);
    } catch (err) {
      console.error(`[__drain-queue] error: ${(err as Error)?.message ?? err}`);
      process.exit(1);
    }
  }

  _maybeSweepQueue().catch(() => {});

  // Keep the CLI current for EVERY user: on a normal command, spawn a fully
  // detached self-update checker (throttled, opt-out-aware) that fetches
  // npm-latest and applies it in its own background process. Never blocks or
  // slows this command; the update lands on the next invocation. Self-update,
  // fast (health), and daemon (mcp/serve) commands are skipped inside.
  try { maybeSpawnBackgroundUpdateCheck(import.meta.url, command); } catch { /* never break the command */ }

  // Stash CLI -p key=val params on flags object so command handlers can read them.
  if (Object.keys(cliParams).length > 0) {
    (flags as Record<string, unknown>)._params = cliParams;
  }
  // ── Hard break: the public CLI is three verbs only ─────────────────
  // `unbrowse <build|breath|eval> <capability> [flags]`. No flat commands,
  // no create/act/read aliases, no swallow-as-intent, no daemon auto-spawn.
  // Verb capabilities dispatch in-process via the cli-v7 routers (each
  // handler reuses the real cmd* logic still defined in this module).
  // Routed BEFORE the global --help so `<verb> <cap> --help` shows the
  // capability-specific help, not the general banner.
  if (command === "build" || command === "breath" || command === "eval") {
    const { runV7 } = await import("./cli-v7/index.js");
    await runV7(process.argv);
    return;
  }

  // Process-launcher entrypoints survive the three-verb collapse. `mcp` and
  // `serve` are not flat capability shortcuts — they are long-lived process
  // launchers that EXTERNAL machine configs hardcode (MCP host configs spawn
  // `unbrowse mcp`; the compatibility daemon is `unbrowse serve`). Purging them
  // would silently break every installed Claude/Cursor MCP integration on
  // upgrade with no way for us to rewrite those configs, so they forward to
  // their canonical `breath` capability. Every other flat token is rejected
  // below.
  if (command === "mcp" || command === "serve") {
    const { runV7 } = await import("./cli-v7/index.js");
    await runV7([process.argv[0], process.argv[1], "breath", ...process.argv.slice(2)]);
    return;
  }

  if (command === "help" || flags.help || !command) {
    printHelp();
    process.exit(0);
  }

  // Flat legacy command → its verb (build/breath/eval). Without this, every flat
  // command (settings/fetch/search/skills/spec/explain/account/dashboard/...) falls
  // through to the one-hole `breath get` path below and is run as a web-search/
  // capture INTENT — the KNOWN_COMMANDS-drift misroute (`unbrowse settings` would
  // browser-capture duckduckgo/settings). flatCommandVerb is derived from KIND_MAP
  // so it cannot drift; a genuine natural-language intent returns null and falls
  // through to `get`.
  const flatVerb = flatCommandVerb(command);
  if (flatVerb) {
    const { runV7 } = await import("./cli-v7/index.js");
    await runV7([process.argv[0], process.argv[1], flatVerb, command, ...process.argv.slice(3)]);
    return;
  }

  // /contract merged into the root: a contract-grammar leading token
  // (`unbrowse "satisfied:<id> — proof"`, `"died:<id> …"`, `"status:<id>"`) routes to
  // the goal-only contract handler — no separate `contract` subcommand needed. A plain
  // TASK goal returns false here and falls through to `breath get` below, which
  // resolves+executes AND auto-declares (resolve ≡ declare), so a task is ALSO a contract.
  if (looksLikeContractGoal(process.argv[2] ?? "")) {
    const { runV7 } = await import("./cli-v7/index.js");
    await runV7([process.argv[0], process.argv[1], "eval", "contract", ...process.argv.slice(2)]);
    return;
  }

  // Bare natural-language intent — the headline front door. `unbrowse "find X"`
  // (any first token that is not a verb, launcher, or flat command) routes to the
  // one-hole `breath get` path, which figures out the rest on its own: web
  // search, direct fetch, route-graph replay, adapter, browser capture, cookies/
  // HAR, and indexing. The structured verbs (build/breath/eval) stay the
  // explicit surface; this is the "just tell it what you want" path. The hole
  // parser (parseCmdHoleIntentArgs) already accepts `"task"`, `<url> "task"`,
  // and `"task" --url <url>`, so we forward argv verbatim and let it decide.
  const { runV7 } = await import("./cli-v7/index.js");
  await runV7([process.argv[0], process.argv[1], "breath", "get", ...process.argv.slice(2)]);
  return;
}

if (isMainModule(import.meta.url)) {
  // build/breath/eval dispatch in-process via runV7, which owns its own
  // lifecycle/drain — skip this module's exit drains for them (matches the
  // old canonical-verb fast-exit that avoided a double drain / hang).
  const v7Invocation = process.argv[2] === "build" || process.argv[2] === "breath" || process.argv[2] === "eval";
  // Drains run on best-effort terms. A stalled background job MUST NOT
  // hang CLI exit — same bug class as the previously-fixed inline
  // telemetry await (project_cli_resolve_exit_hang). Both drains race
  // against a short timeout; if a drain doesn't settle, the CLI exits
  // anyway and the pending work resumes in the next invocation.
  const exitDrainBudgetMs = Math.max(
    250,
    Number.parseInt(process.env.UNBROWSE_EXIT_DRAIN_BUDGET_MS ?? "1500", 10) || 1500,
  );
  const drainWithTimeout = (label: string, p: Promise<void>): Promise<void> =>
    Promise.race([
      p,
      new Promise<void>((resolve) => setTimeout(() => {
        process.stderr.write(`[exit] ${label} drain exceeded ${exitDrainBudgetMs}ms budget — exiting anyway\n`);
        resolve();
      }, exitDrainBudgetMs)),
    ]);

  main()
    .then(() => v7Invocation
      ? undefined
      : Promise.all([
          drainWithTimeout("index-jobs", drainPendingIndexJobs()),
          drainWithTimeout("passive-publishes", drainPendingPassivePublishes()),
        ]))
    .then(() => {
      // Drain promises resolve when budget elapses, but underlying async
      // work (sockets, timers, kept-alive connections) can keep the event
      // loop alive past the budget. The comment above says "exits anyway"
      // — make that literally true. Bench probes were SIGKILLed at 90s
      // because this exit never fired.
      // Honor a command-set exit code (e.g. `fetch` sets process.exitCode=1 on
      // a 404 / network failure). A bare exit(0) here silently swallowed it, so
      // an agent/script could not detect failure via the exit status.
      process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
    })
    .catch((err) => {
      die((err as Error).message);
    });
}
