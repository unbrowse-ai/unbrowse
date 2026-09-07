/**
 * `unbrowse breath execute <endpoint-id>` —
 * replay a captured endpoint with pointer-resolved headers + body.
 *
 * 1:1 mapping (kind-map.ts row "breath execute"):
 *   CLI subcommand  : breath execute
 *   MCP tool        : unbrowse_execute
 *   Op kind   : breath:execute
 *   Verb            : breath
 *
 * Pattern (mirrors fill.ts secret-redaction discipline):
 *   1. Resolve endpoint descriptor (server fetch by id or local cache).
 *   2. For each `--header Name=<pointer>` and each pointer-shaped value in
 *      `--params`: dereference via src/values/, sign, post audit row of the
 *      matching variant ('header-inject' or 'payload-field'), splice the
 *      resolved bytes ONLY into the outgoing fetch request body/header
 *      pre-send, then zero+dispose.
 *   3. fetch() the endpoint URL with substituted headers/body. Response goes
 *      to stdout (truncated to 10KB unless --raw).
 *
 * Secret-redaction invariants (LOAD-BEARING):
 *   - Resolved header/payload values become strings only at the boundary of
 *     the outgoing fetch options object. The strings are scope-local; they
 *     are never logged, never printed, never returned, never written to
 *     the session file.
 *   - The audit POST for each pointer carries hashes only (variant +
 *     headerNameHash OR payloadPath), never the value.
 *   - Stdout carries the response body (which is data the caller asked for),
 *     and the pointer URIs the caller supplied — never the resolved bytes.
 *
 * Exit codes:
 *   0   success — fetch completed AND every audit POST returned 2xx
 *   65  EX_DATAERR equivalent — endpoint lookup failed / fetch errored
 *   70  EX_SOFTWARE — value-store adapter failed
 *   1   generic failure (audit POST non-2xx, json parse, etc.)
 */
import { randomBytes, createHash } from "node:crypto";

