import type { SkillManifest } from "../types/skill.js";

export interface FirstPassResult {
  intentClass: string;
  actionTaken: string;
  hit: boolean;
  interceptedEntries: unknown[];
  miniSkill?: SkillManifest;
  result?: unknown;
  timeMs: number;
}

/**
 * Stub — first-pass browser action is not yet implemented.
 * Always returns a miss so the orchestrator falls through to live capture.
 */
export async function tryFirstPassBrowserAction(
  _url: string,
  _intent: string,
  _options?: unknown,
): Promise<FirstPassResult> {
  return {
    intentClass: "unknown",
    actionTaken: "none",
    hit: false,
    interceptedEntries: [],
    timeMs: 0,
  };
}
