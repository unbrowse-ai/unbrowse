// A scripted model in the OpenAI Agents SDK's model interface: the first turn calls unbrowse_do, the next answers from
// what the node sent back. It stands in for a real model so the quickstart runs with no model API.
import { Usage, setTracingDisabled } from "@openai/agents";
import { summary } from "../ai-sdk/stub.mjs";

setTracingDisabled(true);
const goal = { goal: "search Hacker News stories", url: "https://hn.algolia.com/api/v1/search?query=rust" };

export const model = {
  async getResponse({ input }) {
    const result = Array.isArray(input) ? input.findLast((i) => i.type === "function_call_result") : null;
    if (!result) {
      console.error(`[stub model] calling unbrowse_do ${JSON.stringify(goal)}`);
      return { usage: new Usage(), output: [{ type: "function_call", callId: "c1", name: "unbrowse_do", arguments: JSON.stringify(goal), status: "completed" }] };
    }
    const text = typeof result.output === "string" ? result.output : result.output.text;
    console.error(`[stub model] the node answered ${text.slice(0, 300)}...`);
    return { usage: new Usage(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: summary(JSON.parse(text)) }] }] };
  },
  async *getStreamedResponse() {
    throw new Error("the stub model doesn't stream");
  },
};
