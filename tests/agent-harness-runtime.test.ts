import { describe, expect, it } from "bun:test";
import { createPermissionContext } from "../src/runtime/permission-gate.js";
import { finalizeFrontDoorResult, harnessOperationFingerprint, runHarnessInvocation } from "../src/harness/front-door.js";

describe("agent harness front door", () => {
  it("gates every invocation before the transport and records lifecycle", async () => {
    let called = 0;
    const events: string[] = [];
    const result = await runHarnessInvocation(
      { intent: "list stories", url: "https://example.com", effect: "read" },
      async () => { called += 1; return { items: [1, 2] }; },
      { onEvent: (event) => { events.push(event.state); } },
    );
    expect(result.state).toBe("completed");
    expect(called).toBe(1);
    expect(events).toEqual(["running", "completed"]);
    expect(Object.isFrozen(result.events)).toBe(true);
  });

  it("fails closed for a mutation without approval", async () => {
    let called = false;
    const result = await runHarnessInvocation(
      { intent: "delete post", url: "https://example.com/post/1", effect: "mutation", workspace_trusted: true },
      async () => { called = true; return {}; },
    );
    expect(result.state).toBe("blocked");
    expect(called).toBe(false);
    if (result.state === "blocked") expect(result.gate.decision).toBe("ask");
  });

  it("accepts only an operation-bound approval", async () => {
    const permission = createPermissionContext(() => 1_000);
    // A grant for another fingerprint/effect cannot accidentally authorize this invocation.
    const wrong = permission.issueApproval({ operation_fingerprint: "wrong", effect: "mutation" });
    const blocked = await runHarnessInvocation(
      { intent: "delete post", url: "https://example.com/post/1", effect: "mutation", workspace_trusted: true, approval_token: wrong.token },
      async () => "unsafe",
      { permission, now: () => 1_000 },
    );
    expect(blocked.state).toBe("blocked");
  });

  it("runs an approved mutation exactly once", async () => {
    const permission = createPermissionContext(() => 1_000);
    const input = { intent: "delete post", url: "https://example.com/post/1", effect: "mutation" as const, workspace_trusted: true };
    const grant = permission.issueApproval({ operation_fingerprint: harnessOperationFingerprint(input), effect: "mutation" });
    let calls = 0;
    const result = await runHarnessInvocation(
      { ...input, approval_token: grant.token },
      async () => { calls += 1; return "deleted"; },
      { permission, now: () => 1_000 },
    );
    expect(result.state).toBe("completed");
    expect(calls).toBe(1);
  });

  it("never starts transport when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    let calls = 0;
    const result = await runHarnessInvocation(
      { intent: "read", url: "https://example.com", effect: "read" },
      async () => { calls += 1; return "unsafe"; },
      { signal: controller.signal },
    );
    expect(calls).toBe(0);
    expect(result.state).toBe("failed");
    expect(result.events.map((event) => event.state)).toEqual(["failed"]);
  });

  it("keeps observer failures separate from operation terminal state", async () => {
    const result = await runHarnessInvocation(
      { intent: "read", url: "https://example.com", effect: "read" },
      async () => "ok",
      { onEvent(event) { if (event.state === "completed") throw new Error("sink down"); } },
    );
    expect(result.state).toBe("completed");
    expect(result.events.map((event) => event.state)).toEqual(["running", "completed"]);
    expect(result.observer_errors).toEqual(["sink down"]);
  });

  it("observer failures cannot escape blocked or failed terminal states", async () => {
    const observer = () => { throw new Error("observer down"); };
    const blocked = await runHarnessInvocation(
      { intent: "delete", url: "https://example.com", effect: "mutation", workspace_trusted: true },
      async () => "never",
      { onEvent: observer },
    );
    expect(blocked.state).toBe("blocked");
    expect(blocked.events.map((event) => event.state)).toEqual(["blocked"]);
    const failed = await runHarnessInvocation(
      { intent: "read", url: "https://example.com", effect: "read" },
      async () => { throw new Error("transport down"); },
      { onEvent: observer },
    );
    expect(failed.state).toBe("failed");
    expect(failed.events.map((event) => event.state)).toEqual(["running", "failed"]);
    expect(failed.observer_errors).toEqual(["observer down", "observer down"]);
  });

  it("enforces a deadline and emits a failed terminal event", async () => {
    const result = await runHarnessInvocation(
      { intent: "read", url: "https://example.com", effect: "read" },
      async () => new Promise<string>(() => {}),
      { timeout_ms: 5 },
    );
    expect(result.state).toBe("failed");
    if (result.state === "failed") expect(result.error.name).toBe("AbortError");
    expect(result.events.map((event) => event.state)).toEqual(["running", "failed"]);
  });

  it("marks foreground-only cancellation as potentially still executing", async () => {
    const result = await runHarnessInvocation(
      { intent: "read", url: "https://example.com", effect: "read" },
      async () => new Promise<string>(() => {}),
      { timeout_ms: 5, cancellation_mode: "foreground-only" },
    );
    expect(result.state).toBe("failed");
    if (result.state === "failed") expect(result.execution_may_continue).toBe(true);
  });

  it("selects, compresses, and returns one recovery instruction", async () => {
    const finalized = await finalizeFrontDoorResult(
      { ok: false, status: "no_match", diagnostic: "x".repeat(50_000) },
      { intent: "list items", url: "https://example.com/items" },
      { persist: false },
    );
    expect(finalized.output.next_step).toBe('unbrowse capture --url "https://example.com/items" --intent "list items"');
    expect(finalized.output).not.toHaveProperty("diagnostic");
  });
});
