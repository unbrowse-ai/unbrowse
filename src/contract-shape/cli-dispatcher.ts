#!/usr/bin/env bun
/**
 * Universal CLI dispatcher — `unbrowse contract <neuron-name>` reads JSON
 * from stdin and writes JSON to stdout via the dispatcher.
 *
 * Contracts:
 *   - 2d2f444a (single source of truth)
 *   - f5836e77 (MCP+CLI unification)
 *   - 61b784e4 (stateless stdio for parallelism)
 *
 * Usage:
 *   echo '{"url":"..."}' | bun src/contract-shape/cli-dispatcher.ts contract-fetch
 *   bun src/contract-shape/cli-dispatcher.ts --list
 *   bun src/contract-shape/cli-dispatcher.ts --help
 *
 * Future: wired into src/cli.ts as a top-level subcommand so
 * `unbrowse contract <neuron>` works from the installed binary.
 */

import { dispatch, listNeurons } from "./dispatcher.js";

async function readStdinJson(): Promise<unknown> {
  let buf = "";
  for await (const chunk of process.stdin) buf += chunk;
  buf = buf.trim();
  if (!buf) return {};
  return JSON.parse(buf);
}

async function main(): Promise<void> {
  const [, , ...args] = process.argv;
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stderr.write(
      "Usage:\n" +
      "  bun src/contract-shape/cli-dispatcher.ts <neuron-name>   # reads stdin JSON, writes stdout JSON\n" +
      "  bun src/contract-shape/cli-dispatcher.ts --list           # list registered neurons\n" +
      "\nRegistered neurons:\n" +
      listNeurons().map((n) => `  ${n.name.padEnd(20)} ${n.description}`).join("\n") +
      "\n",
    );
    process.exit(args.length === 0 ? 2 : 0);
  }
  if (args[0] === "--list") {
    process.stdout.write(JSON.stringify(listNeurons().map((n) => ({
      name: n.name,
      description: n.description,
      contract_id: n.contract_id,
      locality: n.locality,
      paid: n.paid === true,
      composes: n.composes ?? [],
    })), null, 2) + "\n");
    process.exit(0);
  }
  const neuron = args[0];
  let input: unknown;
  try {
    input = await readStdinJson();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      neuron, ok: false,
      error: `stdin JSON parse: ${err instanceof Error ? err.message : String(err)}`,
      duration_ms: 0,
    }) + "\n");
    process.exit(1);
  }
  const r = await dispatch(neuron, input);
  process.stdout.write(JSON.stringify(r) + "\n");
  process.exit(r.ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[cli-dispatcher] uncaught: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(99);
});