import {
  resolve as resolveValue,
  safeZero,
  looksLikePointer,
} from "../../values/index.js";
import { extractTemplateQueryBindings } from "../../template-params.js";
import type { ParsedV7Args } from "../args.js";
import { resolveSession } from "../_session.js";
import {
  EX_GENERIC,
  EX_SOFTWARE,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { postStateless } from "../_stateless.js";
import { listLocalSkills } from "../../client/index.js";
import { resolutionContractVerdict } from "../../values/resolution-contract.js";
import { persistVerdictOnChain } from "../../values/contract-everything.js";
import { recordCreativityAct } from "../../values/creativity-economy.js";

const EX_CDP = 65;
const FIVE_MINUTES_MS = 300_000;
const RAW_TRUNCATE_BYTES = 10 * 1024;

// AuditFillBody mirror — kept byte-identical with backend/src/services/audit.ts
// (and src/cli-v7/breath/fill.ts) so the server canonicalize/verify path
// agrees with the bytes the wallet signed. See fill.ts for the discipline.
type AuditVariant = "fill" | "header-inject" | "payload-field";
type SignatureScheme = "ed25519-v7.0" | "groth16-v7.3";
interface AuditFillBody {
  pointer: string;
  nonce: string;
  contextHash: string;
  commitment: string;
  walletPubkey: string;
  signatureScheme?: SignatureScheme;
  signature: string;
  variant: AuditVariant;
  urlHash?: string;
  selectorHash?: string;
  headerNameHash?: string;
  payloadPath?: string;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function bytesToHex(b: Uint8Array): string {
  let h = "";
  for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, "0");
  return h;
}

function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

/**
 * Per-pointer contextHash for header-inject / payload-field. Binds the
 * fill act to (session, endpointId, url, headerName-or-jsonPath, 5-min
 * bucket) — the byte layout mirrors fill.ts but with the field-locator
 * substituted for the CSS selector.
 *
 *   contextHash = hex( sha256(
 *     sessionId || ":" || locator || ":" || url || ":" ||
 *     floor(Date.now() / 300_000)
 *   ) )
 */
function deriveExecContextHash(
  sessionId: string,
  locator: string,
  url: string,
  nowMs: number = Date.now(),
): string {
  const bucket = Math.floor(nowMs / FIVE_MINUTES_MS).toString();
  const payload = `${sessionId}:${locator}:${url}:${bucket}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Parse `--arg key=value` AND `--argScope <json>`. Same shape as fill.ts.
 */
function parseArgScope(parsed: ParsedV7Args): Record<string, string> {
  const out: Record<string, string> = {};
  const scope = parsed.flags["argScope"] ?? parsed.flags["arg-scope"];
  if (typeof scope === "string") {
    try {
      const p = JSON.parse(scope) as Record<string, unknown>;
      for (const [k, v] of Object.entries(p)) {
        if (typeof v === "string") out[k] = v;
      }
    } catch {
      // ignore malformed JSON — adapter surfaces arg_missing on key miss
    }
  }
  const single = parsed.flags["arg"];
  if (typeof single === "string") {
    const eq = single.indexOf("=");
    if (eq > 0) out[single.slice(0, eq)] = single.slice(eq + 1);
  }
  return out;
}

/**
 * v7 argv parser collapses repeated --header flags to the last occurrence.
 * Recover the multi-value form by re-scanning process.argv (the canonical
 * surface). Returns an array of [name, pointerOrValue] tuples in order.
 */
function parseRepeatableHeaders(argv: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--header" || tok === "-H") {
      const next = argv[i + 1];
      if (typeof next === "string" && next.indexOf("=") > 0) {
        const eq = next.indexOf("=");
        out.push([next.slice(0, eq), next.slice(eq + 1)]);
        i++;
      }
      continue;
    }
    if (tok.startsWith("--header=")) {
      const body = tok.slice("--header=".length);
      const eq = body.indexOf("=");
      if (eq > 0) out.push([body.slice(0, eq), body.slice(eq + 1)]);
      continue;
    }
  }
  return out;
}

/**
 * `-p key=value` / `--param key=value`, repeatable — the documented
 * alternative to `--params '<json>'` (SKILL.md, and `unbrowse --help`'s
 * execute row). The v7 argv parser has no short-flag-with-value form, so it
 * turned `-p` into a bare boolean and dropped `key=value` into the POSITIONAL
 * list, where two things were true at once: nothing ever read it, and it
 * shadowed the endpoint-id positional. Recovered from argv exactly the way
 * repeated `--header` is.
 *
 * `consumed` is the set of tokens that were eaten as `-p` values; the
 * endpoint-id positional fallback skips them, so `-p q=hello` can never be
 * mistaken for an endpoint id.
 */
function parseRepeatableParams(
  argv: readonly string[],
): { pairs: Array<[string, string]>; consumed: Set<string> } {
  const pairs: Array<[string, string]> = [];
  const consumed = new Set<string>();
  const push = (kv: string): void => {
    const eq = kv.indexOf("=");
    if (eq > 0) pairs.push([kv.slice(0, eq), kv.slice(eq + 1)]);
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "-p" || tok === "--param") {
      const next = argv[i + 1];
      if (typeof next === "string" && next.indexOf("=") > 0) {
        push(next);
        consumed.add(next);
        i++;
      }
      continue;
    }
    if (tok.startsWith("--param=")) {
      push(tok.slice("--param=".length));
      continue;
    }
    if (tok.startsWith("-p=")) {
      push(tok.slice("-p=".length));
      continue;
    }
  }
  return { pairs, consumed };
}

/**
 * Look the endpoint up in THIS MACHINE'S route store — the same
 * `listLocalSkills()` data `eval resolve` builds its local shortlist from.
 * This is what makes the documented two-call path (`resolve` → `execute
 * --skill … --endpoint …`) close over a locally captured route: resolve hands
 * back `{skill_id, endpoint_id}` out of the local cache, and without this
 * execute could only re-look-them-up through the marketplace, which by
 * construction has never seen an unpublished local capture.
 *
 * `headers_template` is deliberately NOT replayed: captured header templates
 * are the pointer-not-payload boundary, and this handler's contract is that
 * every header it sends came from an explicit `--header` (audited when it is
 * a pointer). Only the URL + method cross.
 */
export function localEndpointDescriptor(
  skillId: string | undefined,
  endpointId: string,
): EndpointDescriptor | null {
  let skills: ReturnType<typeof listLocalSkills>;
  try {
    skills = listLocalSkills();
  } catch {
    return null; // best-effort: a broken cache is a miss, never a crash
  }
  for (const skill of skills) {
    if (skillId && skill.skill_id !== skillId) continue;
    for (const ep of skill.endpoints ?? []) {
      if (ep.endpoint_id !== endpointId) continue;
      if (typeof ep.url_template !== "string" || ep.url_template.length === 0) continue;
      return {
        endpoint_id: ep.endpoint_id,
        url: ep.url_template,
        method: (ep.method ?? "GET").toUpperCase(),
        body: ep.body ? JSON.stringify(ep.body) : undefined,
        // Carry the captured defaults. Dropping them here was silently fatal:
        // the snapshot holds the real observed values, but the descriptor
        // rebuilt for replay omitted them, so every templated route went out
        // with its placeholders unsubstituted and the server 400'd.
        query: (ep as { query?: Record<string, unknown> }).query,
      };
    }
  }
  return null;
}

/**
 * Endpoint descriptor — minimum surface needed to replay. Sourced from
 * the marketplace / local cache. We accept either a remote-fetched shape
 * (when `UNBROWSE_API_URL/v1/endpoints/<id>` answers 200) OR the agent
 * provides `--url` + `--method` directly. The latter is the load-bearing
 * surface for v7.0 because the marketplace fetch path isn't wired yet at
 * this wave; agents that already know the URL skip the lookup.
 */
interface EndpointDescriptor {
  endpoint_id: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string; // raw body template (may be JSON)
  /**
   * Observed values for the templated query params, keyed by the REAL param
   * name (`features`), not the placeholder (`{features}`). Capture stores these
   * so templating stays lossless (see buildTemplate in capture/reveng-local.ts);
   * replay needs them because a hole the caller did not fill has exactly one
   * correct value — the one the site was seen sending. Without it a route like
   * x.com's `Bookmarks?variables={variables}&features={features}` can never be
   * replayed: `features` is a ~40-key JSON blob no agent can guess.
   */
  query?: Record<string, unknown>;
}

async function fetchEndpointDescriptor(
  endpointId: string,
  apiBase: string,
  parsed: ParsedV7Args,
  skillId?: string,
): Promise<EndpointDescriptor & { source: "url_flag" | "local_cache" | "marketplace" }> {
  // Direct-url shortcut — used by tests and by agents who already have a
  // captured URL in hand (no marketplace round-trip needed).
  const urlFlag = typeof parsed.flags.url === "string" ? parsed.flags.url : undefined;
  if (urlFlag) {
    const method = typeof parsed.flags.method === "string" ? parsed.flags.method : "GET";
    return { endpoint_id: endpointId, url: urlFlag, method: method.toUpperCase(), source: "url_flag" };
  }
  // Cheapest rung first: this machine's own route store, which is the only
  // place a captured-but-unpublished route exists.
  const local = localEndpointDescriptor(skillId, endpointId);
  if (local) {
    const methodOverride = typeof parsed.flags.method === "string" ? parsed.flags.method.toUpperCase() : undefined;
    return { ...local, method: methodOverride ?? local.method, source: "local_cache" };
  }
  // Marketplace lookup. The wire shape mirrors backend/src/routes/endpoints.ts.
  const lookupUrl = `${apiBase.replace(/\/$/, "")}/v1/endpoints/${encodeURIComponent(endpointId)}`;
  const res = await fetch(lookupUrl, { method: "GET" });
  if (!res.ok) {
    throw new Error(`endpoint_lookup_failed:${res.status}:${endpointId}`);
  }
  const raw = (await res.json()) as Partial<EndpointDescriptor>;
  if (typeof raw.url !== "string" || typeof raw.method !== "string") {
    throw new Error(`endpoint_descriptor_malformed:${endpointId}`);
  }
  return {
    endpoint_id: endpointId,
    url: raw.url,
    method: raw.method.toUpperCase(),
    headers: raw.headers,
    body: raw.body,
    source: "marketplace",
  };
}

interface ResolvedSlot {
  /** "header-inject" or "payload-field" */
  variant: AuditVariant;
  /** Header name (variant=header-inject) OR JSON-path (variant=payload-field). */
  locator: string;
  /** Pointer URI (op://, keychain://, bw://, arg://). */
  pointerUri: string;
  /** Bytes-to-splice — scope-local; zeroed on dispose. */
  bytes: Uint8Array;
  /** Adapter handle (for asyncDispose). */
  handle: AsyncDisposable;
  /** Audit body the handler will POST after the splice succeeds. */
  body: AuditFillBody;
}

/**
 * Resolve a single pointer slot — wraps the value-store call so the
 * commitment + signature land in an AuditFillBody for later POST.
 *
 * The bytes returned MUST be consumed (spliced into the outgoing fetch)
 * before the slot's `handle.asyncDispose()` runs; safeZero zeros them in
 * place when dispose fires, and Web Crypto's `fetch` already copies the
 * body bytes into its own outgoing-buffer by the time await returns.
 */
async function resolveSlot(opts: {
  variant: AuditVariant;
  locator: string;
  pointerUri: string;
  inlineArgScope: Record<string, string>;
  sessionId: string;
  url: string;
}): Promise<ResolvedSlot> {
  const nonce = new Uint8Array(randomBytes(32));
  const contextHashHex = deriveExecContextHash(opts.sessionId, opts.locator, opts.url);
  const contextHashBytes = Buffer.from(contextHashHex, "hex");

  const resolved = await resolveValue(opts.pointerUri, nonce, {
    contextHash: contextHashBytes,
    argScope: opts.inlineArgScope,
  });

  const body: AuditFillBody = {
    pointer: opts.pointerUri,
    nonce: bytesToBase64(nonce),
    contextHash: contextHashHex,
    commitment: bytesToHex(resolved.commitment),
    walletPubkey: bytesToHex(resolved.walletPubkey),
    signatureScheme: "ed25519-v7.0",
    signature: bytesToHex(resolved.signature),
    variant: opts.variant,
    urlHash: opts.url ? sha256Hex(opts.url) : undefined,
  };
  if (opts.variant === "header-inject") {
    body.headerNameHash = sha256Hex(opts.locator);
  } else {
    body.payloadPath = opts.locator;
  }

  return {
    variant: opts.variant,
    locator: opts.locator,
    pointerUri: opts.pointerUri,
    bytes: resolved.value,
    handle: resolved,
    body,
  };
}

/**
 * Walk a params object; for every leaf whose string value looks like a
 * pointer, return its JSON-path so resolveSlot can dereference it.
 * Top-level string-keyed map (no nested arrays in v7.0) — `params={q: ...}`
 * for query strings, `params={body: {...}}` for JSON bodies.
 */
function findPointerLeaves(params: Record<string, unknown>, prefix = "$"): Array<{ path: string; pointer: string }> {
  const out: Array<{ path: string; pointer: string }> = [];
  for (const [k, v] of Object.entries(params)) {
    const path = `${prefix}.${k}`;
    if (typeof v === "string") {
      if (looksLikePointer(v)) out.push({ path, pointer: v });
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...findPointerLeaves(v as Record<string, unknown>, path));
    }
  }
  return out;
}

/**
 * Splice a resolved value into a params tree at a JSON-path. Mutates in
 * place; returns the same reference. The resolved-string boundary lives
 * here.
 */
function spliceParamsAtPath(
  params: Record<string, unknown>,
  path: string,
  bytes: Uint8Array,
): void {
  // path = "$.a.b.c" → segs = ["a", "b", "c"]
  const segs = path.replace(/^\$\.?/, "").split(".").filter((s) => s.length > 0);
  if (segs.length === 0) return;
  // THE one allowed Uint8Array → string boundary on the payload path.
  // eslint-disable-next-line no-tostring-on-secret -- fetch boundary
  const valueAsString = new TextDecoder("utf-8").decode(bytes);
  let cur: Record<string, unknown> = params;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = cur[segs[i]];
    if (next && typeof next === "object" && !Array.isArray(next)) {
      cur = next as Record<string, unknown>;
    } else {
      return; // path no longer exists — silently drop (shouldn't happen)
    }
  }
  cur[segs[segs.length - 1]] = valueAsString;
}

/**
 * Map a numeric HTTP status to the canonical status_class enum the
 * backend's trace-state schema accepts. Returns undefined for non-1xx-5xx
 * (e.g., the `-1` we use for network errors in the legacy audit path) so
 * the field is omitted from the wire body — trace-state validates absent
 * as legitimate "no class known".
 */
function statusToClass(
  status: number,
): "2xx" | "3xx" | "4xx" | "5xx" | undefined {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return undefined;
}

export interface ExecuteOutcomeInput {
  status: number;
  replayReceipt: {
    ok: boolean;
    bindingMissing?: string;
    errorHint?: string;
  };
  contract: { terminal: boolean; frontier?: string | null };
}

export interface ExecuteOutcomeFailure {
  error: "transport_status_invalid" | "http_error" | "replay_receipt_invalid" | "contract_unsettled";
  blocker: "transport" | "upstream_http" | "replay_receipt" | "contract";
  next_step: string;
}

/** The terminal execute envelope is green only when every required witness is green. */
export function evaluateExecuteOutcome(input: ExecuteOutcomeInput): ExecuteOutcomeFailure | null {
  if (!Number.isInteger(input.status) || input.status <= 0) {
    return {
      error: "transport_status_invalid",
      blocker: "transport",
      next_step: "Retry the request; if status remains 0, inspect Chromium/network reachability before replaying.",
    };
  }
  if (input.status >= 400) {
    return {
      error: "http_error",
      blocker: "upstream_http",
      next_step: "Inspect response_body and authentication state, then retry only after the upstream error is resolved.",
    };
  }
  if (input.replayReceipt.ok !== true || input.replayReceipt.bindingMissing || input.replayReceipt.errorHint) {
    return {
      error: "replay_receipt_invalid",
      blocker: "replay_receipt",
      next_step: "Restore the stateless trace binding and replay; an unreceipted execution is not settled.",
    };
  }
  if (input.contract.terminal !== true) {
    return {
      error: "contract_unsettled",
      blocker: "contract",
      next_step: `Settle the contract frontier (${input.contract.frontier ?? "unknown"}) before promoting this replay.`,
    };
  }
  return null;
}

/**
 * Extract host-only from a URL. The trace-state schema rejects scheme,
 * path, query, port, userinfo — so we sanitise here, not at the wire
 * layer. Returns "" on parse failure; caller should skip the POST.
 *
 * Pointer-only: the full URL stays in stdout (data the caller asked for)
 * and in the audit row's `urlHash` field — only the bare host crosses
 * the trace-state firmament so per-domain rollups stay coherent
 * (Day-2 §G #2; trace-state.ts `isValidHostOnly`).
 */
function safeHostOnly(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return "";
  }
}

/**
 * Emit one trace-append row capturing the execute replay as a
 * `breath_act_execute_replay` step. Carries
 * pointer-only fields (sessionId, host, status_class, duration_ms) per
 * the trace-state schema (forbidden: URL, path, query, headers, body).
 *
 * NEVER throws — postStateless surfaces failure via the result shape.
 * The receipt id (cacheKey) lets Day-7 bench-gate replay the trace
 * without ever needing the original request payload.
 */
async function emitExecuteReplayTrace(opts: {
  sessionId: string;
  outgoingUrl: string;
  status: number;
  durationMs: number;
  endpointId: string;
}): Promise<{
  ok: boolean;
  cacheKey?: string;
  bindingMissing?: string;
  errorHint?: string;
}> {
  const domain = safeHostOnly(opts.outgoingUrl);
  if (!domain) {
    return { ok: false, errorHint: "url_unparseable_for_host" };
  }
  // step name follows the decision-trace convention (CLAUDE.md
  // §"Decision-trace step naming convention"): `<scope>_<action>` with
  // the breath-act scope so Day-7 gate can grep this exact label.
  const traceStep = {
    step: "breath_act_execute_replay",
    duration_ms: Math.max(0, Math.floor(opts.durationMs)),
    status_class: statusToClass(opts.status),
    // error_code stays absent on success — schema treats undefined as
    // "no error classification known", which is the honest read for
    // any status_class we surface.
  };
  const result = await postStateless({
    namespace: "trace",
    route: "/v1/trace/append",
    body: {
      sessionId: opts.sessionId,
      domain,
      traces: [traceStep],
    },
    signableFields: ["sessionId", "domain", "traces", "nonce"],
  });
  return {
    ok: result.ok,
    cacheKey: result.cacheKey,
    bindingMissing: result.bindingMissing,
    errorHint: result.errorHint,
  };
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("breath", "execute")!;

  if (parsed.wantsHelp) {
    helpExit(
      "breath execute",
      {
        summary: "Replay a captured endpoint with pointer-resolved headers + body.",
        usage:
          "unbrowse execute --skill <id> --endpoint <id> [-p key=value]... [--dry-run] [--session <id>] [--params '<json>'] [--header Name=<pointer>]... [--url <url>] [--method <verb>] [--raw] [--arg key=value]",
        positional: [
          { name: "endpoint-id", description: "Endpoint id from the resolve shortlist. Equivalent to --endpoint.", required: false },
        ],
        flags: [
          { name: "--skill", description: "Skill id from the resolve shortlist; scopes the local route-store lookup.", value_expected: true },
          { name: "--endpoint", description: "Endpoint id from the resolve shortlist (canonical form of the positional).", value_expected: true },
          { name: "-p", description: "Repeatable: -p key=value. Merged over --params.", value_expected: true },
          { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
          { name: "--params", description: "JSON object of URL/body params (string-valued leaves may be pointers).", value_expected: true },
          { name: "--header", description: "Repeatable: --header Name=<pointer-or-value>.", value_expected: true },
          { name: "--url", description: "Direct URL override (skips marketplace lookup).", value_expected: true },
          { name: "--method", description: "HTTP method (default: GET, or descriptor.method).", value_expected: true },
          { name: "--dry-run", description: "Print the request that WOULD be sent; sends nothing, resolves no pointer." },
          { name: "--raw", description: "Return full body (no 10KB truncation)." },
          { name: "--arg", description: "Single arg-scope key (key=value form).", value_expected: true },
          { name: "--argScope", description: "Full arg-scope object as JSON.", value_expected: true },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "breath",
      },
      opts,
    );
  }

  // `-p key=value` is recovered from argv before anything reads positionals:
  // its VALUES are positionals as far as the v7 parser is concerned, and an
  // endpoint id taken from `positional[0]` would otherwise be `q=hello`.
  const { pairs: kvParams, consumed: kvConsumed } = parseRepeatableParams(process.argv.slice(2));

  // THE documented invocation is `unbrowse execute --skill ID --endpoint ID`
  // (SKILL.md two-call path, `unbrowse --help`). Both are value-flags in the
  // v7 parser, so they never land in `positional` — reading `positional[0]`
  // alone meant the documented call could not reach this code AT ALL: it
  // always exited `missing_positional` with `got: []`. The positional form
  // stays supported; the flags are now the canonical spelling.
  const skillId =
    typeof parsed.flags.skill === "string" ? parsed.flags.skill
      : typeof parsed.flags["skill-id"] === "string" ? parsed.flags["skill-id"]
        : undefined;
  const endpointId =
    (typeof parsed.flags.endpoint === "string" ? parsed.flags.endpoint
      : typeof parsed.flags["endpoint-id"] === "string" ? parsed.flags["endpoint-id"]
        : undefined)
    ?? parsed.positional.find((p) => !kvConsumed.has(p));
  if (!endpointId) {
    emit(
      {
        error: "missing_endpoint_id",
        subcommand: "breath execute",
        required: ["--endpoint <id> (or the endpoint-id positional)"],
        got: parsed.positional,
        hint: "unbrowse execute --skill <skill_id> --endpoint <endpoint_id> — ids come from `unbrowse resolve`.",
        op_kind: meta.op_kind,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  }

  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;
  const apiBase = process.env.UNBROWSE_API_URL ?? "https://beta-api.unbrowse.ai";
  const auditUrl = `${apiBase.replace(/\/$/, "")}/v1/audit/fill`;

  // Resolve (or synthesize) the session record. v7 stateless invariant: a
  // session record always exists by the time execute runs — but for direct-
  // url replay without a prior `breath go`, we synthesize a transient id so
  // the audit row's contextHash binding still has a stable sessionId.
  let sessionId: string;
  try {
    const rec = await resolveSession(sessionFlag);
    sessionId = rec.sessionId;
  } catch {
    sessionId = `execute-${Date.now().toString(36)}`;
  }

  // ── Resolve endpoint descriptor (or direct --url shortcut) ───────────────
  let descriptor: EndpointDescriptor & { source: "url_flag" | "local_cache" | "marketplace" };
  try {
    descriptor = await fetchEndpointDescriptor(endpointId, apiBase, parsed, skillId);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_CDP);
  }

  // ── Parse repeatable --header flags + --params JSON ──────────────────────
  // v7's arg parser collapses repeats; recover by re-scanning argv.
  const rawHeaders = parseRepeatableHeaders(process.argv.slice(2));
  const inlineArgScope = parseArgScope(parsed);

  let paramsObj: Record<string, unknown> = {};
  const paramsFlag = typeof parsed.flags.params === "string" ? parsed.flags.params : undefined;
  if (paramsFlag) {
    try {
      const parsedParams = JSON.parse(paramsFlag);
      if (parsedParams && typeof parsedParams === "object" && !Array.isArray(parsedParams)) {
        paramsObj = parsedParams as Record<string, unknown>;
      }
    } catch {
      // ignore malformed; downstream sees an empty params
    }
  }
  // `-p key=value` lands in the SAME params tree as `--params '<json>'` — the
  // docs call them alternatives, so they have to mean the same thing. Merged
  // last (the more specific spelling wins) and BEFORE the pointer walk below,
  // so `-p token=op://vault/item` is dereferenced + audited exactly like a
  // pointer leaf inside `--params`.
  for (const [k, v] of kvParams) paramsObj[k] = v;

  // ── `--dry-run` — stop at PROPOSE ────────────────────────────────────────
  // SKILL.md says "Always --dry-run first" before a mutation. The flag was
  // documented and never read, which for a SAFETY flag is worse than inert:
  // `execute --skill … --endpoint … --dry-run` fired the real request while
  // reading as if it had not. Stopping here — BEFORE the pointer walk — also
  // means a dry run never dereferences a secret and never writes an audit
  // row, mirroring `breath fill-form`'s PROPOSE stop.
  const dryRun = parsed.flags["dry-run"] === true || parsed.flags["dryRun"] === true;
  if (dryRun) {
    const plannedMethod = descriptor.method || "GET";
    let plannedUrl = descriptor.url;
    if (plannedMethod === "GET" || plannedMethod === "HEAD") {
      try {
        const u = new URL(descriptor.url);
        // Pointer leaves stay as their pointer URI: a dry run resolves nothing.
        for (const [k, v] of Object.entries(paramsObj)) {
          if (typeof v === "string" && !looksLikePointer(v)) u.searchParams.set(k, v);
        }
        plannedUrl = u.toString();
      } catch { /* unparseable template — report it verbatim */ }
    }
    emit(
      {
        ok: true,
        subcommand: "breath execute",
        op_kind: meta.op_kind,
        dry_run: true,
        sent: false,
        session_id: sessionId,
        skill_id: skillId ?? null,
        endpoint_id: endpointId,
        endpoint_source: descriptor.source,
        url: plannedUrl,
        method: plannedMethod,
        param_keys: Object.keys(paramsObj),
        header_names: rawHeaders.map(([n]) => n),
        // Pointer URIs + locators only — the same receipt shape the real path
        // emits, minus every field that only exists once a value was resolved.
        pointers: [
          ...rawHeaders
            .filter(([, v]) => looksLikePointer(v))
            .map(([n, v]) => ({ pointer: v, variant: "header-inject", locator: n })),
          ...findPointerLeaves(paramsObj).map((l) => ({
            pointer: l.pointer,
            variant: "payload-field",
            locator: l.path,
          })),
        ],
        note: "dry run — nothing was sent, no pointer was dereferenced, no audit row was written",
      },
      opts,
    );
    process.exit(0);
  }

  // ── Resolve every pointer slot (header + payload) ────────────────────────
  const slots: ResolvedSlot[] = [];
  const outgoingHeaders: Record<string, string> = { ...(descriptor.headers ?? {}) };
  try {
    for (const [name, ptrOrValue] of rawHeaders) {
      if (looksLikePointer(ptrOrValue)) {
        const slot = await resolveSlot({
          variant: "header-inject",
          locator: name,
          pointerUri: ptrOrValue,
          inlineArgScope,
          sessionId,
          url: descriptor.url,
        });
        slots.push(slot);
        // THE one allowed Uint8Array → string boundary for header values.
        // eslint-disable-next-line no-tostring-on-secret -- fetch boundary
        outgoingHeaders[name] = new TextDecoder("utf-8").decode(slot.bytes);
      } else {
        // Non-pointer header values pass through unaudited (caller chose
        // cleartext — outside the witnessed substrate).
        outgoingHeaders[name] = ptrOrValue;
      }
    }

    const pointerLeaves = findPointerLeaves(paramsObj);
    for (const { path, pointer } of pointerLeaves) {
      const slot = await resolveSlot({
        variant: "payload-field",
        locator: path,
        pointerUri: pointer,
        inlineArgScope,
        sessionId,
        url: descriptor.url,
      });
      slots.push(slot);
      spliceParamsAtPath(paramsObj, path, slot.bytes);
    }
  } catch (err) {
    // Best-effort dispose of any slots we did resolve before the failure.
    for (const s of slots) {
      try { safeZero(s.bytes); } catch { /* best-effort */ }
      try { await (s.handle as AsyncDisposable)[Symbol.asyncDispose](); } catch { /* best-effort */ }
    }
    emitErr(err, opts);
    process.exit(EX_SOFTWARE);
  }

  // ── Build outgoing request ───────────────────────────────────────────────
  const method = descriptor.method || "GET";
  const urlHoles = new Set<string>();
  // Placeholder -> captured value, so a hole the caller left unfilled falls back
  // to what the site was observed sending. `extractTemplateQueryBindings` maps
  // param name -> placeholder name; invert it to look the default up by hole.
  const capturedByHole: Record<string, unknown> = {};
  if (descriptor.query && typeof descriptor.query === "object") {
    const bindings = extractTemplateQueryBindings(descriptor.url);
    for (const [paramKey, value] of Object.entries(descriptor.query)) {
      if (value === undefined || value === null) continue;
      capturedByHole[bindings[paramKey] ?? paramKey] = value;
    }
  }
  let outgoingUrl = descriptor.url.replace(/\{([^}]+)\}/g, (whole, name: string) => {
    // Caller params win over captured defaults; a captured default beats
    // shipping the literal `{placeholder}`, which is never what the server wants.
    const value = paramsObj[name] ?? capturedByHole[name];
    if (value === undefined || value === null) return whole;
    urlHoles.add(name);
    return encodeURIComponent(String(value));
  });
  let outgoingBody: string | undefined;
  if (method === "GET" || method === "HEAD") {
    // Splice params onto the query string. paramsObj leaves are strings
    // (either pointer-resolved or pass-through).
    const u = new URL(outgoingUrl);
    for (const [k, v] of Object.entries(paramsObj)) {
      if (typeof v === "string" && !urlHoles.has(k)) u.searchParams.set(k, v);
    }
    outgoingUrl = u.toString();
  } else {
    // Body methods: descriptor.body (template) takes precedence; if absent,
    // serialize paramsObj as JSON.
    if (descriptor.body) {
      try {
        const captured = JSON.parse(descriptor.body) as Record<string, unknown>;
        for (const [key, value] of Object.entries(paramsObj)) {
          if (!urlHoles.has(key) && Object.hasOwn(captured, key)) captured[key] = value;
        }
        // A captured sessionId is deliberately veiled at rest. It is request
        // correlation state, not an authentication credential; replay must mint
        // fresh correlation state rather than transmit the irreversible digest.
        if (typeof captured.sessionId === "string" && /^sha256:[a-f0-9]{64}$/i.test(captured.sessionId)) {
          captured.sessionId = crypto.randomUUID();
        }
        outgoingBody = JSON.stringify(captured);
      } catch {
        outgoingBody = descriptor.body;
      }
    } else {
      outgoingBody = JSON.stringify(Object.fromEntries(Object.entries(paramsObj).filter(([key]) => !urlHoles.has(key))));
    }
    if (!("content-type" in outgoingHeaders) && !("Content-Type" in outgoingHeaders)) {
      outgoingHeaders["content-type"] = "application/json";
    }
  }

  // ── fetch() the endpoint ─────────────────────────────────────────────────
  let responseText: string;
  let status: number;
  const fetchStartMs = Date.now();
  try {
    const res = await fetch(outgoingUrl, {
      method,
      headers: outgoingHeaders,
      body: outgoingBody,
    });
    status = res.status;
    responseText = await res.text();
  } catch (err) {
    // Dispose every slot before bailing.
    for (const s of slots) {
      try { safeZero(s.bytes); } catch { /* best-effort */ }
      try { await (s.handle as AsyncDisposable)[Symbol.asyncDispose](); } catch { /* best-effort */ }
    }
    emitErr(err, opts);
    process.exit(EX_CDP);
  } finally {
    // Always zero + dispose, whether fetch succeeded or threw. fetch() has
    // already copied bytes into its outgoing-buffer by the time await
    // returns, so zeroing here is safe.
    for (const s of slots) {
      try { safeZero(s.bytes); } catch {
        try { s.bytes.fill(0); } catch { /* unrecoverable */ }
      }
      try { await (s.handle as AsyncDisposable)[Symbol.asyncDispose](); } catch { /* best-effort */ }
    }
  }

  // ── POST audit rows (one per resolved pointer) ───────────────────────────
  // Per fill.ts discipline: do NOT post audit rows if the fetch itself
  // failed at the network layer. But we DID get a response (any status),
  // so the splice happened — post the rows.
  const auditFailures: Array<{ pointer: string; status: number }> = [];
  for (const s of slots) {
    try {
      const res = await fetch(auditUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(s.body),
      });
      if (res.status < 200 || res.status >= 300) {
        auditFailures.push({ pointer: s.pointerUri, status: res.status });
      }
    } catch {
      auditFailures.push({ pointer: s.pointerUri, status: -1 });
    }
  }

  if (auditFailures.length > 0) {
    emit(
      {
        ok: false,
        subcommand: "breath execute",
        op_kind: meta.op_kind,
        error: "audit_post_failed",
        audit_failures: auditFailures, // pointers only, never values
        endpoint_id: endpointId,
        status,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  }

  // ── trace-append (Day-6 W2 — execute_replay receipt) ───────────────────
  //
  // The execute act crosses the firmament as a sig-keyed
  // `breath_act_execute_replay` trace row. Day-7 bench-gate walks these
  // rows by sessionId+domain to replay the trace WITHOUT ever needing
  // the original headers/body/response bytes (pointer-only discipline,
  // per CLAUDE.md "pointers over anything" clause B).
  //
  // Failure is honest-surfaced (binding_missing or http error) on the
  // emit envelope; it does NOT change the exit code — the fetch already
  // succeeded, and the agent's caller doesn't need a redundant fail
  // signal when the audit rows above already crossed.
  //
  // Response body bytes are NEVER included; only:
  //   - sessionId (already a witnessed pointer)
  //   - host-only domain (scheme/path/query stripped by safeHostOnly)
  //   - status_class enum (2xx|3xx|4xx|5xx — NEVER raw status code)
  //   - duration_ms
  const replayReceipt = await emitExecuteReplayTrace({
    sessionId,
    outgoingUrl,
    status,
    durationMs: Date.now() - fetchStartMs,
    endpointId,
  });

  // ── Emit response ────────────────────────────────────────────────────────
  const wantRaw = parsed.flags.raw === true;
  const truncated = !wantRaw && responseText.length > RAW_TRUNCATE_BYTES;
  const responseBodyOut = truncated ? responseText.slice(0, RAW_TRUNCATE_BYTES) : responseText;

  // /contract all-the-way-down: the execute act carries the SAME three-shape verdict the
  // resolve path does (interpret the endpoint → verify it routed to an outgoing URL →
  // adjudicate a real <400 result), attached as `_contract`. Pure + fail-open, identical
  // discipline to resolve — evidence, never a blocker. This makes execute /contract-native too.
  const executeVerdict = await resolutionContractVerdict({
    intent: endpointId || outgoingUrl,
    skill: { skill_id: endpointId, endpoints: status < 400 ? [{ status, url: outgoingUrl }] : [] },
    url: outgoingUrl,
  });

  // /contract on-chain call-site: when the operator OPTS IN (UNBROWSE_CONTRACT_ONCHAIN=1), a real
  // terminal execute lands its three-shape verdict on-chain via the IQ signed ledger — fire-and-
  // forget so it never blocks the hot path, fail-open so it can never break execute. DEFAULT
  // installs (no env) fire NOTHING: zero new network, no per-execute cost. This is what makes the
  // verdict ACTUALLY /contract on-chain, not just emitted locally.
  if (process.env.UNBROWSE_CONTRACT_ONCHAIN === "1" && executeVerdict.terminal) {
    void persistVerdictOnChain(executeVerdict, endpointId || outgoingUrl).catch(() => {});
  }

  recordCreativityAct({
    text: `breath execute endpoint:${endpointId} url:${outgoingUrl}`,
    route: endpointId || outgoingUrl,
    cacheHit: false,
  });

  const outcomeFailure = evaluateExecuteOutcome({
    status,
    replayReceipt,
    contract: executeVerdict,
  });

  emit(
    {
      ok: outcomeFailure === null,
      ...(outcomeFailure ?? {}),
      subcommand: "breath execute",
      op_kind: meta.op_kind,
      _contract: executeVerdict,
      session_id: sessionId,
      skill_id: skillId ?? null,
      endpoint_id: endpointId,
      // Where the endpoint descriptor came from: url_flag | local_cache |
      // marketplace. A caller (and a gate) can tell a real local route-store
      // replay from "the URL you already handed me" without guessing.
      endpoint_source: descriptor.source,
      url: outgoingUrl, // url is data, not a secret
      method,
      status,
      // Params that actually reached the wire, keys only — the two-call path's
      // `-p key=value` is either here or it did not happen. Values are never
      // echoed: a param may be a resolved pointer.
      param_keys: Object.keys(paramsObj),
      // The pointer list is the receipt for every resolved slot — never the
      // values, never the resolved bytes.
      pointers: slots.map((s) => ({
        pointer: s.pointerUri,
        variant: s.variant,
        commitment: s.body.commitment,
        locator_hash: s.body.headerNameHash ?? null,
        payload_path: s.body.payloadPath ?? null,
      })),
      response_body: responseBodyOut,
      truncated,
      response_bytes: responseText.length,
      // trace receipt — pointer-only; binding_missing surfaces honestly.
      replay_receipt: {
        ok: replayReceipt.ok,
        cacheKey: replayReceipt.cacheKey,
        binding_missing: replayReceipt.bindingMissing,
        error_hint: replayReceipt.errorHint,
      },
    },
    opts,
  );
  process.exit(outcomeFailure === null ? 0 : EX_GENERIC);
}
