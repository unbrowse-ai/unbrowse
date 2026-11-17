// A scripted model in the AI SDK's model interface (v3): the first turn calls unbrowse_do, the next answers from what the
// node sent back. It stands in for a real model so the quickstart runs with no model API.
const usage = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };
const goal = { goal: "search Hacker News stories", url: "https://hn.algolia.com/api/v1/search?query=rust" };

export function summary(answer) {
  if (answer?.error) return `Unbrowse said: ${answer.error}`;
  const hits = answer?.result?.data?.hits ?? [];
  return `Top Hacker News stories about Rust (via unbrowse_do, how: ${answer?.how}):\n` + hits.slice(0, 5).map((h, i) => `${i + 1}. ${h.title}`).join("\n");
}

export const model = {
  specificationVersion: "v3",
  provider: "stub",
  modelId: "scripted",
  supportedUrls: {},
  async doGenerate({ prompt }) {
    const result = prompt.flatMap((m) => (m.role === "tool" ? m.content : [])).find((p) => p.type === "tool-result");
    if (!result) {
      console.error(`[stub model] calling unbrowse_do ${JSON.stringify(goal)}`);
      return { content: [{ type: "tool-call", toolCallId: "c1", toolName: "unbrowse_do", input: JSON.stringify(goal) }], finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [] };
    }
    console.error(`[stub model] the node answered ${JSON.stringify(result.output.value).slice(0, 300)}...`);
    return { content: [{ type: "text", text: summary(result.output.value) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
  },
  async doStream() {
    throw new Error("the stub model doesn't stream");
  },
};
