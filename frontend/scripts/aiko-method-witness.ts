// Witness: the baked Aiko method prompt + the local Mac model actually produce a
// method-shaped answer. Runs the REAL local Ollama model through the real module.
// Exit 0 iff the default (local, small) model returns a non-empty response that
// follows the four-step loop (>=3 of Plan/Build/Test/Judge present).
//
//   bun frontend/scripts/aiko-method-witness.ts
//
// Requires Ollama running on this Mac with the default model pulled
// (ollama pull qwen2.5:1.5b). No cloud, no key — proves the local path.
import { aikoChat, defaultAikoModel, AIKO_METHOD_SYSTEM_PROMPT } from "../src/lib/aiko-method.ts";

const STEPS = ["plan", "build", "test", "judge"];

async function main() {
  const model = defaultAikoModel();
  console.log(`[aiko-witness] model=${model.id} (${model.model}) @ ${model.endpoint}`);
  console.log(`[aiko-witness] system prompt: ${AIKO_METHOD_SYSTEM_PROMPT.length} chars`);

  const { text } = await aikoChat({
    messages: [{ role: "user", content: "Write a Python function that reverses a string." }],
    maxTokens: 500,
  });

  if (!text.trim()) {
    console.error("[aiko-witness] FAIL — empty response from local model");
    process.exit(1);
  }
  const lc = text.toLowerCase();
  const hit = STEPS.filter((s) => lc.includes(s));
  console.log(`[aiko-witness] method steps present: ${hit.join(", ") || "<none>"} (${hit.length}/4)`);
  console.log("[aiko-witness] --- response head ---\n" + text.slice(0, 400));

  if (hit.length >= 3) {
    console.log(`\n[aiko-witness] PASS — local Mac model followed the baked Aiko method (${hit.length}/4 steps)`);
    process.exit(0);
  }
  console.error(`\n[aiko-witness] FAIL — only ${hit.length}/4 method steps; the baked prompt did not steer the model`);
  process.exit(1);
}

main().catch((e) => {
  console.error("[aiko-witness] ERROR —", e?.message || e);
  process.exit(1);
});
