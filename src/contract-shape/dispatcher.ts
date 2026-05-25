/**
 * Universal neuron dispatcher — the seam between transports (MCP, CLI,
 * harness) and primitive implementations.
 *
 * Contracts:
 *   - 2d2f444a (single source of truth — registry → dispatcher → transports)
 *   - f5836e77 (MCP+binary unification via shared registry)
 *
 * Every registry neuron has exactly one impl module at
 * src/contract-shape/impl/<name>.ts that exports `default async function
 * run(input: unknown): Promise<unknown>`. The dispatcher (a) validates
 * the name is in the registry, (b) lazy-imports the impl module, (c)
 * calls run(input), (d) returns the pointer-shaped result.
 *
 * Transports (mcp-transport.ts, cli-dispatcher.ts) iterate
 * CONTRACT_REGISTRY at startup and bind each entry to their surface.
 * They do not own the impl mapping — that lives here.
 */

import { CONTRACT_REGISTRY, byName, type ContractNeuronSpec } from "./registry.js";

export interface DispatchResult {
  readonly neuron: string;
  readonly ok: boolean;
  readonly output?: unknown;
  readonly error?: string;
  readonly duration_ms: number;
}

/**
 * Single entry point. Transport layers call this with (name, input) and
 * get a uniform DispatchResult back. The impl module's success or
 * failure is wrapped uniformly so MCP and CLI can both surface it
 * without per-neuron boilerplate.
 */
export async function dispatch(name: string, input: unknown): Promise<DispatchResult> {
  const started = Date.now();
  const spec = byName(name);
  if (!spec) {
    return {
      neuron: name,
      ok: false,
      error: `unknown neuron: ${name}; registered: ${CONTRACT_REGISTRY.map((s) => s.name).join(", ")}`,
      duration_ms: Date.now() - started,
    };
  }
  try {
    const mod = await import(`./impl/${name}.js`);
    if (typeof mod.default !== "function") {
      return {
        neuron: name,
        ok: false,
        error: `impl module src/contract-shape/impl/${name}.ts does not export default function`,
        duration_ms: Date.now() - started,
      };
    }
    const output = await mod.default(input);
    return {
      neuron: name,
      ok: true,
      output,
      duration_ms: Date.now() - started,
    };
  } catch (err) {
    return {
      neuron: name,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - started,
    };
  }
}

export function listNeurons(): readonly ContractNeuronSpec[] {
  return CONTRACT_REGISTRY;
}
