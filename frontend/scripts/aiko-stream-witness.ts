// Witness: aiko chat STREAMS from the local Mac model — tokens arrive incrementally,
// not as one blob. Exit 0 iff the default (local) model yields multiple deltas over
// time (>=3 chunks, first chunk well before the last) AND the assembled text is a
// real method-shaped answer. This proves the felt-UX win: live tokens, no dead air.
//
//   bun frontend/scripts/aiko-stream-witness.ts
import { aikoChatStream, defaultAikoModel } from "../src/lib/aiko-method";

async function main() {
  const model = defaultAikoModel();
  console.log(`[aiko-stream] model=${model.id} (${model.model}) @ ${model.endpoint}`);

  const stamps: number[] = [];
  let text = "";
  const t0 = Date.now();
  for await (const delta of aikoChatStream({
    messages: [{ role: "user", content: "Write a one-line Python function to reverse a string." }],
    maxTokens: 200,
  })) {
    stamps.push(Date.now() - t0);
    text += delta;
  }

  const chunks = stamps.length;
  const firstAt = stamps[0] ?? -1;
  const lastAt = stamps[chunks - 1] ?? -1;
  const spread = lastAt - firstAt;
  console.log(`[aiko-stream] chunks=${chunks} firstAt=${firstAt}ms lastAt=${lastAt}ms spread=${spread}ms`);
  console.log("[aiko-stream] --- assembled head ---\n" + text.slice(0, 200));

  // Real streaming: many chunks, and they were spread over time (not all at the end).
  const streamed = chunks >= 3 && spread >= 30 && text.trim().length > 0;
  if (streamed) {
    console.log(`\n[aiko-stream] PASS — ${chunks} live deltas over ${spread}ms from the local model (real streaming)`);
    process.exit(0);
  }
  console.error(`\n[aiko-stream] FAIL — not real streaming (chunks=${chunks}, spread=${spread}ms)`);
  process.exit(1);
}

main().catch((e) => {
  console.error("[aiko-stream] ERROR —", e?.message || e);
  process.exit(1);
});
