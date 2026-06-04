/**
 * src/sdk/adapters/browser-use.ts — drop-in shape for the `browser-use` Agent.
 *
 * Same construction (`new Agent({ task, llm })`) and `.run()` — but the task is filled
 * through the wallet-sealed unbrowse hole (resolve → execute → capture) instead of a
 * driven headful browser. `llm` is accepted for signature compatibility; the hole
 * decides when a real browser is actually needed (browser-open is the fallback, not the
 * platform).
 */
import { createHole } from "../hole.js";
export class Agent {
    hole;
    task;
    constructor(options) {
        this.task = options.task;
        this.hole = createHole(options);
    }
    async run() {
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
