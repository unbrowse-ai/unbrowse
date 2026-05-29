/**
 * `unbrowse eval feedback` — submit feedback on the last execute.
 *
 * 1:1 mapping (kind-map.ts row "eval feedback"):
 *   CLI subcommand  : eval feedback
 *   MCP tool        : unbrowse_feedback
 *   Op kind   : eval:feedback
 *   Verb            : eval
 *
 * Schema invariant: the feedback body MUST be commitment-only (see
 * VALUE_STORE_ADAPTERS.md §"Security invariants" #3). The backend
 * type `FeedbackBody` (backend/src/types.ts) forbids a `value` field
 * on any fill-related event.
 *
 * Wire: POST `${UNBROWSE_API_URL}/v1/stats/feedback`
 * Body: `{ skill_id, endpoint_id, rating }` (+ optional `note`).
 *
 * NOTE-SANITIZATION INVARIANT (load-bearing — no-stubs rule, CLAUDE.md):
 * `--note` is user-supplied free text. Before POST we run it through
 * `sanitizeNote()` which strips any token matching a value-pointer
 * prefix (op://, keychain://, bw://, arg://) or a common secret-shape
 * regex. Pointers/secrets in --note are a category error — feedback is
 * a cross-user aggregate and MUST never carry a user's resolved values.
 */
import type { ParsedV7Args } from "../args.js";
import {
  EX_GENERIC,
  EX_USAGE,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { postStateless } from "../_stateless.js";

const POINTER_PREFIXES = ["op://", "keychain://", "bw://", "arg://"] as const;
const SECRET_REGEXES: ReadonlyArray<{ re: RegExp; tag: string }> = [
  { re: /\bBearer\s+[A-Za-z0-9._\-]{8,}\b/gi, tag: "[redacted:bearer]" },
  { re: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g, tag: "[redacted:jwt]" },
  { re: /\bsk_[A-Za-z0-9]{16,}\b/g, tag: "[redacted:sk-key]" },
];

/**
 * Strip any pointer-shaped or secret-shaped substring from a free-form
 * note. Each match is replaced by `[redacted:<reason>]`. Exported so
 * the test suite can pin the sanitization surface.
 */
export function sanitizeNote(raw: string): string {
  let out = raw;
  // Pointer prefixes: redact the whole token (split on whitespace).
  out = out
    .split(/(\s+)/)
    .map((tok) => {
      for (const prefix of POINTER_PREFIXES) {
        if (tok.startsWith(prefix)) return "[redacted:pointer]";
      }
      return tok;
    })
    .join("");
  for (const { re, tag } of SECRET_REGEXES) {
    out = out.replace(re, tag);
  }
  return out;
}

function defaultApiBase(): string {
  return (
    process.env.UNBROWSE_API_URL ??
    process.env.UNBROWSE_BACKEND_URL ??
    "https://beta-api.unbrowse.ai"
  );
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "feedback")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval feedback",
      {
        summary: meta.summary,
        usage: "unbrowse eval feedback <skill-id> --endpoint <endpoint-id> --rating <1-5> [--note <text>]",
        positional: [
          { name: "skill-id", description: "Skill id the feedback targets.", required: true },
        ],
        flags: [
          { name: "--endpoint", description: "Endpoint id this feedback targets.", value_expected: true },
          { name: "--rating", description: "Integer rating 1..5.", value_expected: true },
          { name: "--note", description: "Free-form note (sanitized — pointers/secrets stripped).", value_expected: true },
          { name: "--session", description: "Session id (for the audit trail).", value_expected: true },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const skillId = parsed.positional[0];
  const endpointFlag = parsed.flags.endpoint;
  const endpointId = typeof endpointFlag === "string" ? endpointFlag : undefined;
  const ratingFlag = typeof parsed.flags.rating === "string" ? parsed.flags.rating : undefined;
  const noteFlag = typeof parsed.flags.note === "string" ? parsed.flags.note : undefined;

  if (!skillId || !endpointId || !ratingFlag) {
    emit(
      {
        ok: false,
        subcommand: "eval feedback",
        op_kind: meta.op_kind,
        error: "missing_required",
        required: ["skill-id", "--endpoint", "--rating"],
        got: { skill_id: skillId, endpoint: endpointId, rating: ratingFlag },
      },
      opts,
    );
    process.exit(EX_USAGE);
  }

  const rating = parseInt(ratingFlag, 10);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    emit(
      {
        ok: false,
        subcommand: "eval feedback",
        op_kind: meta.op_kind,
        error: "bad_rating",
        hint: "rating must be an integer 1..5",
      },
      opts,
    );
    process.exit(EX_USAGE);
  }

  const sanitizedNote = noteFlag ? sanitizeNote(noteFlag) : undefined;

  const body: Record<string, unknown> = {
    skill_id: skillId,
    endpoint_id: endpointId,
    rating,
  };
  if (sanitizedNote !== undefined) body.note = sanitizedNote;

  const apiBase = defaultApiBase();

  // Route through `postStateless` so the body is wallet-signed + sig-keyed.
  // The backend `/v1/stats/feedback` route gracefully ignores the extra
  // {walletPubkey, signature, signatureScheme, nonce} fields — we still
  // get the existing 200 ack semantics, but the agent now holds a stable
  // `cacheKey` pointer back to the truth-claim it sealed.
  try {
    const post = await postStateless({
      namespace: "audit",
      route: "/v1/stats/feedback",
      body,
      signableFields: ["skill_id", "endpoint_id", "rating", "note", "nonce"],
      apiBaseUrl: apiBase,
    });
    if (post.ok) {
      emit(
        {
          ok: true,
          subcommand: "eval feedback",
          op_kind: meta.op_kind,
          posted: { ...body, note_sanitized: sanitizedNote !== undefined },
          cacheKey: post.cacheKey,
          receiptId: post.receiptId ?? null,
          idempotent: post.idempotent,
          http_status: post.httpStatus,
        },
        opts,
      );
      process.exit(0);
    }
    if (post.bindingMissing) {
      emit(
        {
          ok: false,
          subcommand: "eval feedback",
          op_kind: meta.op_kind,
          error: "binding_missing",
          binding_missing: post.bindingMissing,
          cacheKey: post.cacheKey,
          http_status: post.httpStatus,
        },
        opts,
      );
      process.exit(EX_GENERIC);
    }
    emit(
      {
        ok: false,
        subcommand: "eval feedback",
        op_kind: meta.op_kind,
        error: post.errorHint ?? `http_${post.httpStatus}`,
        cacheKey: post.cacheKey,
        http_status: post.httpStatus,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
