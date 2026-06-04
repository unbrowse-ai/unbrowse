/**
 * src/sdk/adapters/browser-use.ts — drop-in shape for the `browser-use` Agent.
 *
 * Same construction (`new Agent({ task, llm })`) and `.run()` — but the task is filled
 * through the wallet-sealed unbrowse hole (resolve → execute → capture) instead of a
 * driven headful browser. `llm` is accepted for signature compatibility; the hole
 * decides when a real browser is actually needed (browser-open is the fallback, not the
 * platform).
 */
import { createHole, type Hole, type HoleItem, type HoleOptions } from "../hole.js";

export interface AgentOptions extends HoleOptions {
  task: string;
  llm?: unknown;
  maxSteps?: number;
}

export interface AgentResult {
  task: string;
  done: boolean;
  result: string;
  items: HoleItem[];
}

export class Agent {
  private readonly hole: Hole;
  private readonly task: string;

  constructor(options: AgentOptions) {
    this.task = options.task;
    this.hole = createHole(options);
  }

  async run(): Promise<AgentResult> {
    const r = await this.hole.fill({ intent: this.task });
    return {
      task: this.task,
      done: r.ok,
      result: r.answer ?? r.items[0]?.text ?? "",
      items: r.items,
    };
  }
}

export default Agent;
