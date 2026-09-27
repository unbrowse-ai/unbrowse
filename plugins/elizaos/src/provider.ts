// UNBROWSE provider: whether Unbrowse is usable for this agent, and a short routing note distilled from the
// shipped skill (skill/SKILL.md). The connection check is one tools/list call, cached per runtime.
import type { IAgentRuntime, Provider, ProviderResult } from "@elizaos/core";
import { describeError, hasApiKey, mcpFor, setting } from "./client.ts";
import { getPending } from "./unbrowse.ts";
import { loadSkill } from "./skill.ts";

type Status = { connected: boolean; tools?: number; error?: string; at: number };
const statusByRuntime = new WeakMap<object, Status | Promise<Status>>();
const OK_TTL = 10 * 60 * 1000;
const FAIL_TTL = 60 * 1000;

async function check(runtime: IAgentRuntime): Promise<Status> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 5000).unref?.());
  try {
    const tools = await Promise.race([mcpFor(runtime).listTools(), timeout]);
    return { connected: true, tools: tools.length, at: Date.now() };
  } catch (err) {
    return { connected: false, error: describeError(err).text, at: Date.now() };
  }
}

export async function connectionStatus(runtime: IAgentRuntime): Promise<Status | undefined> {
  if (!hasApiKey(runtime) || setting(runtime, "UNBROWSE_CHECK_CONNECTION") === "false") return undefined;
  const cached = statusByRuntime.get(runtime);
  if (cached && !(cached instanceof Promise) && Date.now() - cached.at < (cached.connected ? OK_TTL : FAIL_TTL)) return cached;
  if (cached instanceof Promise) return cached;
  const p = check(runtime);
  statusByRuntime.set(runtime, p);
  const s = await p;
  statusByRuntime.set(runtime, s);
  return s;
}

/** For tests and hosts that rotate keys. */
export function resetConnectionStatus(runtime: IAgentRuntime) {
  statusByRuntime.delete(runtime);
}

export const unbrowseProvider: Provider = {
  name: "UNBROWSE",
  description: "Unbrowse website access: connection status and when to use WEB_FETCH, UNBROWSE_RUN, UNBROWSE_BROWSE.",
  get: async (runtime, message): Promise<ProviderResult> => {
    const skill = loadSkill();
    const configured = hasApiKey(runtime);
    const status = configured ? await connectionStatus(runtime) : undefined;
    const pending = getPending(runtime, message?.roomId);
    const statusLine = !configured
      ? "Status: NOT configured. Set UNBROWSE_API_KEY in the character secrets; until then Unbrowse actions will fail."
      : status === undefined
        ? "Status: configured (connection not checked)."
        : status.connected
          ? `Status: connected (${status.tools} tools available).`
          : `Status: configured but unreachable: ${status.error}`;
    const lines = [
      "# Unbrowse (website access)",
      statusLine,
      "Use Unbrowse for anything on the web, not BROWSER:",
      "- a page with a known URL -> WEB_FETCH",
      "- a task or data on a site (\"top stories on hacker news\") -> UNBROWSE_RUN",
      "- which site tools exist -> UNBROWSE_DISCOVER",
      "- interactive page with no route -> UNBROWSE_BROWSE (cloud browser; Unbrowse learns the site)",
      "- the user answers a question Unbrowse asked -> UNBROWSE_RESUME",
      ...(pending ? [`Paused run ${pending.runId} waits for: ${pending.requirements.map((r) => r.affectedAction ?? r.id).join(", ") || "input"}.`] : []),
      "How Unbrowse runs work:",
      ...skill.steps.slice(0, 5).map((s, i) => `${i + 1}. ${s}`),
      ...skill.rules.map((r) => `- ${r}`),
    ];
    return {
      text: lines.join("\n"),
      values: { unbrowseConfigured: configured, unbrowseConnected: status?.connected ?? false, ...(pending ? { unbrowsePendingRunId: pending.runId } : {}) },
      data: { configured, status: status ?? null, skillPath: skill.path ?? null, skillDescription: skill.description, pendingRunId: pending?.runId ?? null },
    };
  },
};
