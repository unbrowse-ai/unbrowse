import { afterEach, describe, expect, test } from "bun:test";
import { execCommand, killSession } from "./exec";

const realFetch = globalThis.fetch;
const answer = (body: string, status: number) => {
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("asking the dashboard server", () => {
  test("an answer that isn't JSON is a failure, not a thrown error", async () => {
    answer("<html>Bad Gateway</html>", 502);
    const res = await execCommand(["close"]);
    expect(res.success).toBe(false);
    expect(res.stderr).toContain("502");
  });

  test("a refusal keeps its reason", async () => {
    answer('{"success":false,"error":"Empty args array"}', 400);
    const res = await execCommand([]);
    expect(res.success).toBe(false);
    expect(res.stderr).toBe("Empty args array");
  });

  test("a finished command is passed through", async () => {
    answer('{"success":true,"exit_code":0,"stdout":"{}","stderr":""}', 200);
    expect(await execCommand(["cookies"])).toEqual({ success: true, exit_code: 0, stdout: "{}", stderr: "" });
  });

  test("a server that can't be reached is a failure", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("failed");
    }) as unknown as typeof fetch;
    expect((await execCommand(["close"])).success).toBe(false);
  });

  test("a kill that gets no JSON back is a failure too", async () => {
    answer("<html>", 502);
    expect((await killSession("a")).success).toBe(false);
  });

  test("a refused kill keeps its reason", async () => {
    answer(`{"success":false,"error":"No PID file for session 'a'"}`, 400);
    expect(await killSession("a")).toEqual({ success: false, error: "No PID file for session 'a'" });
  });
});
