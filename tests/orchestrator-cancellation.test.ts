import { expect, test } from "bun:test";
import { resolveAndExecute } from "../src/orchestrator/index.js";

test("canonical one-call front door rejects an already-aborted invocation before routing", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller_cancelled"));
  await expect(resolveAndExecute(
    "read a page",
    {},
    { url: "https://example.invalid" },
    undefined,
    { signal: controller.signal },
  )).rejects.toThrow("caller_cancelled");
});
