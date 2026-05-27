/**
 * `unbrowse breath execute <endpoint-id>` —
 * replay a captured endpoint with pointer-resolved headers + body.
 *
 * 1:1 mapping (kind-map.ts row "breath execute"):
 *   CLI subcommand  : breath execute
 *   MCP tool        : unbrowse_execute
 *   Covenant kind   : actuate_execute
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
}

async function fetchEndpointDescriptor(
  endpointId: string,
  apiBase: string,
  parsed: ParsedV7Args,
): Promise<EndpointDescriptor> {
  // Direct-url shortcut — used by tests and by agents who already have a
  // captured URL in hand (no marketplace round-trip needed).
  const urlFlag = typeof parsed.flags.url === "string" ? parsed.flags.url : undefined;
  if (urlFlag) {
    const method = typeof parsed.flags.method === "string" ? parsed.flags.method : "GET";
    return { endpoint_id: endpointId, url: urlFlag, method: method.toUpperCase() };
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

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("breath", "execute")!;

  if (parsed.wantsHelp) {
    helpExit(
      "breath execute",
      {
        summary: "Replay a captured endpoint with pointer-resolved headers + body.",
        usage:
          "unbrowse breath execute <endpoint-id> [--session <id>] [--params '<json>'] [--header Name=<pointer>]... [--url <url>] [--method <verb>] [--raw] [--arg key=value]",
        positional: [
          { name: "endpoint-id", description: "Endpoint id from resolve shortlist.", required: true },
        ],
        flags: [
          { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
          { name: "--params", description: "JSON object of URL/body params (string-valued leaves may be pointers).", value_expected: true },
          { name: "--header", description: "Repeatable: --header Name=<pointer-or-value>.", value_expected: true },
          { name: "--url", description: "Direct URL override (skips marketplace lookup).", value_expected: true },
          { name: "--method", description: "HTTP method (default: GET, or descriptor.method).", value_expected: true },
          { name: "--raw", description: "Return full body (no 10KB truncation)." },
          { name: "--arg", description: "Single arg-scope key (key=value form).", value_expected: true },
          { name: "--argScope", description: "Full arg-scope object as JSON.", value_expected: true },
        ],
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: "breath",
      },
      opts,
    );
  }

  const endpointId = parsed.positional[0];
  if (!endpointId) {
    emit(
      {
        error: "missing_positional",
        subcommand: "breath execute",
        required: ["endpoint-id"],
        got: parsed.positional,
        covenant_kind: meta.covenant_kind,
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
  let descriptor: EndpointDescriptor;
  try {
    descriptor = await fetchEndpointDescriptor(endpointId, apiBase, parsed);
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
  let outgoingUrl = descriptor.url;
  let outgoingBody: string | undefined;
  if (method === "GET" || method === "HEAD") {
    // Splice params onto the query string. paramsObj leaves are strings
    // (either pointer-resolved or pass-through).
    const u = new URL(descriptor.url);
    for (const [k, v] of Object.entries(paramsObj)) {
      if (typeof v === "string") u.searchParams.set(k, v);
    }
    outgoingUrl = u.toString();
  } else {
    // Body methods: descriptor.body (template) takes precedence; if absent,
    // serialize paramsObj as JSON.
    outgoingBody = descriptor.body ?? JSON.stringify(paramsObj);
    if (!("content-type" in outgoingHeaders) && !("Content-Type" in outgoingHeaders)) {
      outgoingHeaders["content-type"] = "application/json";
    }
  }

  // ── fetch() the endpoint ─────────────────────────────────────────────────
  let responseText: string;
  let status: number;
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
        covenant_kind: meta.covenant_kind,
        error: "audit_post_failed",
        audit_failures: auditFailures, // pointers only, never values
        endpoint_id: endpointId,
        status,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  }

  // ── Emit response ────────────────────────────────────────────────────────
  const wantRaw = parsed.flags.raw === true;
  const truncated = !wantRaw && responseText.length > RAW_TRUNCATE_BYTES;
  const responseBodyOut = truncated ? responseText.slice(0, RAW_TRUNCATE_BYTES) : responseText;

  emit(
    {
      ok: true,
      subcommand: "breath execute",
      covenant_kind: meta.covenant_kind,
      session_id: sessionId,
      endpoint_id: endpointId,
      url: outgoingUrl, // url is data, not a secret
      method,
      status,
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
    },
    opts,
  );
  process.exit(0);
}
