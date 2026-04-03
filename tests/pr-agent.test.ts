import { describe, expect, it } from "bun:test";
import { deriveSuggestedCommands, deriveSuggestedEvalCommands } from "../scripts/pr-agent.ts";

describe("pr-agent helpers", () => {
  it("maps failing checks to concrete repo commands", () => {
    expect(deriveSuggestedCommands(["Repo Sanity", "Typecheck Backend"], ["backend/src/index.ts"])).toEqual([
      "bun run check:skill-md",
      "bun run check:skill-docs",
      "cd backend && ./node_modules/.bin/tsc --noEmit",
      "bun test backend/tests/",
    ]);
  });

  it("adds cli/runtime verification from changed files", () => {
    const commands = deriveSuggestedCommands([], ["src/cli.ts", "src/execution/index.ts"]);
    expect(commands).toContain("bun run test:issue-regressions");
    expect(commands).toContain("bun run cli -- setup --no-start");
    expect(commands).toContain("bun test tests/cli-e2e.test.ts");
  });

  it("suggests product evals for runtime changes", () => {
    expect(deriveSuggestedEvalCommands(["src/orchestrator/index.ts"])).toEqual([
      "bun run eval:codex:product-success",
    ]);
  });
});
