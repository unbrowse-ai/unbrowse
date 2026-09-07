/**
 * `unbrowse contract "<goal>"` — the /contract Public Shape: GOAL-ONLY, no verbs.
 *
 * The substrate is goal-only (`aiko "<goal>"`): there is no `declare` / `status`
 * subcommand, no `--action`, no `--parent` (lineage is server-determined from the
 * wallet identity + declare timestamp). The VERB rides in the goal's leading token,
 * exactly the aiko grammar:
 *   - a bare claim               → declare    `unbrowse contract "the route resolves clean"`
 *   - `satisfied:<id> — <proof>` → eval       (markSatisfied)
 *   - `died:<id> — <reason>`     → prune
 *   - `iterate:<id> — <what>`    → run
 *   - `status:<id>`              → read the projection (the one remote-ledger read
 *                                  concession — the canonical substrate reads the
 *                                  ledger file, but the unbrowse contract ledger is
 *                                  server-side on IQ).
 *
 * Every write goes through the wallet-signing thin client (one-key-signs-every-layer:
 * getWalletPubkey + signBytes via src/values/signer.ts, canonicalize+sign through the
 * Zig WASM core). No wallet → the thin client falls back to the unsigned legacy POST.
 *
 * Back-compat: a leading `declare` or `status` keyword (the old verb form) is still
 * recognized — in goal-only grammar it is simply the leading token.
 *
 * Dispatched as the `eval contract` subcommand (kind-map row "eval contract"); the
 * flat alias `unbrowse contract …` routes here via flatCommandVerb.
 */
import type { ParsedV7Args } from "../args.js";
import { EX_GENERIC, EX_USAGE, emit, emitErr, helpExit, type OutputOptions } from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { DEFAULT_BACKEND_URL } from "../../version.js";
import { getApiKey } from "../../client/index.js";
import { createThinClient } from "../../lib/contract-thin-client.js";

// The aiko verb closure carried in a goal's leading token. A bare claim (no known
// leading verb) is a declare — the substrate's build verb has no prefix.
const LEADING_VERBS = new Set(["declare", "iterate", "satisfied", "died", "validate", "signed"]);

function resolveApiBase(): string {
  return (
    process.env.UNBROWSE_API_URL ??
    process.env.UNBROWSE_BACKEND_URL ??
    DEFAULT_BACKEND_URL
  );
}

function buildClient() {
  const apiKey = getApiKey();
  return createThinClient({
    baseUrl: resolveApiBase(),
    ...(apiKey && apiKey !== "local-only" ? { apiKey } : {}),
  });
}

/** Derive the action from the goal's leading token (aiko grammar). Bare claim → declare. */
function leadingVerb(goal: string): string {
  const lead = goal.trimStart().split(/[\s:]/, 1)[0]?.toLowerCase() ?? "";
  return LEADING_VERBS.has(lead) ? lead : "declare";
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "contract")!;

  // Goal-only: every positional is part of the one goal string.
  const goal = parsed.positional.map(String).join(" ").trim();

  if (parsed.wantsHelp && !goal) {
    helpExit(
      "eval contract",
      {
        summary: "Declare a wallet-signed truth claim — goal-only, the /contract shape.",
        usage:
          'unbrowse contract "<goal>" [--json]\n' +
          '  a bare claim declares;  "satisfied:<id> — <proof>" / "died:<id> — <reason>"\n' +
          '  carry the verb in the leading token;  "status:<id>" reads the projection.',
        positional: [
          { name: "goal", description: "the truth claim (the verb rides in the leading token)", required: true },
        ],
        flags: [{ name: "--json", description: "Single-line JSON stdout." }],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const base = resolveApiBase();

  // status read — `status:<id>` or the legacy `status <id>` keyword form. A contract
  // id is a single token, so a multi-word "status ..." goal is a claim, not a read.
  const statusMatch = goal.match(/^status[:\s]+(\S+)\s*$/i);
  if (statusMatch) {
    try {
      const client = buildClient();
      const projection = await client.status(statusMatch[1]);
      emit(
        {
          ok: true,
          subcommand: "eval contract",
          op_kind: meta.op_kind,
          api_base: base,
          verb: "status",
          id: projection.id,
          status: projection.status,
          rows: projection.rows,
        },
        opts,
      );
      process.exit(0);
    } catch (err) {
      emitErr(err, opts);
      process.exit(EX_GENERIC);
    }
  }

  if (!goal) {
    emitErr(
      new Error('goal_required: usage: unbrowse contract "<goal>"  (a claim declares; "status:<id>" reads)'),
      opts,
    );
    process.exit(EX_USAGE);
  }

  // The plan IS the goal (aiko: "satisfied:<id> — proof" is the plan; the action is
  // derived from the leading token). The one exception is the legacy bare `declare`
  // keyword, which is stripped so the plan is just the claim text.
  const action = leadingVerb(goal);
  const plan = /^declare\s+/i.test(goal) ? goal.replace(/^declare\s+/i, "").trim() : goal;

  if (!plan) {
    emitErr(new Error("plan_required: the claim text is empty"), opts);
    process.exit(EX_USAGE);
  }

  try {
    const client = buildClient();
    const { id } = await client.declare({ plan, action });
    emit(
      {
        ok: true,
        subcommand: "eval contract",
        op_kind: meta.op_kind,
        api_base: base,
        verb: "declare",
        id,
        plan,
        action,
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
