/**
 * The server-side selection of the Chrome-free obscura backend.
 *
 * `executeBrowserCapture` (src/execution/index.ts) is the server capture entry:
 * `execution_type: "browser-capture"` skills dispatch to it, and `/v1/capture`
 * reaches it via `executeSkill`. By default it drives Chrome via kuri+CDP. When
 * `UNBROWSE_BROWSER_BACKEND=obscura` is set, it delegates here instead — a
 * capture with no Chrome and no CDP, via `captureAndIndexViaObscura`.
 *
 * Sharing to the index is opt-in (the user's rule: "share to the index if opt
 * in"). Discovery always runs and the routes come back; the reusable route/skill
 * index is written only when the opt-in is set — `shareOptIn(env)` reads
 * `UNBROWSE_SHARE_INDEX`. Default: discover + return, share nothing.
 */

import { nanoid } from "nanoid";
import type { ExecutionTrace, SkillManifest } from "../types/index.js";
// ExecutionResult is defined in ./index.ts, not the types barrel. Type-only
// import, so the execution/index.ts <-> obscura-backend.ts cycle is erased.
import type { ExecutionResult } from "./index.js";
import {
  captureAndIndexViaObscura,
  type CaptureAndIndexOptions,
} from "../capture/obscura-index.js";

/** True unless the obscura backend is explicitly disabled (default: obscura). */
export function obscuraBackendSelected(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.UNBROWSE_BROWSER_BACKEND ?? "").trim().toLowerCase();
  return !["cdp", "chrome", "kuri", "chromium"].includes(v);
}

/**
 * Opt-in to SHARE discovered routes to the reusable index. Default OFF — a
 * capture discovers and returns its routes but writes nothing to the shared
 * store unless the caller opted in via UNBROWSE_SHARE_INDEX=1|true.
 */
export function shareOptIn(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.UNBROWSE_SHARE_INDEX ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export interface ObscuraCaptureArgs {
  skill: SkillManifest;
  url: string;
  intent: string;
}

/**
 * Run a page capture through the obscura backend and shape it as an
 * ExecutionResult, exactly as executeBrowserCapture's kuri path does. `overrides`
 * lets tests inject a capture runner / fetch / auth session and force the opt-in;
 * production passes none, so auth is sourced from the user's browsers and the
 * share gate reads the environment.
 */
export async function executeCaptureViaObscura(
  args: ObscuraCaptureArgs,
  overrides: Partial<CaptureAndIndexOptions> = {},
): Promise<ExecutionResult> {
  const { skill, url, intent } = args;
  const shareToIndex = overrides.shareToIndex ?? shareOptIn();
  const res = await captureAndIndexViaObscura(url, intent, {
    maxFollow: 2, // server path opts into navigate-discovery (overridable by tests)
    ...overrides,
    shareToIndex,
  });

  const learned = res.index?.skill ?? undefined;
  const trace: ExecutionTrace = {
    trace_id: nanoid(),
    skill_id: learned?.skill_id ?? skill.skill_id,
    endpoint_id: "obscura-capture",
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    success: res.routes.length > 0,
    api_call_count: res.routes.length,
    result: {
      backend: "obscura",
      final_url: res.capture.final_url,
      endpoints_discovered: res.routes.length,
      passive: res.discovery.passive.length,
      probed: res.discovery.probed.length,
      shared_to_index: res.shared,
      learned_skill_id: learned?.skill_id,
    },
    decision_trace: [
      { step: "obscura_backend_capture", backend: "obscura", shared: res.shared },
    ],
  };

  return { trace, result: trace.result, learned_skill: learned };
}
