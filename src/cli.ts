#!/usr/bin/env bun
/**
 * Unbrowse CLI — shell-safe wrapper for the local API.
 * Eliminates curl + jq escaping issues. All JSON is constructed
 * and parsed in TypeScript, never through shell interpolation.
 *
 * Usage: unbrowse <command> [flags]
 */

import { config as loadEnv } from "dotenv";
import { indexableReason } from "./capture/indexable.js";
import { nanoid } from "nanoid";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { extractEmbeddedJsonBody, inferWriteMethod } from "./lib/infer-write-method.js";
import { extractAuthHeader } from "./lib/extract-auth-header.js";
import { bridgeKuriProxyEnv, kuriProxyTraceEnabled, ensureKuriProxyReachable } from "./env/kuri-proxy-bridge.js";
import { KIND_MAP, flatCommandVerb, looksLikeContractGoal, nearestFlatCommands } from "./cli-v7/kind-map.js";
import { peekResolution, storeResolution } from "./values/cached-resolution.js";
import { resolutionContractVerdict } from "./values/resolution-contract.js";
import { resolutionCardinalityMatches, resolutionHostMatches, resolutionPathMatches } from "./values/cardinality.js";
import { requestCacheKey, isIdempotentRequest } from "./values/cache-key.js";
import { cmdCookies } from "./cli-cookies.js";
import { cmdWallet } from "./cli-wallet.js";
import { dispatchByKind } from "./cli-v7/dispatch/index.js";
import { reportUsage } from "./telemetry/issue.js";
import {
  detectTelemetryHostType,
  ensureCliInstallTracked,
  ensureRegistered,
  buildDashboardPairingUrl,
  createDashboardPairingToken,
  isDashboardPairingTokenPending,
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
import { recordCreativityActFromExecute } from "./values/creativity-economy.js";
import { computeResolveDeadlineMs } from "./resolve-deadline.js";
import { stopServer } from "./runtime/local-server.js";
import { getInProcessApp } from "./runtime/in-process-app.js";
// isBundledVirtualEntrypoint / resolveSiblingEntrypoint / runtimeArgsForEntrypoint
// were only ever used to build the argv for the MCP child process. cmdMcp now
// imports the server in-process, so there is no child to locate. They remain
// exported from runtime/paths.ts for other callers.
import { getUnbrowseHome, shouldAutoRunCliMain } from "./runtime/paths.js";
import { buildErrorEnvelope } from "./values/error-envelope.js";
import { learnedSkillOutranksCachedDocument } from "./values/internal-api-precedence.js";
import { validateTargetUrl } from "./values/target-url.js";
import { drainPendingIndexJobs } from "./lib/indexer-core/index.js";
import { drainPendingPassivePublishes } from "./orchestrator/passive-publish.js";
import { isEvidenceBackedReadEndpoint } from "./orchestrator/action-dag.js";
import { tryDirectJsonFetch, urlLooksLikeJsonApi } from "./orchestrator/index.js";
import { runSetup, type SetupReport, type SetupScope } from "./runtime/setup.js";
import { checkForUpdates, maybeSpawnBackgroundUpdateCheck, recordUpdateHint } from "./runtime/update-hints.js";
import { directAuthorizedRead } from "./runtime/browser-access.js";
import { agentPathHelpLines } from "./agent-path.js";
import { finalizeFrontDoorResult, runHarnessInvocation } from "./harness/front-door.js";
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

// U-3: all three read the data root. They decide whether a background drainer
// is needed, so pointing them at the caller's REAL home under an isolated run
// makes an isolated process act on the developer's queue.
function _getQueueDir(): string {
  return _joinForQueue(getUnbrowseHome(), "queue", "pending");
}
function _getCaptureSpoolDir(): string {
  return _joinForQueue(getUnbrowseHome(), "queue", "capture-pending");
}
function _getHeartbeatPath(): string {
  return _joinForQueue(getUnbrowseHome(), "queue", ".heartbeat");
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
  if ((await _dirHasJobs(_getQueueDir())) || (await _dirHasJobs(_getCaptureSpoolDir()))) return true;
  // Also cover SIGKILL in the tiny DurableJobStore.create -> queue rename
  // window: no legacy envelope exists yet, but the next CLI must still spawn
  // a worker so it can reconstruct that orphan.
  const { hasRunningDurableIndexJobs } = await import("./lib/indexer-core/durable-index-jobs.js");
  return hasRunningDurableIndexJobs(_getQueueDir());
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
        "impersonate", "origin", "bundle", "eval", "header", "bearer-token",
      ]);
      // Flags that NEVER consume the next arg, even if it doesn't start with --.
      // Lets `unbrowse fetch --proxy https://httpbin.org/ip` parse correctly
      // with the URL as positional and --proxy as a boolean toggle.
      const booleanOnlyFlags = new Set([
        "proxy", "raw", "pretty", "envelope", "stdin",
        "no-browser-cookies", "publish", "no-start", "skip-browser",
        "no-claude-register", "no-auto-start", "no-open", "register",
        "reset-key", "help", "fresh", "no-cache", "account", "no-hold",
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

export interface CliUsageDimensions {
  verb: string;
  /** Fixed op-kind from KIND_MAP. It never contains argv values or task text. */
  operation: string;
}

/**
 * Classify an invocation for privacy-safe telemetry. Unknown tokens are the
 * natural-language one-hole path, so they are recorded as `breath:get` rather
 * than persisting the user's task. Structured and flat commands both resolve
 * through KIND_MAP so the category cannot accidentally include arguments.
 */
export function cliUsageDimensions(command: string, args: string[]): CliUsageDimensions {
  const normalized = command.trim().toLowerCase();
  const commandAndArgs = normalized === "browse" && args[0]
    ? { command: args[0].toLowerCase(), args: args.slice(1) }
    : { command: normalized, args };
  const structuredVerb = ["build", "breath", "eval"].includes(commandAndArgs.command)
    ? commandAndArgs.command
    : null;
  const structuredSub = structuredVerb ? commandAndArgs.args[0]?.toLowerCase() : undefined;
  const flatVerb = structuredVerb ? null : flatCommandVerb(commandAndArgs.command);
  const specialVerb = commandAndArgs.command === "health" ? "eval"
    : commandAndArgs.command === "mcp" || commandAndArgs.command === "serve" ? "breath"
      : commandAndArgs.command === "schema" ? "eval"
        : null;
  const verb = structuredVerb ?? flatVerb ?? specialVerb;
  const sub = structuredSub ?? (verb ? (commandAndArgs.command === "health" ? "status" : commandAndArgs.command) : undefined);
  const row = verb && sub
    ? KIND_MAP.find((entry) => entry.verb === verb && (
      entry.subcommand === `${verb} ${sub}` ||
      entry.action === sub ||
      entry.action.replaceAll("_", "-") === sub.replaceAll("_", "-")
    ))
    : undefined;

  if (!row) {
    if (structuredVerb) return { verb: structuredVerb, operation: `${structuredVerb}:${structuredVerb}` };
    return { verb: "get", operation: "breath:get" };
  }
  return {
    verb: row.subcommand.split(" ").at(-1) ?? row.verb,
    operation: row.op_kind,
  };
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
  const nested = result.result as Record<string, unknown> | undefined;
  const trace = result.trace as Record<string, unknown> | undefined;
  return nested?.error as string | undefined
    ?? result.error as string | undefined
    ?? (trace?.success === false
      ? (typeof trace.error === "string" ? trace.error : "execution_failed")
      : undefined);
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
    // `--no-execute` dropped: the flat `resolve` token routes to `eval resolve`
    // (KIND_MAP), which has no execution path, so the flag suppressed nothing.
    // `read` and `--force-capture` are deliberately LEFT ALONE: `unbrowse read
    // resolve` still exits 0, and `--force-capture` is read at cli.ts:938 — this
    // string is handed to an agent as `next_action.command`, so changing tokens
    // whose behaviour has not actually been established is the wrong trade.
    const command = targetUrl
      ? `unbrowse read resolve --intent ${shellQuote(args.intent)} --url ${shellQuote(targetUrl)} --force-capture`
      : `unbrowse read resolve --intent ${shellQuote(args.intent)} --force-capture`;
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
    intent, url, domain,
    autoExecute: flags["no-execute"] !== true && flags.__agent_front_door !== true,
    params: extra,
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

function cachedResolutionHasReadableValue(hit: Record<string, unknown> | null | undefined): boolean {
  const result = hit?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const value = result as Record<string, unknown>;
  if (typeof value.markdown === "string" && value.markdown.trim().length > 0) return true;
  if (typeof value.text === "string" && value.text.trim().length > 0) return true;
  if (typeof value.text_excerpt === "string" && value.text_excerpt.trim().length > 0) return true;
  if (Array.isArray(value.data) && value.data.length > 0) return true;
  if (value.data && typeof value.data === "object") return Object.keys(value.data as Record<string, unknown>).length > 0;
  return false;
}

async function cmdResolve(flags: Record<string, string | boolean>): Promise<void> {
  const intent = (flags.intent ?? flags.task ?? flags.query) as string;
  if (!intent) die("--intent is required. Example: unbrowse resolve --intent 'search github for repos' --url https://github.com");
  const targetUrl = typeof flags.url === "string" ? flags.url : undefined;
  const emitResolved = async (result: Record<string, unknown>): Promise<void> => {
    const finalResult = flags.__agent_front_door === true && targetUrl
      ? (await finalizeFrontDoorResult(result, { intent, url: targetUrl }, { raw: flags.raw === true })).output
      : result;
    output(finalResult, !!flags.pretty);
    if (
      flags.__agent_front_door === true
      && flags.__terminal_exit === true
      && oneHoleTerminalExitCode(finalResult) !== 0
    ) {
      process.exit(1);
    }
  };

  if (targetUrl && flags["force-capture"] !== true && flags.__agent_front_door !== true && isAuthShapedDirectDocumentTask(intent, targetUrl)) {
    const authEnvelope = buildAuthHandoffResolveEnvelope(intent, targetUrl);
    if (authEnvelope) {
      await emitResolved(authEnvelope);
      return;
    }
  }

  // FAST PATH: a fresh resolution-cache hit short-circuits BEFORE the in-process
  // backend boots (~4s) and before any telemetry — warm resolve in ~module-load time.
  // The cached value is the SAME final result the slow path prints, so output is
  // byte-identical. Skipped under stateless / explicit-endpoint / dry-run / force-capture.
  if (resolveCacheSafe(flags)) {
    const cachedHit = peekResolution<Record<string, unknown>>(resolveCacheKeyFor(flags, intent), resolveCacheTtlMs());
    // Cardinality guard (): a list/search intent must not replay a
    // single-item value. A poisoned row (a product detail cached under a list
    // intent) is treated as a miss so the orchestrator recomputes a real list.
    // Host guard (cross-domain misroute): an explicit target URL must not replay a
    // value whose records ALL point to a different host (e.g. a github.com result
    // cached under a reddit.com request) — treat it as a miss so the orchestrator
    // re-resolves against the requested host and the poisoned row self-heals.
    const cachedData = cachedHit ? (cachedHit.result ?? (cachedHit as Record<string, unknown>).data) : undefined;
    const cachedSource = typeof cachedHit?.source === "string" ? cachedHit.source : undefined;
    const replayWouldBeEmptyMarketplaceValue = Boolean(
      targetUrl &&
      cachedSource === "marketplace" &&
      !cachedResolutionHasReadableValue(cachedHit),
    );
    if (
      cachedHit &&
      !replayWouldBeEmptyMarketplaceValue &&
      resolutionCardinalityMatches(intent, cachedData) &&
      resolutionHostMatches(typeof flags.url === "string" ? flags.url : undefined, cachedData) &&
      // Path guard (concrete-resource misroute): an explicit --url naming a concrete
      // resource (e.g. /zen, /users/octocat) must not replay a value whose records are
      // not path-coherent with that exact path — treat as a miss so the literal URL
      // re-resolves. Listing/root URLs are untouched (resolutionPathMatches admits them).
      resolutionPathMatches(typeof flags.url === "string" ? flags.url : undefined, cachedData) &&
      // Stale-document invalidation: a cached direct-document is the OLDER answer
      // once a learned internal API exists for the host (background indexer runs
      // AFTER the first HTML settle). Without this the fast path replayed truncated
      // HTML forever — witnessed on defillama.com. Invalidate BEFORE replay so the
      // next call reaches the API. Pure check via learnedSkillOutranksCachedDocument.
      !learnedInternalApiOutranksCachedDocument(typeof flags.url === "string" ? flags.url : "", cachedHit)
    ) {
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
      await emitResolved(replay);
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
    const autoExecute = !noExecute && flags.__agent_front_door !== true;
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
    if (flags.fresh === true || flags["no-cache"] === true) body.force_capture = true;
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
    async function resolveOnce(message = "Still working. Searching cached routes...", signal?: AbortSignal): Promise<Record<string, unknown>> {
      // CLI guard: never wait longer than the orchestrator's real budget. Floor the
      // outer deadline at the live-capture ceiling so a cold capture isn't abandoned
      // with a false cli_timeout (#838); UNBROWSE_API_TIMEOUT_MS overrides. See
      // computeResolveDeadlineMs (pure + unit-tested in tests/resolve-deadline.test.ts).
      const cliTimeoutMs = computeResolveDeadlineMs(typeof body.budget_ms === "number" ? body.budget_ms : undefined);
      return withPendingNotice(
        api("POST", "/v1/intent/resolve", body, { timeoutMs: cliTimeoutMs, signal }) as Promise<Record<string, unknown>>,
        message,
      );
    }

    let result: Record<string, unknown>;
    if (flags.__agent_front_door === true && targetUrl) {
      const invocation = await runHarnessInvocation(
        { intent, url: targetUrl, effect: "read", workspace_trusted: false },
        (signal) => resolveOnce("Still working. Searching cached routes...", signal),
        {
          timeout_ms: computeResolveDeadlineMs(typeof body.budget_ms === "number" ? body.budget_ms : undefined) + 1_000,
          cancellation_mode: "foreground-only",
        },
      );
      if (invocation.state === "completed") result = invocation.value;
      else if (invocation.state === "blocked") {
        result = { ok: false, status: "permission_blocked", gate: invocation.gate };
      } else {
        throw invocation.error;
      }
    } else {
      result = await resolveOnce();
    }
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
      if (!isEvidenceBackedReadEndpoint(endpoint)) return false;
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
    // Cardinality guard (): never persist a single-item value under a
    // list/search intent — that is exactly the poison the peek above has to reject.
    if (
      resolveCacheSafe(flags) &&
      isResolveSuccessResult(result) &&
      resolutionCardinalityMatches(intent, (result as Record<string, unknown>).result ?? (result as Record<string, unknown>).data)
    ) {
      storeResolution(resolveCacheKeyFor(flags, intent), result, resolveCacheTtlMs());
    }

    await emitResolved(result);
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

/** Remove caller-supplied credentials from upstream bodies that reflect them. */
export function redactReflectedSecrets(text: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets.filter((value) => value.length > 0))]
    .sort((a, b) => b.length - a.length);
  let redacted = text;
  for (const secret of unique) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted;
}

export function directStructuredFallbackBody(text: string): unknown | null {
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Shell truth for the final one-hole envelope. Pure for harnesses/importers. */
export function oneHoleTerminalExitCode(result: Record<string, unknown>): 0 | 1 {
  const nested = result.result && typeof result.result === "object"
    ? result.result as Record<string, unknown>
    : undefined;
  const trace = result.trace && typeof result.trace === "object"
    ? result.trace as Record<string, unknown>
    : undefined;
  const error = result.error ?? nested?.error;
  const blocker = result.blocker ?? nested?.blocker;
  const status = String(result.status ?? nested?.status ?? "");
  if (result.ok === false || trace?.success === false) return 1;
  if (error === true || (typeof error === "string" && error.length > 0)) return 1;
  if (blocker === true || (typeof blocker === "string" && blocker.length > 0)) return 1;
  if (["no_relevant_route", "endpoint_not_found", "no_match", "no_cached_match", "auth_required", "session_expired"].includes(status)) return 1;
  return 0;
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

  // A URL in a NON-first positional (e.g. when leading alias tokens `act go` fell
  // through to `breath get`, so args = ["act","go","https://…"]). Recognize the URL
  // by SHAPE and lift it into the target `url` so it reaches context.url — without
  // this the URL stays buried in the free-text intent, context.url is undefined, and
  // every downstream host-anchor guard (anchorHitsToDomain, pickAnswerHit,
  // shouldAutoWalk, cachedSkillHostMatchesContext) is defeated, letting a different
  // host's cached/web result replay (a github.com skill answering a reddit.com URL).
  // Only when exactly one positional is a URL — an ambiguous multi-URL intent stays
  // free-text. Strip it from the intent so the intent is the task, not the address.
  const urlArgs = args.filter(looksLikeUrl);
  if (urlArgs.length === 1) {
    const rest = args.filter((a) => a !== urlArgs[0]);
    const intent = flagIntent ?? (rest.length > 0 ? rest.join(" ") : undefined);
    if (!intent) return { error: `usage: unbrowse ${verb} <url> "task"` };
    return { url: urlArgs[0], intent };
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

  // Normalize auth phrased in the intent onto the same flag consumed by
  // tryDirectStructuredUrl below. Do not route authenticated reads through
  // cmdFetch: that legacy path is Kuri-backed, while explicit --header and
  // --bearer-token promise direct, read-only HTTPS agency.
  if (url && typeof flags.header !== "string" && typeof flags["bearer-token"] !== "string") {
    const inferredAuthHeader = extractAuthHeader(intent);
    if (inferredAuthHeader) flags.header = inferredAuthHeader;
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
    if (!isEvidenceBackedReadEndpoint(endpoint)) return false;
    if (endpoint.needs_params && Object.keys(extraParams).length === 0) return false;
    return true;
  }

  /**
   * Structural "JSON API leaf" gate for free direct settle — same path shape as
   * orchestrator urlLooksLikeJsonApi (/api/, .json, versioned /vN/resource/…).
   * Never a host allowlist (CLAUDE.md standing rule).
   */
  function isConcreteStructuredUrl(value: string): boolean {
    return urlLooksLikeJsonApi(value);
  }

  async function tryDirectStructuredUrl(): Promise<Record<string, unknown> | null> {
    const explicitAuth = typeof flags.header === "string" || typeof flags["bearer-token"] === "string";
    if (!url || explicitEndpointId || noExecute || (!isConcreteStructuredUrl(url) && !explicitAuth)) return null;
    runPlan.push({ step: "execute", mode: "direct_structured_url", status: "started" });
    const buildResult = (body: unknown, status: number, bytes: number, source = "direct-fetch", cookiesInjected = 0) => ({
      trace: {
        trace_id: nanoid(),
        success: status >= 200 && status < 400,
        status_code: status,
        // Harness/score: skill_id+endpoint_id identify usable JSON path (not browser shell).
        skill_id: source === "direct-fetch" ? "direct-fetch" : source,
        endpoint_id: source === "direct-fetch" ? "direct-fetch" : source,
      },
      result: body,
      timing: { source },
      impact: { source, browser_avoided: true },
      source,
      execute_mode: "direct_api",
      skill_id: source === "direct-fetch" ? "direct-fetch" : undefined,
      endpoint_id: source === "direct-fetch" ? "direct-fetch" : undefined,
      egress_bytes: bytes,
      ...(cookiesInjected > 0 ? { cookies_injected: cookiesInjected } : {}),
    });
    const parseBody = (text: string): unknown => {
      try { return JSON.parse(text); } catch { return text; }
    };
    try {
      // Free HTTP-first settle (before Kuri sandbox): tryDirectJsonFetch does
      // native fetch + curl-impersonate rescue. Covers swapi/spacex-shaped APIs
      // without browser / paid egress.
      if (!explicitAuth && isConcreteStructuredUrl(url)) {
        const early = await tryDirectJsonFetch(url, { timeoutMs: 12_000 });
        if (early && early.data != null) {
          const bytes =
            typeof early.data === "string"
              ? early.data.length
              : JSON.stringify(early.data).length;
          runPlan[runPlan.length - 1] = {
            ...runPlan[runPlan.length - 1],
            status: "complete",
            status_code: 200,
            bytes,
            via: "tryDirectJsonFetch",
          };
          return buildResult(early.data, 200, bytes, "direct-fetch");
        }
      }
      if (explicitAuth) {
        const directHeaders: Record<string, string> = { Accept: "application/json, text/plain;q=0.9, */*;q=0.8" };
        const suppliedSecrets: string[] = [];
        if (typeof flags.header === "string") {
          const rawHeader = flags.header.trim();
          if (rawHeader.startsWith("{")) {
            const parsed = JSON.parse(rawHeader) as Record<string, unknown>;
            for (const [name, value] of Object.entries(parsed)) {
              const stringValue = String(value);
              directHeaders[name] = stringValue;
              suppliedSecrets.push(stringValue);
              if (name.toLowerCase() === "cookie") {
                for (const part of stringValue.split(";")) {
                  const eq = part.indexOf("=");
                  if (eq >= 0) suppliedSecrets.push(part.slice(eq + 1).trim());
                }
              }
              const bearer = stringValue.match(/^Bearer\s+(.+)$/i)?.[1];
              if (bearer) suppliedSecrets.push(bearer);
            }
          } else {
            const separator = rawHeader.indexOf(":");
            if (separator < 1) throw new Error("--header requires 'Name: value' or a JSON object");
            const headerName = rawHeader.slice(0, separator).trim();
            const headerValue = rawHeader.slice(separator + 1).trim();
            directHeaders[headerName] = headerValue;
            suppliedSecrets.push(headerValue);
            if (headerName.toLowerCase() === "cookie") {
              for (const part of headerValue.split(";")) {
                const eq = part.indexOf("=");
                if (eq >= 0) suppliedSecrets.push(part.slice(eq + 1).trim());
              }
            }
            const bearer = headerValue.match(/^Bearer\s+(.+)$/i)?.[1];
            if (bearer) suppliedSecrets.push(bearer);
          }
        }
        if (typeof flags["bearer-token"] === "string") suppliedSecrets.push(flags["bearer-token"]);
        const read = await directAuthorizedRead(url, {
          headers: directHeaders,
          bearerToken: typeof flags["bearer-token"] === "string" ? flags["bearer-token"] : undefined,
        });
        // directAuthorizedRead can identify Authorization semantically, but a
        // generic credential header (X-Api-Key, Cookie, vendor token) is opaque
        // by design. The CLI still knows it was explicitly presented. A 2xx/3xx
        // response is accepted; only an auth rejection becomes expired.
        const authOutcome = read.auth_outcome === "not_presented" && typeof flags.header === "string"
          ? (read.ok ? "presented_accepted" : read.reason === "session_expired" ? "presented_rejected" : "presented_unknown")
          : read.auth_outcome;
        runPlan[runPlan.length - 1] = {
          ...runPlan[runPlan.length - 1],
          status: read.ok ? "complete" : "error",
          status_code: read.status,
          auth_outcome: authOutcome,
          final_url: read.url,
        };
        return {
          ...buildResult(parseBody(redactReflectedSecrets(read.body, suppliedSecrets)), read.status, read.body.length, "direct-authorized-read"),
          ok: read.ok,
          auth_outcome: authOutcome,
          ...(read.reason ? {
            error: read.reason,
            blocker: read.reason,
            next_step: read.reason === "session_expired"
              ? "Refresh the supplied credential or run `unbrowse auth <login_url>`, then retry."
              : "Inspect the HTTP response and retry with valid authorization.",
          } : {}),
        };
      }
      const headersLiteral = JSON.stringify({ Accept: "application/json, text/plain;q=0.9, */*;q=0.8" }).replace(/'/g, "\\'");
      const bundleSource = `(() => {
        const r = __nativeFetch("GET", ${JSON.stringify(url)}, ${headersLiteral}, null);
        globalThis.r = { status: r.status, content_type: r.headers && (r.headers['content-type'] || r.headers['Content-Type']) || null, body: r.body, final_url: r.url };
      })()`;
      const { resp, postEvalProcessed } = await runSandboxCore({
        ...flags,
        "bundle-source": bundleSource,
        "post-eval": "globalThis.r",
      }, url);
      const peo = postEvalProcessed as Record<string, unknown> | undefined;
      const status = Number(peo?.status ?? 0);
      const bodyText = typeof peo?.body === "string" ? peo.body : "";
      if (status < 200 || status >= 400 || bodyText.length === 0) {
        runPlan[runPlan.length - 1] = {
          ...runPlan[runPlan.length - 1],
          status: "miss",
          status_code: status || null,
        };
        return null;
      }
      runPlan[runPlan.length - 1] = {
        ...runPlan[runPlan.length - 1],
        status: "complete",
        status_code: status,
        bytes: bodyText.length,
        routes_observed: resp.routes_observed?.length ?? 0,
        final_url: typeof peo?.final_url === "string" ? peo.final_url : url,
      };
      const structuredBody = directStructuredFallbackBody(bodyText);
      if (structuredBody === null) {
        runPlan[runPlan.length - 1] = {
          ...runPlan[runPlan.length - 1],
          status: "miss",
          status_code: status,
          reason: "response_not_structured",
        };
        return null;
      }
      return buildResult(structuredBody, status, bodyText.length, "direct-fetch", resp.cookies?.length ?? 0);
    } catch (e) {
      runPlan[runPlan.length - 1] = {
        ...runPlan[runPlan.length - 1],
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      };
      return null;
    }
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
        // Cardinality guard (): a list/search intent must not accept a
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
    const source = typeof result.source === "string" ? result.source : undefined;
    const timingIn = (result.timing && typeof result.timing === "object")
      ? result.timing as Record<string, unknown>
      : {};
    const impactIn = (result.impact && typeof result.impact === "object")
      ? result.impact as Record<string, unknown>
      : {};
    const cacheHit = result._cache_hit === true
      || timingIn.cache_hit === true
      || impactIn.cache_hit === true
      || source === "route-cache"
      || source === "cache";
    const browserAvoided = impactIn.browser_avoided === true
      || source === "direct-document"
      || source === "direct-fetch"
      || source === "marketplace"
      || source === "route-cache"
      || source === "cache"
      || (typeof result.execute_mode === "string" && /direct|marketplace|http/i.test(result.execute_mode));
    const timing = {
      ...timingIn,
      ...(cacheHit ? { cache_hit: true, source: timingIn.source ?? "cache" } : { cache_hit: timingIn.cache_hit === true }),
    };
    const impact = {
      ...impactIn,
      ...(source ? { source: impactIn.source ?? source } : {}),
      cache_hit: cacheHit,
      browser_avoided: browserAvoided,
    };
    return {
      ...result,
      ...slimTrace(result),
      run_plan: runPlan,
      timing,
      impact,
    };
  }

  function emitRunResult(result: Record<string, unknown>): void {
    // Warm-path: persist successful get/run results into the same resolution cache
    // resolve uses, so a subsequent get is a true cache hit with cache_hit:true.
    if (
      resolveCacheSafe(flags)
      && isResolveSuccessResult(result)
      && !result._cache_hit
    ) {
      try {
        storeResolution(resolveCacheKeyFor({ ...flags, url, intent } as Record<string, string | boolean>, intent), result, resolveCacheTtlMs());
      } catch { /* never block emit on cache write */ }
    }
    output(result, !!flags.pretty);
    if (flags.__terminal_exit === true && oneHoleTerminalExitCode(result) !== 0) process.exit(1);
  }

  // `act go <url>` (the bare navigate alias) routes here via breath get -> cmdRun,
  // so its intent is the literal alias tokens with no user task. A genuine one-hole
  // read (`"fetch the user" --url …`) carries a real task intent and must NOT match.
  const isActGoNavigateVariant = (() => {
    const i = (intent ?? "").trim().toLowerCase();
    return i === "act go" || i === "go" || i === "act read" || i === "read";
  })();

  // act-go output-contract consistency: depending on internal routing `act go`
  // emits either the breath-go envelope (carries page.text) OR this orchestrator
  // envelope (carries the body under `result`). For the NAVIGATE variant whose URL
  // returned a structured API body DIRECTLY (source === "direct-fetch": the
  // orchestrator path that fetched the URL and got clean JSON), ALSO surface that
  // body as page.text so `act go` has ONE consistent "navigate + capture" contract.
  //
  // Gated narrowly so it never pollutes other envelopes:
  //   - navigate variant only (bare `act go`, not a one-hole task read);
  //   - source === "direct-fetch" only (a clean API body — NOT a live-capture /
  //     resolve envelope like example.com, which already has its own surface and
  //     whose `result` is a {error,next_step,…} envelope, not a page);
  //   - the body is a JSON record (object/collection), not plaintext/scalar (/zen).
  function mirrorNavigateBodyToPage(result: Record<string, unknown>): Record<string, unknown> {
    if (!isActGoNavigateVariant) return result;
    if ("page" in result) return result; // already carries a page surface
    if (result.source !== "direct-fetch") return result; // only the clean-API-body path
    const body = (result as Record<string, unknown>).result;
    if (body === null || typeof body !== "object") return result; // not a JSON record (plaintext, scalar)
    let text: string;
    try {
      text = JSON.stringify(body);
    } catch {
      return result;
    }
    if (!text) return result;
    return { ...result, page: { text: text.slice(0, 200000) } };
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
    // Warm get/run: same resolution-cache fast path as `resolve` (peek before API).
    if (resolveCacheSafe({ ...flags, url, intent } as Record<string, string | boolean>)) {
      const cacheFlags = { ...flags, url, intent } as Record<string, string | boolean>;
      const cachedHit = peekResolution<Record<string, unknown>>(
        resolveCacheKeyFor(cacheFlags, intent),
        resolveCacheTtlMs(),
      );
      const cachedData = cachedHit ? (cachedHit.result ?? (cachedHit as Record<string, unknown>).data) : undefined;
      if (
        cachedHit
        && resolutionCardinalityMatches(intent, cachedData)
        && resolutionHostMatches(url, cachedData)
        && resolutionPathMatches(url, cachedData)
        && (cachedResolutionHasReadableValue(cachedHit) || isResolveSuccessResult(cachedHit))
        // Internal API outranks a replayed document. Background discovery indexes
        // the site's real XHR routes AFTER the first call already settled from
        // HTML, so the cached document is always the older, weaker answer once a
        // skill exists. Without this the fast path replayed the scrape forever and
        // the freshly-learned route was never reached — witnessed on defillama.com:
        // a skill was indexed into domain-skill-cache.json and warm still came back
        // `source: direct-document, mode: resolution_cache`.
        && !learnedInternalApiOutranksCachedDocument(url, cachedHit)
      ) {
        runPlan.push({ step: "resolve", mode: "resolution_cache", status: "hit", cache_hit: true });
        emitRunResult(decorate(mirrorNavigateBodyToPage(markResolveCacheReplay(cachedHit))));
        return;
      }
    }

    const directStructured = await tryDirectStructuredUrl();
    if (directStructured) {
      emitRunResult(decorate(mirrorNavigateBodyToPage(directStructured)));
      return;
    }
    let result = await resolveStep("initial");
    if (draftOnlyIntent) {
      if (isResolveSuccessResult(result)) {
        runPlan.push({
          step: "execute",
          mode: "draft_only_guard",
          status: "skipped",
          reason: "no_side_effects_without_approval",
        });
        emitRunResult(decorate(buildDraftOnlyEnvelope(intent, url, result)));
        return;
      }
      const err = resolveResultError(result);
      emitRunResult(decorate({
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
      }));
      return;
    }
    const firstError = resolveResultError(result);
    if (firstError === "auth_required") {
      const loginUrl = resolveLoginUrl(result, url);
      emitRunResult(decorate({
        ...result,
        next_action: {
          title: "Authenticate site",
          command: `unbrowse auth "${loginUrl}"`,
          why: "The site needs an interactive login before Unbrowse can call or index private routes.",
        },
      }));
      return;
    }
    if (isResolveSuccessResult(result)) {
      emitRunResult(decorate(mirrorNavigateBodyToPage(result)));
      return;
    }
    if (!shouldIndexFallback(result)) {
      emitRunResult(decorate(mirrorNavigateBodyToPage(result)));
      return;
    }

    if (flags["no-index"]) {
      emitRunResult(decorate({
        ...result,
        next_action: {
          title: "Index this page",
          command: `unbrowse ${verb} "${url}" "${intent}"`,
          why: "--no-index stopped the automatic capture/index fallback.",
        },
      }));
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
        emitRunResult(decorate(mirrorNavigateBodyToPage(result)));
        return;
      }
      if (resolveResultError(result) === "auth_required") {
        const loginUrl = resolveLoginUrl(result, url);
        emitRunResult(decorate({
          ...result,
          next_action: {
            title: "Authenticate site",
            command: `unbrowse auth "${loginUrl}"`,
            why: "The newly indexed route needs a site session before execution.",
          },
        }));
        return;
      }
      if (!shouldIndexFallback(result)) {
        emitRunResult(decorate(result));
        return;
      }
    }

    if (flags["no-browse"]) {
      emitRunResult(decorate({
        status: "needs_browser",
        capture,
        resolve_result: result,
        next_action: {
          title: "Browse interactively",
          command: `unbrowse go "${url}"`,
          why: "--no-browse stopped the automatic live-browser fallback.",
        },
      }));
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
    // Did the browser actually COMMIT a page? A `chrome-error://chromewebdata/`
    // final URL means it did not — DNS failed, or the connection did — and
    // Chrome's own error page ("This site can't be reached … ERR_NAME_NOT_RESOLVED")
    // is >200 chars and matches none of the challenge keywords below, so without
    // this it sailed through as `status:"ok"`, `success:true`, `status_code:200`
    // with the error page hoisted as `page_text`. Measured against
    // https://unresolvable.invalid/x, which also carried `capture.error:"fetch
    // failed"` in the same payload — contradictory terminal fields.
    //
    // Uses the existing scheme recognizer rather than a new keyword list. NOT
    // `isIndexableUrl`, which also rejects reserved domains like example.com —
    // those are real committed pages that merely should not be indexed. The
    // question here is narrower: did a page load at all?
    const browseFinalUrl = typeof browse.url === "string" ? browse.url : url;
    const committedRealPage = indexableReason(browseFinalUrl) !== "bad_scheme";
    const looksLikeRealContent =
      !browseErrored &&
      !browseAuthRequired &&
      committedRealPage &&
      browsePageText.length >= 200 &&
      !/please (wait|verify|enable|complete)|access denied|just a moment|attention required|cf-chl|datadome|captcha/i.test(browsePageText.slice(0, 2048));

    if (looksLikeRealContent) {
      emitRunResult(decorate({
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
      }));
      return;
    }

    emitRunResult(decorate({
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
    }));
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

/**
 * PIDs of Chrome processes unbrowse itself manages.
 *
 * Deliberately narrow: matches only binaries under the unbrowse-managed Chrome
 * cache dir, so a user's own Chrome/Chromium can never be selected. Callers pair
 * this with the session registry before killing anything — a browse session's
 * Chrome is owned by that session, not by whoever noticed it.
 *
 * Best-effort and non-throwing: if `ps` is unavailable, it returns an empty set
 * and callers simply reap nothing, which is the safe direction.
 */
/**
 * Does a live browse session own this Chrome pid?
 *
 * Synchronous mirror of `anotherSessionUsesChrome` — the async version cannot be
 * used from a signal handler, and this guard is what keeps a background capture
 * from ever killing the Chrome behind someone's `unbrowse go` session.
 *
 * Fails CLOSED: any error reading the session store returns true ("assume owned"),
 * so an unreadable store means we reap nothing rather than risk killing a session.
 */
/**
 * Reap unbrowse-Chrome orphaned by a SIGKILL.
 *
 * In-process teardown covers done/error/deadline/SIGTERM/SIGINT/SIGHUP. It
 * CANNOT cover SIGKILL — no handler runs — and SIGKILL is what the OOM killer
 * sends, which is exactly how 119 orphans came to hold 7.3GB here with no driver
 * running. So the backstop must live in a LATER process, deciding from durable
 * evidence only: pid liveness, session records, process age.
 *
 * Opportunistic and best-effort: any failure reaps nothing, which is the safe
 * direction. Disable with UNBROWSE_CHROME_REAP=0.
 */
function reapOrphanedChrome(): void {
  if (process.env.UNBROWSE_CHROME_REAP === "0") return;
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const { selectReapableChrome } = require("./values/chrome-orphan.js") as typeof import("./values/chrome-orphan.js");
    // `etimes` = elapsed seconds; Linux/macOS ps. Windows has no such ps, the
    // call throws, and we reap nothing — the fix is simply inert there.
    const out = execFileSync("ps", ["-eo", "pid=,etimes=,command="], { encoding: "utf8", timeout: 5_000 });
    const procs: Array<{ pid: number; ageMs: number; sessionOwned: boolean }> = [];
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
      if (!m) continue;
      // Match the EXECUTABLE, never the arguments. Matching anywhere in the
      // command line kills any process that merely MENTIONS the path — a shell
      // script, an editor, a grep. That is not theoretical: it terminated the
      // very shell running the test that found it.
      if (!isManagedChromeExecutable(m[3]!)) continue;
      const pid = Number(m[1]);
      if (pid === process.pid) continue;
      procs.push({ pid, ageMs: Number(m[2]) * 1000, sessionOwned: sessionOwnsChromePid(pid) });
    }
    const reapable = selectReapableChrome(procs);
    let killed = 0;
    for (const pid of reapable) {
      try { process.kill(pid, "SIGTERM"); killed++; } catch { /* already gone */ }
    }
    if (killed > 0) console.error(`[chrome-reap] terminated ${killed} orphaned chrome process(es) (no session, >15m old)`);
  } catch { /* no ps / unreadable — reap nothing */ }
}

/**
 * Is this ps `command` field the unbrowse-managed Chrome BINARY?
 *
 * Checks the executable path only. An earlier version matched the string
 * anywhere in the command line, which selects any process that merely mentions
 * the path — and promptly SIGTERM'd the shell running the test that caught it.
 * Killing by substring-of-argv is how a reaper becomes the outage.
 */
function isManagedChromeExecutable(command: string): boolean {
  return command.includes("/.cache/unbrowse/chrome/") && /chrome|chromium/i.test(command);
}

function sessionOwnsChromePid(pid: number): boolean {
  try {
    const { readdirSync, readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const { join: j } = require("node:path") as typeof import("node:path");
    const { getUnbrowseHome: home } = require("./runtime/paths.js") as { getUnbrowseHome: () => string };
    const root = j(home(), "tmp");
    if (!existsSync(root)) return false;
    for (const dir of readdirSync(root)) {
      const sub = j(root, dir);
      let files: string[];
      try { files = readdirSync(sub); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const rec = JSON.parse(readFileSync(j(sub, f), "utf8")) as { chromePid?: number };
          if (rec?.chromePid === pid) return true;
        } catch { /* unreadable record — ignore this one */ }
      }
    }
    return false;
  } catch {
    return true; // fail closed
  }
}

function listUnbrowseChromePids(): Set<number> {
  const pids = new Set<number>();
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8", timeout: 5_000 });
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\S+)/);
      if (!m || !isManagedChromeExecutable(m[2]!)) continue;   // executable, not args
      const pid = Number(m[1]);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
    }
  } catch { /* no ps, or it failed — reap nothing */ }
  return pids;
}



/**
 * Disk wrapper only — the decision itself is the pure, exhaustively-tested
 * `learnedSkillOutranksCachedDocument` in values/internal-api-precedence.ts.
 * An unreadable/missing cache yields null there, which fails open to the
 * existing replay.
 */
function learnedInternalApiOutranksCachedDocument(url: string, cachedHit: unknown): boolean {
  let cache: Record<string, unknown> | null = null;
  try {
    const { readFileSync: rf } = require("node:fs") as typeof import("node:fs");
    const { join: j } = require("node:path") as typeof import("node:path");
    const { getUnbrowseHome: home } = require("./runtime/paths.js") as { getUnbrowseHome: () => string };
    cache = JSON.parse(rf(j(home(), "domain-skill-cache.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  return learnedSkillOutranksCachedDocument(url, cachedHit, cache);
}

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
    recordCreativityActFromExecute(result, {
      intent: typeof (flags.intent ?? flags.task) === "string" ? (flags.intent ?? flags.task) as string : undefined,
      skill_id: skillId,
      endpoint_id: endpointId,
    });
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


// Emit a publishable per-website skill package (agentskills.io format): a
// directory with SKILL.md (origin pointer + wallet credential holes + x402 reward,
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
      in_process?: boolean;
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

  // Machine report only when the caller asked for JSON. Non-TTY without
  // --json still gets human next-steps on stderr (info), not a SetupReport
  // wall — agents that need the report pass --json. Live audit 2026-08.
  const wantMachine = !!(flags.json || flags.pretty);

  if (flags["no-start"]) {
    report.server = { started: false, skipped: true, mode: "in-process", base_url: "in-process" };
    if (wantMachine) output(report, true);
    printSetupNextSteps({ noStart: true, hasKey: !!getApiKey() });
    if (report.browser_engine.action === "failed") process.exit(1);
    return;
  }

  // Registration is optional. Skip during setup — users can run `unbrowse
  // register` later if they want to publish, earn, or access server-side
  // analytics. Setup just installs deps and starts the local server.

  try {
    // NOTE: this is the IN-PROCESS capability surface only.
    // No HTTP listener is started here; `unbrowse serve` is the explicit
    // foreground server. Reporting started:true would be a lie (see #127).
    await getInProcessApp();
    report.server = { started: false, in_process: true, mode: "in-process", base_url: "in-process" };
    await recordFunnelTelemetryEvent("server_autostart_succeeded", {
      source: "setup",
      hostType,
      properties: {
        base_url: "in-process",
        in_process: true,
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
    report.server = { started: false, error: message, mode: "in-process", base_url: "in-process" };
    if (wantMachine) output(report, true);
    else info(`Local runtime warm-up failed: ${message}`);
    process.exit(1);
  }

  if (wantMachine) output(report, true);
  if (report.browser_engine.action === "failed") process.exit(1);
  if (getApiKey()) {
    info("Dashboard connected:");
    info("  unbrowse dashboard");
  }

  // --- Guided first resolve ---
  // After setup succeeds, auto-run a resolve so the user sees what unbrowse
  // does. This directly attacks the 82% drop-off at registration→first_resolve.
  // Prefer the one-call front door in the "try next" copy (not resolve-only).
  try {
    info("Trying a quick first resolve (jsonplaceholder)...");
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
    } else {
      const inner = resolveResult.result as Record<string, unknown> | undefined;
      const nextStep = inner?.next_step as Record<string, unknown> | undefined;
      const command = typeof nextStep?.command === "string"
        ? nextStep.command
        : 'unbrowse capture --url "https://jsonplaceholder.typicode.com" --intent "list all posts"';
      info("No reusable route found on the demo site yet.");
      info("Next step:");
      info(`  ${command}`);
    }
  } catch {
    // Guided resolve is best-effort — never fail setup because of it
    info("Demo resolve skipped (offline or backend unreachable). That's fine.");
  }

  printSetupNextSteps({ noStart: false, hasKey: !!getApiKey() });
}

/** Human-facing "what do I type next" after setup. Always printed on TTY. */
function printSetupNextSteps(opts: { noStart: boolean; hasKey: boolean }): void {
  info("");
  info("Setup complete. Try it now (one call — resolve + execute):");
  info('  unbrowse "top stories with point counts" --url https://news.ycombinator.com');
  info("");
  info("Or any site:");
  info('  unbrowse "<what you want>" --url "https://example.com"');
  info("");
  info("Check health anytime:");
  info("  unbrowse health");
  if (!opts.hasKey) {
    info("");
    info("Optional — pair a dashboard account later:");
    info("  unbrowse register --email you@example.com");
    info("  unbrowse dashboard");
  }
  if (opts.noStart) {
    info("");
    info("(Server warm-up skipped with --no-start; the next command starts the runtime.)");
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
    account_url: `${FRONTEND_URL}/account`,
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
  info(`  account: ${payload.account_url}  (mutation safety: unbrowse dashboard --account)`);
  output(payload, false);
}

export async function cmdDashboard(flags: Record<string, string | boolean>): Promise<void> {
  await refreshContributionPreferenceFromServer(false);
  const cfg = loadConfig();
  const nextPath = flags.account === true
    ? "/account"
    : (typeof flags.path === "string" && flags.path.startsWith("/") ? flags.path : "/dashboard");
  if (!cfg?.api_key) {
    const loginUrl = nextPath === "/dashboard"
      ? `${FRONTEND_URL}/login`
      : `${FRONTEND_URL}/login?next=${encodeURIComponent(nextPath)}`;
    info("No account-bound CLI key found. Opening website sign-in.");
    if (!flags["no-open"]) openUrl(loginUrl);
    output({ status: "login_required", url: loginUrl, next: nextPath }, !!flags.pretty);
    return;
  }

  // Pairing is a browser → localhost HTTP hop. The in-process app is inject-only
  // by default; bind a short-lived listener only for this explicit open path.
  const app = await getInProcessApp();
  const local = new URL(BASE_URL);
  const listenHost = local.hostname || "127.0.0.1";
  const listenPort = Number(local.port || "6969");
  let listening = false;
  try {
    await app.listen({ host: listenHost, port: listenPort });
    listening = true;
  } catch (err) {
    // Another owned unbrowse server may already be serving the same routes.
    const probe = await fetch(`${BASE_URL.replace(/\/+$/, "")}/health`).then((r) => r.ok).catch(() => false);
    if (!probe) {
      die(`Could not bind pairing server on ${BASE_URL}: ${(err as Error).message}. Stop whatever holds the port, or run \`unbrowse serve\` in another terminal.`);
    }
    info(`Using already-listening local runtime at ${BASE_URL}.`);
  }

  const pair = createDashboardPairingToken();
  const url = buildDashboardPairingUrl({
    frontendUrl: FRONTEND_URL,
    localBaseUrl: BASE_URL,
    pairToken: pair.token,
    nextPath,
  });
  if (!flags["no-open"]) openUrl(url);
  info(nextPath === "/account"
    ? "Opening account (mutation safety) and pairing this CLI install."
    : "Opening dashboard and pairing this CLI install.");
  info(`Local pairing endpoint: ${BASE_URL}/v1/local/pair (expires ${pair.expires_at})`);
  output({
    status: "pairing_started",
    url,
    next: nextPath,
    local_server: BASE_URL,
    expires_at: pair.expires_at,
    holding_listener: listening,
  }, !!flags.pretty);

  if (!listening || flags["no-open"] === true || flags["no-hold"] === true) {
    if (listening) {
      try { await app.close(); } catch { /* best effort */ }
    }
    return;
  }

  // Hold the listener until the one-shot token is consumed or expires so the
  // browser can finish /v1/local/pair without a separate `unbrowse serve`.
  const expiresMs = Math.max(0, Date.parse(pair.expires_at) - Date.now());
  const holdMs = Number.isFinite(expiresMs) ? expiresMs + 1_000 : 120_000;
  info(`Holding local pairing server for up to ${Math.ceil(holdMs / 1000)}s (Ctrl+C to stop).`);
  const started = Date.now();
  while (Date.now() - started < holdMs) {
    if (!isDashboardPairingTokenPending(pair.token)) {
      info("Pairing token consumed. Local mutation settings are now reachable from the account panel.");
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try { await app.close(); } catch { /* best effort */ }
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

/**
 * Build the `unbrowse capture` envelope from a /v1/capture response.
 *
 * Three facts, kept separate, none allowed to displace another:
 *
 *   error          — the STABLE machine code produced by the capture pipeline
 *                    (`connection_failed` | `capture_timeout` | `capture_failed`).
 *                    Coarse by design; recovery paths switch on it. It explains
 *                    nothing on its own.
 *   error_message  — the VERBATIM cause. `describeCaptureFailure` in
 *                    src/execution/index.ts preserves it and POST /v1/capture
 *                    forwards it as `error_message`. This builder used to copy
 *                    the code and drop the text one layer from the user: with
 *                    UNBROWSE_KURI_BIN pointing at a missing binary the CLI
 *                    printed `capture_failed` and the sentence
 *                    "Kuri binary not found at … (from UNBROWSE_KURI_BIN)"
 *                    appeared on neither stdout nor stderr.
 *   possible_cause — a GUESS, and labelled as one. Emitted only when the capture
 *                    itself reported an auth signal (`auth_recommended`), and
 *                    never in place of a real error. The old `next_step`
 *                    asserted "site may need authentication or different intent"
 *                    from `endpoints.length === 0` alone — zero endpoints is not
 *                    evidence of an auth wall, and that inference mislabelled
 *                    four sites that needed no auth at all.
 *
 * Exported so the honest-surface tests can exercise every branch offline.
 */
export function buildCaptureEnvelope(
  result: Record<string, unknown>,
  ctx: { url: string; intent: string; ms: number },
): Record<string, unknown> {
  const { url, intent } = ctx;
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

  const errorCode = typeof result.error === "string" && result.error.trim().length > 0
    ? result.error.trim()
    : null;
  // The cause text, wherever this response carries it: the HTTP route renames
  // executeBrowserCapture's `message` to `error_message`, the in-process result
  // keeps it as `message`. A value identical to the code is not a cause.
  const errorMessage = [result.error_message, result.message].find(
    (m): m is string => typeof m === "string" && m.trim().length > 0 && m.trim() !== errorCode,
  )?.trim() ?? null;
  // Evidence, not inference: the capture pipeline sets auth_recommended only
  // when it actually observed an auth wall (login redirect, 401, provider hop).
  const authEvidence = result.auth_recommended === true;
  const authHint = typeof result.auth_hint === "string" && result.auth_hint.trim().length > 0
    ? result.auth_hint.trim()
    : `try: unbrowse login --url "${escapedUrl}"`;

  const nextStep = errorCode
    ? `capture failed (${errorCode}) — read error_message for the actual cause, fix it, then retry: unbrowse capture --url "${escapedUrl}" --intent "${escapedIntent}"`
    : endpoints.length === 0
      ? `no endpoints discovered; retry with a different --intent, or drive the page first (unbrowse go "${escapedUrl}") so its XHR/fetch traffic fires`
      : `unbrowse resolve --intent "${escapedIntent}" --url "${escapedUrl}"`;

  return {
    skill_id: skillId,
    endpoints_discovered: typeof result.endpoints_discovered === "number"
      ? (result.endpoints_discovered as number)
      : endpoints.length,
    marketplace_published: !!result.marketplace_published,
    ms: typeof result.ms === "number" ? (result.ms as number) : ctx.ms,
    next_step: nextStep,
    ...(isThinDocumentOnly
      ? { capture_pattern: "doc_only", capture_observation: "only the input URL was captured (1 GET, no XHR fired during the auto-capture window)" }
      : {}),
    ...(errorCode ? { error: errorCode } : {}),
    ...(errorMessage ? { error_message: errorMessage } : {}),
    ...(authEvidence ? { possible_cause: `unverified guess — the capture reported an auth signal for this site: ${authHint}` } : {}),
    ...(result.captured_meta ? { captured_meta: result.captured_meta } : {}),
    ...(typeof result.capture_path === "string" ? { capture_path: result.capture_path } : {}),
    ...(result.prior_domain_note ? { prior_domain_note: result.prior_domain_note } : {}),
    ...(result.note_evidence ? { note_evidence: result.note_evidence } : {}),
  };
}

export async function cmdCapture(flags: Record<string, string | boolean>): Promise<void> {
  const url = flags.url as string;
  const intent = (flags.intent as string) || "capture";
  if (!url) die("--url is required");
  maybeShowContributionNotice();

  const t0 = Date.now();
  const result = await api("POST", "/v1/capture", { url, intent }) as Record<string, unknown>;

  output(buildCaptureEnvelope(result, { url, intent, ms: Date.now() - t0 }), !!flags.pretty);
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
  // One decision, one interface: the flag AND the guard every other cookie path
  // consults. main() bridges --no-browser-cookies into that guard, so this stays
  // correct even when `fetch` is reached through a wrapper that only set
  // UNBROWSE_IMPORT_BROWSER_COOKIES, and the flag can never disagree with the
  // env var about whether the user consented.
  const { shouldImportBrowserCookies } = await import("./auth/index.js");
  const useBrowserCookies = flags["no-browser-cookies"] !== true && shouldImportBrowserCookies();
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

  // Feed observed routes into marketplace publish when: explicit --publish,
  // UNBROWSE_PUBLISH_OBSERVED_ROUTES=1, or share_pointers is ON (default after setup).
  // Opt out with UNBROWSE_PUBLISH_OBSERVED_ROUTES=0 even if share_pointers is true.
  const publishObservedEnv = process.env.UNBROWSE_PUBLISH_OBSERVED_ROUTES?.trim().toLowerCase();
  const publishObservedForcedOff = publishObservedEnv === "0" || publishObservedEnv === "false" || publishObservedEnv === "off" || publishObservedEnv === "no";
  const publishObservedForcedOn = publishObservedEnv === "1" || publishObservedEnv === "true" || publishObservedEnv === "yes";
  let sharePointers = false;
  try {
    sharePointers = getContributionConfig().contribution.share_pointers === true;
  } catch { /* no config yet */ }
  const publishObserved = flags.publish === true
    || publishObservedForcedOn
    || (!publishObservedForcedOff && sharePointers);
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
  // Flat top-level CLI (2026-08): docs + agents teach `unbrowse get|resolve|…`,
  // not build/breath/eval prefixes. Those prefixes still parse as aliases but
  // are not the help surface. Written to STDOUT (help is requested, not an error).
  const lines: string[] = [
    "unbrowse — route layer for web agents (in-process, stateless)",
    "",
    "Usage:",
    "  unbrowse \"<task>\" --url <url>    one-call front door (preferred)",
    "  unbrowse <command> [args]         flat top-level commands",
    "  unbrowse <command> --help         command-specific flags",
    "",
    "Exit codes: 0 success (incl. --help) · 1 runtime failure · 64 usage error · 70 not implemented",
    "",
    "Runtime: in-process — no localhost daemon to start or probe.",
    "  Optional: `unbrowse serve` is an explicit HTTP facade only.",
    "",
    ...agentPathHelpLines(),
    "",
    "Operator/debug commands (not ordinary reads):",
    "  fetch <url>                         raw URL contents",
    "  resolve / execute                   inspect or select a route",
    "  health / setup                      runtime administration",
    "",
    "DOM session (only when interaction is the task):",
    "  1. go <url>     open a tab",
    "  2. snap         a11y snapshot with @eN refs",
    "  3. click/fill/type/select/submit",
    "  4. sync         checkpoint (tab stays open)",
    "  5. close        final checkpoint + close",
    "",
    "Marketplace (after capture/review):",
    "  skills | skill <id> | publish --skill <id> --confirm-publish",
    "  settings | stats | dashboard | account --register",
    "",
    "Global flags:",
    "  --json     single-line JSON stdout",
    "  --pretty   pretty 2-space JSON stdout",
    "  --help     this help (or command help)",
    "",
    "Hit a bug? File it (agents: use the gh CLI):",
    "  gh issue create --repo unbrowse-ai/unbrowse --title \"bug: <domain> - <summary>\" --body \"<repro + trace>\"",
    "",
    // Public runtime scrubs the word "breath" → "act"; keep this line free of
    // that token so the published help does not read "build/act/eval/act".
    "Legacy three-verb prefixes still parse as aliases; prefer flat commands above.",
    "",
    ...(process.env.UNBROWSE_BEE_MODE === "1"
      ? [
          "Bee aliases (same runtime): pollen · waggle · buzz · forage · swarm · nectar · hive",
          "  npm i -g @unbrowse/pollen-cli",
          "",
        ]
      : [
          "Bee aliases: npm i -g @unbrowse/pollen-cli  (pollen, waggle, buzz, forage, swarm, nectar, hive)",
          "",
        ]),
    "Learn more:",
    "  How it pays   https://unbrowse.ai/how-unbrowse-pays",
    "  Privacy       https://unbrowse.ai/privacy",
    "  Papers        https://unbrowse.ai/papers",
    "",
  ];

  process.stdout.write(lines.join("\n") + "\n");
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

/**
 * Run the stdio MCP server IN THIS PROCESS.
 *
 * This used to `spawn(process.execPath, [<mcp entrypoint>])` with `stdio:
 * "inherit"` and no signal handler — the fourth and last node in a chain where
 * no hop forwarded anything. A host that SIGTERMed the process it launched
 * killed that one process; this child and its own descendants orphaned and ran
 * forever. `cmdServe` directly below has always installed SIGINT/SIGTERM
 * handlers; `mcp` simply never got them.
 *
 * The spawn was never buying isolation, only a PID: the child was the SAME
 * runtime, re-entered through a second interpreter, inheriting the same three
 * stdio fds. `src/mcp.ts` starts its stdio loop as a module side effect, so
 * importing it here IS the server — which is exactly how the packaged
 * single-file binary has always done it (`single-binary.ts`, `mcp-serve` →
 * `await import("./mcp.js")`). Doing the same thing here collapses the hop for
 * every install shape at once and removes the need to forward a signal, because
 * there is no longer anywhere for a signal to fail to arrive.
 */
export async function cmdMcp(flags: Record<string, string | boolean>): Promise<void> {
  // Process identity, previously injected into the child's env. Must be set
  // BEFORE the import: mcp.ts and the modules it pulls in read this at module
  // scope, and it is what keeps inlined CLI code from auto-running main() and
  // printing help onto the JSON-RPC stdout stream.
  process.env.MCP_SERVER_MODE = "1";
  process.env.UNBROWSE_RUNTIME_ENTRY = "mcp";
  // Preserve the flag on argv exactly as the spawned child received it, so any
  // argv-reading consumer behaves identically (`--no-auto-start` reaches
  // ensureLocalServer's noAutoStart).
  if (flags["no-auto-start"] && !process.argv.includes("--no-auto-start")) {
    process.argv.push("--no-auto-start");
  }

  // Now that the server shares this process, the CLI auto-main SIGTERM/SIGINT
  // handlers installed at module scope are actively wrong for it: they flush a
  // `{"ok":false,"error":"cli_timeout"}` object to STDOUT, which here is the
  // JSON-RPC frame stream, and exit 124. That was harmless while the CLI was its
  // own PID; it would now corrupt the transport on every shutdown. Replace them
  // with the clean-shutdown shape cmdServe uses. Only those two `once` listeners
  // exist at this point, so removing by name is precise, not a blunt sweep.
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  const shutdown = (signal: NodeJS.Signals): void => {
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", () => { shutdown("SIGINT"); });
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });

  await import("./mcp.js");

  // mcp.ts's main() owns the process from here: its readline handle on stdin is
  // what keeps the event loop alive. Park instead of returning so the CLI
  // dispatcher cannot run its post-command epilogue against a live JSON-RPC
  // stdout. An unresolved promise is not a handle, so when stdin closes the read
  // loop ends and Node still exits on its own — same shape as cmdServe.
  await new Promise<void>(() => {});
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
  if (parsed.url) {
    const embeddedWriteBody = extractEmbeddedJsonBody(parsed.intent);
    const implicitWrite = !!embeddedWriteBody && !!inferWriteMethod(undefined, parsed.intent, true);
    const specializedDirectRequest = typeof flags.header === "string"
      || typeof flags["bearer-token"] === "string"
      || typeof flags.body === "string"
      || typeof flags.method === "string"
      || flags["no-browse"] === true
      || flags["no-index"] === true
      || implicitWrite
      || isDraftOnlyMutationIntent(parsed.intent);
    if (specializedDirectRequest) {
      return cmdRun([], { ...flags, url: parsed.url, intent: parsed.intent }, "get");
    }
    return cmdResolve({
      ...flags,
      url: parsed.url,
      intent: parsed.intent,
      __agent_front_door: true,
    });
  }
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


async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  let { command, args, flags } = parsed;
  const cliParams = parsed.params;
  // Only the executable CLI opts into process termination. Imported cmdRun/
  // cmdGet helpers stay pure enough for in-process callers and test harnesses.
  flags.__terminal_exit = true;

  // --no-browser-cookies is a CREDENTIAL control, so it is bridged here — once,
  // before any command dispatches — instead of inside a single handler. The two
  // guards that actually decide whether the user's real browser session gets
  // attached (`shouldImportBrowserCookies` in src/auth/index.ts, and its twin in
  // src/runtime/browser-auth.ts) read ONLY the env var below, and nothing in
  // src/ ever set it. The flag was parsed, advertised in --help, and consumed by
  // exactly one command (`fetch`), so on `breath get` — the recommended one-call
  // path — a user who explicitly opted out got their cookies attached anyway.
  //
  // WHY process.env: it is the interface those guards already read, it is how
  // this file already pushes a flag decision into the runtime (`--reset-key` →
  // UNBROWSE_IGNORE_ENV_API_KEY, below), and it rides along to every child
  // process the CLI spawns — a module-local variable would reach neither the
  // dynamic-imported guards nor a subprocess.
  //
  // FAIL CLOSED: a credential opt-out that silently degrades to "attach anyway"
  // is the defect being fixed, so the bridge is verified against the guard that
  // will be consulted, and the run is refused if the opt-out did not take.
  if (flags["no-browser-cookies"] === true) {
    process.env.UNBROWSE_IMPORT_BROWSER_COOKIES = "0";
    let optOutHeld = false;
    try {
      const { shouldImportBrowserCookies } = await import("./auth/index.js");
      optOutHeld = shouldImportBrowserCookies() === false;
    } catch {
      // Cannot even ask the guard ⇒ cannot prove the user's refusal will be
      // honoured. Refuse rather than proceed with cookies enabled.
      optOutHeld = false;
    }
    if (!optOutHeld) {
      die(
        "--no-browser-cookies could not be applied: browser-cookie import is still enabled "
        + "(UNBROWSE_IMPORT_BROWSER_COOKIES did not take). Refusing to run rather than attach "
        + "your browser session against your explicit request.",
      );
    }
  }

  // Usage ping — the "is anyone using it?" signal the retired session store no
  // longer captures. One fire-and-forget ping per invocation (skips help/internal
  // verbs); opt-out-respecting, never blocks the command.
  if (command && command !== "help" && !command.startsWith("__")) {
    const usage = cliUsageDimensions(command, args);
    void reportUsage(usage.verb, {
      operation: usage.operation,
      surface: "cli",
      execution_scope: "unknown",
    });
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
  // `--format json|human` is the EXPLICIT override of the TTY inference above.
  // The inference is right almost always, but it is an inference: a human running
  // inside tmux/CI, or an agent that allocates a pty, both get guessed wrong and
  // had no way to say so. `--format json` forces the machine contract on a TTY;
  // `--format human` keeps chatter inline when stdout is piped to a pager.
  // NO_COLOR is honoured as a machine-ish signal per the agent-native convention.
  const _fmt = typeof flags.format === "string" ? flags.format.toLowerCase() : undefined;
  if (_fmt && _fmt !== "json" && _fmt !== "human" && _fmt !== "table") {
    process.stderr.write(`--format: expected json|human|table, got ${JSON.stringify(_fmt)}\n`);
    process.exit(64); // EX_USAGE — a system can route this deterministically
  }
  const _machineStdout = _fmt
    ? _fmt === "json"
    : (flags.json === true || !process.stdout.isTTY);
  if (_machineStdout) {
    const _stderrLog = (...rest: unknown[]) => process.stderr.write(rest.map(String).join(" ") + "\n");
    console.log = _stderrLog;
    console.info = _stderrLog;
    console.warn = _stderrLog;
  }
  // Downstream reads flags.json as "emit the machine payload"; keep it in sync so
  // --format json behaves identically to --json rather than only rerouting logs.
  if (_fmt === "json") flags.json = true;

  // ── Boundary validation (P5) ────────────────────────────────────────────────
  // Validate the caller's target URL ONCE, here, instead of in the eight places
  // that read flags.url. Everything downstream then operates on a parsed URL with
  // a known scheme.
  //
  // Measured before this existed: `--url file:///etc/passwd` returned exit 0,
  // success:true and the local file's CONTENTS; `javascript:` and `ftp:` hung
  // until the harness killed them at 45s; `not-a-url` exited 1, which a system
  // cannot tell apart from a site being down. CLI arguments are not trusted
  // input — they can come from a hallucinating or prompt-injected agent.
  if (typeof flags.url === "string" && command !== "__bg-capture") {
    const verdict = validateTargetUrl(flags.url);
    if (!verdict.ok) {
      // Machine payload on stdout, human message on stderr, EX_USAGE for the
      // system — the three audiences get the same fact in their own channel.
      // ONE envelope shape (src/values/error-envelope.ts) — this used to be
      // hand-rolled here with different nesting and no `retryable`, so an agent
      // needed two parsers and got the retry signal from only one of them.
      process.stdout.write(JSON.stringify(buildErrorEnvelope({
        code: verdict.code,
        message: verdict.message,
        retryable: false, // a refused scheme cannot succeed by repeating
        field: "--url",
      })) + "\n");
      process.stderr.write(`unbrowse: ${verdict.message}\n`);
      process.exit(64); // EX_USAGE — distinct from 1 (the task failed)
    }
    flags.url = verdict.url;
  }
  if (command === "browse") {
    const subcommand = args.shift();
    if (!subcommand || subcommand === "help") {
      printHelp();
      process.exit(subcommand === "help" ? 0 : 1);
    }
    command = subcommand;
  }

  // Schema introspection (P6) — the command surface, from the declarative map.
  //
  // Derived from cli-v7/kind-map.ts (74 entries: subcommand → op_kind → mcp_tool),
  // which is pure data and imports nothing. NOT from the MCP tool array, even
  // though that is where the typed PARAMETER schemas live: `src/mcp.ts` calls
  // `main()` at module scope, so merely importing it starts the stdio server and
  // writes a telemetry session file under ~/.unbrowse/sessions. A read-only
  // introspection query must not do that, and the obvious guard —
  // `if (isMainModule(...)) main()` — would break the packaged binary, which
  // relies on that exact import side effect (`single-binary.ts:157`, asserted by
  // tests/skill-package-runtime.test.ts).
  //
  // So this ships the surface an agent needs to DISCOVER commands. Typed
  // per-parameter contracts stay open until the tool schemas are separated from
  // their handlers in mcp.ts (1878 lines, handlers inline) — tracked honestly
  // rather than shipped by hand-copying schemas, which would drift on first edit.
  if (command === "schema") {
    const { KIND_MAP } = await import("./cli-v7/kind-map.js");
    // Typed parameter contracts, from the pure schema module. Both imports run
    // nothing: kind-map is data, and the tool schemas were split out of mcp.ts
    // precisely so reading them cannot start the stdio server.
    const { TOOL_SCHEMAS } = await import("./mcp-tool-schemas.js");
    const schemaByTool = new Map(TOOL_SCHEMAS.map((t) => [t.name, t]));
    const want = args.join(" ").trim();
    const rows = KIND_MAP.map((k) => ({
      subcommand: k.subcommand,
      op_kind: k.op_kind,
      op_class: k.op_class,
      mcp_tool: k.mcp_tool,
    }));
    if (!want) {
      process.stdout.write(JSON.stringify({
        ok: true,
        count: rows.length,
        commands: rows,
        next_step: "unbrowse schema <subcommand|op_kind|mcp_tool> for one entry, with its typed parameters",
      }, null, 2) + "\n");
      // `return`, NOT process.exit(): exit() kills the process before a piped
      // stdout drains, and this payload is >8KB. Measured — it truncated at
      // exactly 8192 bytes, the pipe buffer, producing unparseable JSON. A
      // machine-readable stdout contract that truncates is worse than none.
      process.exitCode = 0;
      return;
    }
    // Exact identifiers first; the bare last-token is a convenience, not a
    // guess. Two subcommands end in "skill", so picking the first match would
    // silently answer a different question than the one asked.
    const exact = rows.find((r) =>
      r.subcommand === want || r.op_kind === want || r.mcp_tool === want);
    const byTail = exact ? [] : rows.filter((r) => r.subcommand.split(" ").slice(-1)[0] === want);
    if (!exact && byTail.length > 1) {
      process.stdout.write(JSON.stringify(buildErrorEnvelope({
        code: "schema_ambiguous_command",
        message: `"${want}" matches ${byTail.length} commands — name one exactly`,
        retryable: false, // the same ambiguous name stays ambiguous
        context: { candidates: byTail.map((r) => r.subcommand) },
      })) + "\n");
      process.stderr.write(`unbrowse: "${want}" is ambiguous: ${byTail.map((r) => r.subcommand).join(", ")}\n`);
      process.exitCode = 64;
      return;
    }
    const hit = exact ?? byTail[0];
    if (!hit) {
      process.stdout.write(JSON.stringify(buildErrorEnvelope({
        code: "schema_unknown_command",
        message: `no such command: ${want}`,
        retryable: false,
      })) + "\n");
      process.stderr.write(`unbrowse: no such command: ${want}\n`);
      process.exitCode = 64;
      return;
    }
    const contract = hit.mcp_tool ? schemaByTool.get(hit.mcp_tool) : undefined;
    process.stdout.write(JSON.stringify({
      ok: true,
      ...hit,
      // Absent for local-only flows, which have no MCP tool and so no contract.
      ...(contract
        ? { description: contract.description, inputSchema: contract.inputSchema }
        : { note: "local-only flow — no tool contract; use --help for its flags" }),
    }, null, 2) + "\n");
    process.exitCode = 0;
    return;
  }

  // (helper defined near its only caller — see the resolution-cache fast path)
  // Hidden worker verb: perform ONE background API-route discovery for a URL and
  // index what it finds. Exists because the CLI is one process per call, so the
  // in-process `void (async () => …)()` that used to do this was killed at exit —
  // measured: the capture logged "queued" and never logged a completion, no
  // route-cache was ever written, and warm calls re-scraped the same HTML.
  // The parent spawns this detached and returns immediately; this child outlives it.
  if (command === "__bg-capture") {
    const url = process.argv[3];
    const bgIntent = process.argv[4] || undefined;
    if (!url) process.exit(2);

    // Own what we cause. Chrome is spawned DETACHED on purpose (cdp/chrome.ts) so
    // an `unbrowse go` session can outlive the one-shot CLI and be re-attached —
    // that is the session model and must not change. But a BACKGROUND capture has
    // no session anyone re-attaches to, so any Chrome it causes has no owner at
    // all: two levels of detachment (CLI → capture child → Chrome) leave nobody
    // holding a reference.
    //
    // Measured consequence: 119 orphaned unbrowse-Chrome processes holding 7.3GB
    // with no driver running, which drove the machine to 0 free memory and made
    // an entire sites100 run time out on sites that answer curl in 35ms.
    //
    // Politeness is not enough — these were not "forgotten", they were KILLED
    // (harness timeout, run end, OOM), and a killed process runs no cleanup. So:
    // a hard deadline, teardown on every exit path INCLUDING signals, and a kill
    // rule that consults the session registry so a browse session is never hit.
    // Backstop first: clear anything a PREVIOUS capture leaked to SIGKILL before
    // adding to the pile. Runs in background workers only — a foreground
    // `unbrowse get` must never pay a `ps` call.
    reapOrphanedChrome();
    const chromePidsBefore = listUnbrowseChromePids();
    let tornDown = false;
    // SYNCHRONOUS on purpose. The first attempt was async (await import + an
    // async session walk) and never ran: cli.ts registers
    // `process.once("SIGTERM", … process.exit(124))` at MODULE SCOPE, which is
    // registered first and exits synchronously, so an async handler is cut off
    // mid-await. Measured: chrome procs 3 → 16 during a capture, still 16 after
    // SIGTERM, and the child's log ended with a bare cli_timeout envelope.
    const teardown = (why: string): void => {
      if (tornDown) return;
      tornDown = true;
      let killed = 0;
      for (const pid of listUnbrowseChromePids()) {
        if (chromePidsBefore.has(pid)) continue;    // predates this capture — not ours
        if (sessionOwnsChromePid(pid)) continue;    // a browse session owns it
        try { process.kill(pid, "SIGTERM"); killed++; } catch { /* already gone */ }
      }
      if (killed > 0) console.error(`[bg-api-capture] ${why}: reaped ${killed} chrome process(es)`);
    };

    // Own the signals. The module-scope handlers exist to flush a machine-JSON
    // envelope for a harness reading stdout — this worker's stdout is "ignore",
    // so nothing reads it, and letting them win means leaking Chrome instead.
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.removeAllListeners(sig);
      process.on(sig, () => { teardown(sig); process.exit(1); });
    }
    process.on("exit", () => teardown("exit"));

    // A capture that cannot finish must still not outlive its budget.
    const deadlineMs = Number(process.env.UNBROWSE_BG_CAPTURE_DEADLINE_MS ?? 180_000);
    const deadline = setTimeout(() => { teardown("deadline"); process.exit(1); }, deadlineMs);
    deadline.unref?.();

    // Proper teardown when we can await: shutdownAllBrowsers() resets the tabs
    // and calls kuri.stop(), which stops the broker AND the Chrome it started.
    // That is a real handle on what this process caused — no pid guessing, no
    // TOCTOU window against a concurrent `unbrowse go`, and no `ps`, so it works
    // on Windows too. The sync pid path above stays ONLY for signals, where
    // awaiting is impossible.
    // BOTH, in this order — neither is sufficient alone.
    //
    // `shutdownAllBrowsers()` → `kuri.stop()` tears down the KURI BROKER, and
    // that is all it does: stopOn() kills `state.process` (kuri), never Chrome.
    // If the broker was reused rather than started here, `state.process` is null
    // and it is a no-op. Measured: graceful teardown logged success while chrome
    // went 3 → 18 and STAYED at 18. A teardown that reports success and frees
    // nothing is worse than none, because it stops you looking.
    //
    // So stop the broker properly, then reap the Chrome it orphaned. The pid
    // path is not a shortcut here — on this path nothing else holds a reference
    // to that Chrome, which is exactly why it leaked in the first place.
    const gracefulTeardown = async (why: string): Promise<void> => {
      try {
        const { shutdownAllBrowsers } = await import("./capture/index.js");
        await shutdownAllBrowsers();
      } catch { /* broker may already be gone */ }
      teardown(why);
    };

    try {
      // Cross the firmament, not an engine. Before this, background discovery
      // took Chrome unconditionally even with UNBROWSE_BROWSER_BACKEND=obscura —
      // one door honoured the backend, this one did not.
      const { captureRoutes } = await import("./capture/engine.js");
      const { passiveIndexFromRequests } = await import("./api/routes.js");
      const cap = await captureRoutes(url, bgIntent);
      // Four outcomes, not two. `routes: []` alone cannot distinguish a dead
      // origin from a page with no API from a page whose API was REFUSED — and
      // this branch used to call the last of those "no API routes discovered
      // (page may be static HTML)", which sends the next caller to fix the wrong
      // thing. The refusal signal was already being produced; it just had no
      // consumer, so the partition that created it stopped one layer short.
      const { describeCaptureOutcome } = await import("./values/capture-report.js");
      const outcome = describeCaptureOutcome({
        engine: cap.engine,
        routeCount: cap.routes.length,
        blocked: cap.blocked,
        error: cap.error,
      });
      console.error(outcome.message);
      if (outcome.shouldIndex) {
        await passiveIndexFromRequests(cap.routes, url, { publishAfterIndex: true });
      }
      await gracefulTeardown("done");
      process.exit(0);
    } catch (err) {
      console.error(`[bg-api-capture] ${(err as Error)?.message ?? err}`);
      await gracefulTeardown("error");
      process.exit(1);
    }
  }

  if (command === "__drain-queue") {
    reapOrphanedChrome();
    try {
      const queueDir = _getQueueDir();
      const { tryAcquireWorkerSlot } = await import("./lib/indexer-core/queue-store.js");
      // Phase 1.1 Day 5 (Model B): child holds the slot for its lifetime.
      // If another worker already holds it, exit cleanly — the sibling drains.
      const slot = await tryAcquireWorkerSlot(queueDir);
      if (slot === null) {
        // Exit 0 (a sibling worker legitimately holds the slot), but SAY SO.
        // Silence here is how a stale worker.lock hid for three days: the
        // drain kept "succeeding" while the pending queue grew and captured
        // routes never became resolvable. Report the backlog so the failure
        // is visible in the one place that would notice it.
        let depth = 0;
        try {
          const { readdirSync } = await import("node:fs");
          depth = readdirSync(queueDir).filter((f) => f.endsWith(".json")).length;
        } catch { /* best-effort */ }
        console.error(
          `[__drain-queue] worker slot held by another drain — skipping.` +
            (depth > 0 ? ` ${depth} job(s) still pending in ${queueDir}.` : ""),
        );
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

  // Top-level help only when there is no command (or explicit `help`).
  // Do NOT swallow `unbrowse auth --help` here — flat commands must route
  // to v7 capability help (live audit 2026-08).
  if (!command || command === "help") {
    printHelp();
    process.exit(0);
  }

  // `health` is the public flat name for the v7 `eval status` capability. It
  // is intentionally handled before generic flat-command derivation because
  // there is no `eval health` row in KIND_MAP; forwarding the original token
  // would otherwise fall through to the one-hole web intent named "health".
  if (command === "health") {
    if (flags.help) {
      printHelp();
      process.exit(0);
    }
    const { runV7 } = await import("./cli-v7/index.js");
    await runV7([process.argv[0], process.argv[1], "eval", "status", ...process.argv.slice(3)]);
    return;
  }



  // Flat legacy command → its verb (build/breath/eval). Without this, every flat
  // command (settings/fetch/search/skills/spec/explain/account/dashboard/...) falls
  // through to the one-hole `breath get` path below and is run as a web-search/
  // capture INTENT — the KNOWN_COMMANDS-drift misroute (`unbrowse settings` would
  // browser-capture duckduckgo/settings). flatCommandVerb is derived from KIND_MAP
  // so it cannot drift; a genuine natural-language intent returns null and falls
  // through to `get`.
  // Forwards --help in argv so `unbrowse auth --help` hits capability help.
  const flatVerb = flatCommandVerb(command);
  if (flatVerb) {
    const { runV7 } = await import("./cli-v7/index.js");
    await runV7([process.argv[0], process.argv[1], flatVerb, command, ...process.argv.slice(3)]);
    return;
  }

  if (flags.help) {
    printHelp();
    process.exit(0);
  }

  // Typo guard: a bare single token ONE edit away from a real command is a
  // mistyped command, not a natural-language intent. Routing it to the web
  // front door would silently web-search the typo (`unbrowse reslove …` must
  // error, not browse). Candidates derive from KIND_MAP's flat surface plus
  // the cli.ts specials — structural, never a hand-kept list. Phrases
  // (whitespace) and genuine intents (distance > 1) route to the one-hole
  // path exactly as before.
  if (!/\s/.test(command)) {
    const near = nearestFlatCommands(command, ["health", "build", "eval", "breath"]);
    if (near.length) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          error: "unknown_command",
          code: "unknown_command",
          command,
          did_you_mean: near,
          hint: `Run \`unbrowse ${near[0]} --help\` for its flags, or quote a natural-language task: unbrowse "<task>" --url <site>.`,
        }) + "\n",
      );
      process.exit(64);
    }
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

// Guard: never auto-run CLI main inside the packaged MCP bundle. Inlined
// cli.ts sees isMainModule(true) when argv[1] is runtime/mcp.js — that used
// to printHelp() onto JSON-RPC stdout and process.exit(0) on first get.
if (shouldAutoRunCliMain(import.meta.url)) {
  // Bench harness (`timeout N unbrowse get … --json`) kills with SIGTERM then
  // SIGKILL. Without a flush, stdout is empty → harness labels bare `no_json`.
  // Emit a final machine-readable error object so classify() sees a real error
  // (cli_timeout) instead of parse failure. Best-effort; never throw.
  const wantsMachineJson =
    process.argv.includes("--json") ||
    process.env.UNBROWSE_NO_PRETTY === "1" ||
    !process.stdout.isTTY;
  let jsonFlushed = false;
  const flushTimeoutJson = (code: string) => {
    if (jsonFlushed || !wantsMachineJson) return;
    jsonFlushed = true;
    try {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          error: code,
          result: null,
          source: null,
          trace: { success: false, error: code },
        }) + "\n",
      );
    } catch { /* ignore */ }
  };
  process.once("SIGTERM", () => {
    flushTimeoutJson("cli_timeout");
    process.exit(124);
  });
  process.once("SIGINT", () => {
    flushTimeoutJson("cli_interrupted");
    process.exit(130);
  });

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
