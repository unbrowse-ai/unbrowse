import { describe, expect, it } from "bun:test";
import {
  createDoneTool,
  LoopAbortedError,
  LoopBudgetError,
  LoopDeadlineError,
  projectModelView,
  pushToolResult,
  runLoop,
  visibleMessages,
  type ChatMessage,
  type ChatModel,
  type Tool,
} from "../src/agent/loop.js";

const user = (content: string): ChatMessage => ({ role: "user", content });

describe("agent loop", () => {
  it("projects a bounded model view while retaining an immutable full audit trace", async () => {
    const mutableInput: ChatMessage[] = [user("go")];
    let calls = 0;
    const model: ChatModel = {
      async ainvoke(messages) {
        expect(messages.length).toBeLessThanOrEqual(3);
        expect(messages.some((message) => message.role === "user" && message.content === "go")).toBeTrue();
        calls++;
        return calls <= 5
          ? { text: "browse", toolCalls: [{ name: "browser", args: { calls } }] }
          : { text: "finish", toolCalls: [{ name: "done", args: { message: "ok" } }] };
      },
    };
    const browser: Tool = {
      name: "browser",
      ephemeral: 1,
      async authorize() { return true; },
      async invoke(args) { return `state-${String(args.calls)}`; },
    };
    const outcome = await runLoop(model, [browser, createDoneTool()], mutableInput, {
      maxMessages: 3,
      maxEphemeralMessages: 2,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.trace.filter((message) => message.role === "tool").length).toBe(6);
    expect(mutableInput).toEqual([user("go")]);
    expect(Object.isFrozen(outcome)).toBeTrue();
    expect(Object.isFrozen(outcome.trace)).toBeTrue();
    expect(Object.isFrozen(outcome.trace[1])).toBeTrue();
  });

  it("keeps assistant calls and tool results typed and correlated", async () => {
    let turn = 0;
    const model: ChatModel = {
      async ainvoke() {
        turn++;
        return turn === 1
          ? { text: "lookup", toolCalls: [{ id: "provider-42", name: "lookup", args: { q: "hi" } }] }
          : { text: "done", toolCalls: [{ name: "done", args: { message: "finished" } }] };
      },
    };
    const lookup: Tool = { name: "lookup", async authorize() { return true; }, async invoke() { return "answer"; } };
    const outcome = await runLoop(model, [lookup, createDoneTool()], [user("task")]);
    const assistant = outcome.trace.find(
      (message) => message.role === "assistant" && message.toolCalls[0]?.name === "lookup",
    );
    const result = outcome.trace.find(
      (message) => message.role === "tool" && message.toolName === "lookup",
    );
    expect(assistant?.role).toBe("assistant");
    expect(result?.role).toBe("tool");
    if (assistant?.role === "assistant" && result?.role === "tool") {
      expect(result.toolCallId).toBe(assistant.toolCalls[0].id);
      expect(result.toolCallId).toBe("provider-42");
      expect(result.status).toBe("success");
    }
  });

  it("returns a typed completion only for a registered terminal tool", async () => {
    const done = createDoneTool();
    expect(done.terminal).toBeTrue();
    expect(done.inputSchema).toMatchObject({ type: "object", required: ["message"] });
    const model: ChatModel = {
      async ainvoke() { return { text: "", toolCalls: [{ name: "done", args: { message: "finished" } }] }; },
    };
    const outcome = await runLoop(model, [done], [user("task")]);
    expect(outcome).toMatchObject({
      status: "completed",
      result: "finished",
      terminalTool: "done",
      turns: 1,
      toolCalls: 1,
    });
  });

  it("feeds unknown tools and tool failures back with correlation", async () => {
    let turn = 0;
    const seen: ChatMessage[][] = [];
    const model: ChatModel = {
      async ainvoke(messages) {
        seen.push([...messages]);
        turn++;
        if (turn === 1) return { text: "", toolCalls: [{ id: "u1", name: "missing", args: {} }] };
        if (turn === 2) return { text: "", toolCalls: [{ id: "e1", name: "broken", args: {} }] };
        return { text: "", toolCalls: [{ name: "done", args: { message: "recovered" } }] };
      },
    };
    const broken: Tool = { name: "broken", async authorize() { return true; }, async invoke() { throw new Error("boom"); } };
    const outcome = await runLoop(model, [broken, createDoneTool()], [user("go")], {
      maxNoProgressTurns: 3,
    });
    expect(outcome.result).toBe("recovered");
    const unknown = outcome.trace.find(
      (message) => message.role === "tool" && message.toolCallId === "u1",
    );
    const failed = outcome.trace.find(
      (message) => message.role === "tool" && message.toolCallId === "e1",
    );
    expect(unknown).toMatchObject({ role: "tool", status: "error", toolName: "missing" });
    expect(failed).toMatchObject({ role: "tool", status: "error", toolName: "broken" });
    if (unknown?.role === "tool" && failed?.role === "tool") {
      expect(JSON.parse(unknown.content).error.code).toBe("UNKNOWN_TOOL");
      expect(JSON.parse(failed.content).error.code).toBe("TOOL_ERROR");
    }
    expect(seen[1].some((message) => message.role === "tool" && message.toolCallId === "u1")).toBeTrue();
  });

  it("enforces turn, tool-call, and no-progress budgets with typed audit errors", async () => {
    const idle: ChatModel = { async ainvoke() { return { text: "waiting", toolCalls: [] }; } };
    await expect(runLoop(idle, [createDoneTool()], [user("go")], { maxNoProgressTurns: 2 }))
      .rejects.toMatchObject({ code: "NO_PROGRESS", turns: 2 });

    let turnError: unknown;
    try {
      await runLoop(idle, [createDoneTool()], [user("go")], {
        maxTurns: 1,
        maxNoProgressTurns: 5,
      });
    } catch (error) { turnError = error; }
    expect(turnError).toBeInstanceOf(LoopBudgetError);
    expect(turnError).toMatchObject({ code: "MAX_TURNS", turns: 1 });
    expect(Object.isFrozen((turnError as LoopBudgetError).trace)).toBeTrue();

    const twoCalls: ChatModel = {
      async ainvoke() {
        return { text: "", toolCalls: [
          { name: "ok", args: {} },
          { name: "ok", args: {} },
        ] };
      },
    };
    const ok: Tool = { name: "ok", async authorize() { return true; }, async invoke() { return "ok"; } };
    await expect(runLoop(twoCalls, [ok], [user("go")], { maxToolCalls: 1 }))
      .rejects.toMatchObject({ code: "MAX_TOOL_CALLS", toolCalls: 0 });
  });

  it("fails closed when a registered tool has no permission dispatcher", async () => {
    let turn = 0;
    const model: ChatModel = {
      async ainvoke() {
        turn += 1;
        return turn === 1
          ? { text: "", toolCalls: [{ id: "unsafe", name: "unsafe", args: {} }] }
          : { text: "", toolCalls: [{ name: "done", args: { message: "stopped" } }] };
      },
    };
    let invoked = false;
    const unsafe: Tool = { name: "unsafe", async invoke() { invoked = true; return "bad"; } };
    const outcome = await runLoop(model, [unsafe, createDoneTool()], [user("go")]);
    expect(invoked).toBeFalse();
    const denial = outcome.trace.find((message) => message.role === "tool" && message.toolCallId === "unsafe");
    expect(denial?.role === "tool" ? JSON.parse(denial.content).error.code : undefined).toBe("PERMISSION_DENIED");
  });

  it("rejects oversized tool-call batches before retaining them in the trace", async () => {
    const model: ChatModel = {
      async ainvoke() {
        return { text: "", toolCalls: Array.from({ length: 5_000 }, (_, index) => ({ name: "x", id: `c${index}`, args: {} })) };
      },
    };
    let error: unknown;
    try {
      await runLoop(model, [], [user("task")], { maxToolCalls: 1 });
    } catch (cause) { error = cause; }
    expect(error).toMatchObject({ code: "MAX_TOOL_CALLS" });
    expect((error as LoopBudgetError).trace.some((message) => message.role === "assistant")).toBeFalse();
    expect(Buffer.byteLength(JSON.stringify((error as LoopBudgetError).trace), "utf8")).toBeLessThan(1_000);
  });

  it("enforces abort and deadline even when a model ignores its signal", async () => {
    const never: ChatModel = { async ainvoke() { return await new Promise(() => {}); } };
    const controller = new AbortController();
    setTimeout(() => controller.abort("stop"), 5);
    await expect(runLoop(never, [], [user("go")], { signal: controller.signal }))
      .rejects.toBeInstanceOf(LoopAbortedError);

    await expect(runLoop(never, [], [user("go")], { deadline: Date.now() + 5 }))
      .rejects.toBeInstanceOf(LoopDeadlineError);
  });

  it("bounds tool content, model view bytes, and the retained audit trace", async () => {
    let turn = 0;
    const model: ChatModel = {
      async ainvoke(messages) {
        expect(Buffer.byteLength(JSON.stringify(messages), "utf8")).toBeLessThanOrEqual(2_048);
        turn += 1;
        return turn === 1
          ? { text: "thinking".repeat(1_000), toolCalls: [{ name: "large", args: {} }] }
          : { text: "", toolCalls: [{ name: "done", args: { message: "ok" } }] };
      },
    };
    const large: Tool = {
      name: "large",
      async authorize() { return true; },
      async invoke() { return "x".repeat(100_000); },
    };
    const outcome = await runLoop(model, [large, createDoneTool()], [user("bounded task")], {
      maxContentBytes: 1_024,
      maxModelViewBytes: 2_048,
    });
    const largeResult = outcome.trace.find((message) => message.role === "tool" && message.toolName === "large");
    expect(largeResult?.content).toContain("[truncated]");
    expect(Buffer.byteLength(largeResult?.content ?? "", "utf8")).toBeLessThanOrEqual(1_024);
  });

  it("legacy projection helpers keep only the last three ephemeral results", () => {
    const messages: ChatMessage[] = [user("go")];
    const browser: Tool = { name: "browser", ephemeral: 1, async authorize() { return true; }, async invoke() { return "ok"; } };
    for (let i = 0; i < 5; i++) pushToolResult(messages, browser, `state-${i}`, `c${i}`);
    expect(messages.filter((message) => message.role === "tool").map((message) => message.content))
      .toEqual(["state-2", "state-3", "state-4"]);

    const raw: ChatMessage[] = [user("start")];
    for (let i = 0; i < 5; i++) {
      raw.push({
        role: "tool",
        content: `s${i}`,
        toolCallId: `c${i}`,
        toolName: "browser",
        status: "success",
        ephemeral: 1,
      });
    }
    const projected = visibleMessages(raw);
    expect(projected.filter((message) => message.role === "tool").map((message) => message.content))
      .toEqual(["s2", "s3", "s4"]);
    expect(projectModelView(raw, { maxMessages: 2 }).length).toBe(2);
  });
});
