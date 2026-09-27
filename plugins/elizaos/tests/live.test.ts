// LIVE against the hosted Unbrowse MCP. Skipped unless UNBROWSE_LIVE=1 (and UNBROWSE_API_KEY is set), so
// `bun test` stays offline. The key is read from the environment and never printed.
//   UNBROWSE_LIVE=1 UNBROWSE_API_KEY=… [UNBROWSE_MCP_URL=https://unbrowse.ai/mcp] bun test tests/live.test.ts
import { describe, expect, test } from "bun:test";
import type { ActionResult, State } from "@elizaos/core";
import { AgentRuntime } from "@elizaos/core";
import unbrowsePlugin, { discoverAction, runAction, unbrowseProvider, webFetchAction } from "../src/index.ts";
import { msg, recorder } from "./helpers.ts";

const live = process.env.UNBROWSE_LIVE === "1" && Boolean(process.env.UNBROWSE_API_KEY);
const key = process.env.UNBROWSE_API_KEY ?? "";

// Settings come from process.env (the plugin's fallback), not from the character, so nothing holds the key twice.
const runtime = () => new AgentRuntime({ character: { name: "LiveTester", bio: "live", plugins: [] } });

/** Retry while every cloud browser is busy: wait 30 s, at most 3 retries. */
async function withCapacityRetry(fn: () => Promise<ActionResult>): Promise<ActionResult> {
  let r = await fn();
  for (let i = 0; i < 3 && (r.data as { kind?: string })?.kind === "browser_capacity"; i++) {
    await new Promise((res) => setTimeout(res, 30_000));
    r = await fn();
  }
  return r;
}

const safe = (r: unknown) => {
  const s = JSON.stringify(r);
  if (key) expect(s).not.toContain(key);
  return s;
};


describe("live hosted Unbrowse", () => {
  test.skipIf(!live)("WEB_FETCH reads https://example.com", async () => {
    const rt = runtime();
    await rt.registerPlugin(unbrowsePlugin);
    const rec = recorder();
    const r = await withCapacityRetry(async () => (await webFetchAction.handler(rt, msg("read https://example.com"), {} as State, {}, rec.callback)) as ActionResult);
    safe(r);
    if (!r.success) console.log(`[live] WEB_FETCH failed: ${safe({ kind: (r.data as any).kind, text: r.text })}`);
    expect(r.success).toBe(true);
    expect(r.text).toContain("Example Domain");
    expect(rec.sent.at(-1)?.actions).toEqual(["WEB_FETCH"]);
    console.log(`[live] WEB_FETCH ok: kind=${(r.data as any).kind} via=${(r.data as any).via} title=${(r.data as any).title} renderFallback=${Boolean((r.data as any).renderFallback)}`);
  }, 200_000);

  test.skipIf(!live)("UNBROWSE_DISCOVER + UNBROWSE_RUN: top stories on hacker news", async () => {
    const rt = runtime();
    await rt.registerPlugin(unbrowsePlugin);
    const d = await withCapacityRetry(async () => (await discoverAction.handler(rt, msg("top stories on hacker news"), {} as State, {})) as ActionResult);
    safe(d);
    expect(d.success).toBe(true);
    console.log(`[live] DISCOVER: kind=${(d.data as any).kind} recommended=${(d.data as any).recommended?.id ?? "none"} count=${(d.data as any).capabilities?.length}`);

    const r = await withCapacityRetry(async () => (await runAction.handler(rt, msg("top stories on hacker news"), {} as State, {})) as ActionResult);
    safe(r);
    const kind = (r.data as any).kind as string;
    console.log(`[live] RUN: success=${r.success} kind=${kind} capability=${(r.data as any).capabilityId ?? "-"} run=${(r.data as any).runId ?? "-"}`);
    // Either a capability ran, or Unbrowse said honestly that none fits (no fabricated success).
    expect(["succeeded", "no_capability", "browsed_after_no_capability", "input_required"]).toContain(kind);
    if (kind === "succeeded") expect(r.text!.length).toBeGreaterThan(50);
  }, 400_000);

  test.skipIf(!live)("provider reports connected", async () => {
    const rt = runtime();
    const p = await unbrowseProvider.get(rt, msg("hi"), {} as State);
    safe(p);
    expect(p.values).toMatchObject({ unbrowseConfigured: true, unbrowseConnected: true });
    console.log(`[live] provider: ${p.text!.split("\n")[1]}`);
  }, 60_000);
});
