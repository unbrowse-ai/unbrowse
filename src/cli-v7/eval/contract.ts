/**
 * `unbrowse contract <declare|status>` — native CLI surface over the
 * cloud /v1/contract/* harness.
 *
 * Two verbs, mirroring the thin client (src/lib/contract-thin-client.ts):
 *   - `unbrowse contract declare "<plan/claim>" [--action <verb>] [--json]`
 *       Builds the declare, signs it with the unbrowse wallet (one-key-
 *       signs-every-layer — getWalletPubkey + signBytes via src/values/
 *       signer.ts), POSTs to /v1/contract/declare, prints the row id.
 *       Backward-compat: no wallet → the thin client falls back to the
 *       unsigned legacy POST (offline-safe), this handler does not gate.
 *   - `unbrowse contract status <id> [--json]`
 *       GETs /v1/contract/status and prints the projection.
 *
 * Dispatched as the `eval contract` subcommand (kind-map row "eval
 * contract"). The flat alias `unbrowse contract …` routes here via
 * flatCommandVerb. The declare verb is the side-effect of a record write,
 * but it carries no browser state — it sits under the observe verb beside
 * the other backend-read primitives, same as `eval search`.
 */
import type { ParsedV7Args } from "../args.js";
import { EX_GENERIC, EX_USAGE, emit, emitErr, helpExit, type OutputOptions } from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { DEFAULT_BACKEND_URL } from "../../version.js";
import { getApiKey } from "../../client/index.js";
import { createThinClient } from "../../lib/contract-thin-client.js";

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

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "contract")!;

  const verb = parsed.positional[0];

  if (parsed.wantsHelp && !verb) {
    helpExit(
      "eval contract",
      {
        summary: "Declare a wallet-signed truth claim, or read its projection.",
        usage:
          'unbrowse contract declare "<plan/claim>" [--action <verb>] [--json]\n' +
          "unbrowse contract status <id> [--json]",
        positional: [
          { name: "verb", description: "declare | status", required: true },
          { name: "arg", description: "declare: the claim text. status: the contract id.", required: true },
        ],
        flags: [
          { name: "--action", description: "Action verb attached to the declare (default: declare).", value_expected: true },
          { name: "--parent", description: "Parent contract id to attach this declare under.", value_expected: true },
          { name: "--json", description: "Single-line JSON stdout." },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  if (!verb || (verb !== "declare" && verb !== "status")) {
    emitErr(
      new Error(
        'contract_verb_required: usage: unbrowse contract declare "<claim>" | unbrowse contract status <id>',
      ),
      opts,
    );
    process.exit(EX_USAGE);
  }

  const base = resolveApiBase();

  try {
    if (verb === "declare") {
      const plan = parsed.positional[1];
      if (!plan || typeof plan !== "string" || plan.trim().length === 0) {
        emitErr(new Error('plan_required: usage: unbrowse contract declare "<claim text>"'), opts);
        process.exit(EX_USAGE);
      }
      const action = typeof parsed.flags.action === "string" ? parsed.flags.action : "declare";
      const parentId = typeof parsed.flags.parent === "string" ? parsed.flags.parent : undefined;

      const client = buildClient();
      const { id } = await client.declare({
        plan,
        action,
        ...(parentId ? { parent_id: parentId } : {}),
      });

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
          ...(parentId ? { parent_id: parentId } : {}),
        },
        opts,
      );
      process.exit(0);
    }

    // verb === "status"
    const id = parsed.positional[1];
    if (!id || typeof id !== "string" || id.trim().length === 0) {
      emitErr(new Error("id_required: usage: unbrowse contract status <id>"), opts);
      process.exit(EX_USAGE);
    }

    const client = buildClient();
    const projection = await client.status(id);

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
