/**
 * `unbrowse eval deploy` / `unbrowse deploy` — aiko-native deploy.
 *
 * Deploys the current unbrowse build as a witnessed contract on the four-tier
 * stack (native libcontract → IQ on-chain → emergent KV → RAG). The deployment
 * IS the contract — not a side-effect decorated with a receipt afterward.
 *
 * Usage:
 *   unbrowse deploy                          # default: aiko-native deploy
 *   unbrowse deploy --kind server            # deploy as "server" kind
 *   unbrowse deploy --target linux-x64       # explicit target triple
 *   unbrowse deploy --live-url https://...   # the URL this deploy serves
 */
import type { ParsedV7Args } from "../args.js";
import { EX_GENERIC, emit, emitErr, helpExit, type OutputOptions } from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { aikoDeploy } from "../../values/aiko-deploy.js";

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "deploy")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval deploy",
      {
        summary: "Deploy the current unbrowse build as an aiko-native contract (4-tier: native → IQ → KV → RAG).",
        usage: "unbrowse deploy [--kind <k>] [--target <t>] [--live-url <url>]",
        positional: [],
        flags: [
          { name: "--kind", description: "Deploy target class (default: aiko-native).", value_expected: true },
          { name: "--target", description: "Platform triple (default: auto-detected).", value_expected: true },
          { name: "--live-url", description: "The live URL this deploy serves.", value_expected: true },
          { name: "--json", description: "Single-line JSON stdout." },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  try {
    const result = await aikoDeploy({
      kind: typeof parsed.flags.kind === "string" ? parsed.flags.kind : undefined,
      target: typeof parsed.flags.target === "string" ? parsed.flags.target : undefined,
      liveUrl: typeof parsed.flags["live-url"] === "string" ? parsed.flags["live-url"] : undefined,
    });

    emit(
      {
        ok: true,
        subcommand: "eval deploy",
        op_kind: meta.op_kind,
        deploy_id: result.deploy.id,
        release_version: result.build.release_version,
        git_sha: result.build.git_sha,
        code_hash: result.build.code_hash,
        tiers: {
          native: result.deploy.persisted.native,
          iq: result.deploy.persisted.iq,
          kv: result.deploy.persisted.kv,
          rag: result.deploy.persisted.rag,
        },
        mirrored: result.deploy.mirrored,
        notes: result.deploy.persisted.notes,
        witness: result.witness,
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
