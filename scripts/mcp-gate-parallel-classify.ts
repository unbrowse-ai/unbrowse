// Pure helpers for the parallel MCP-gate collector. Split out from
// scripts/mcp-gate-parallel-collect.ts so the classification can be
// unit-tested without dragging in the top-level-await runtime.
//
// Run evidence: 2026-05-18 MCP gate run `20260518T092341Z` mislabeled
// 17/30 probes whose snap landed on the right host as `go_failed`
// because the precedence on line 105 collapsed `cb.next_step ?? cb._go_failed`
// into a single truthy check. `cb.next_step` is ALWAYS truthy on a
// successful close (buildCheckpointNextStep returns a prose hint), so
// the original expression read `(<prose hint>) ? "go_failed" : ...`.
//
// Three buckets are what the close response actually declares — no
// invented `auth_handoff` arm; next_step is a prose hint, not a
// machine-readable handoff signal.

export type CloseBodyForReason = {
  indexed?: boolean;
  _go_failed?: unknown;
};

export type Reason = "indexed" | "go_failed" | "capture_did_not_emit_skill_id";

export function classifyReason(cb: CloseBodyForReason): Reason {
  if (cb.indexed === true) return "indexed";
  if (cb._go_failed) return "go_failed";
  return "capture_did_not_emit_skill_id";
}

// Bug 3 (same run `20260518T092341Z`): probes 036 Gmail and 040 Drive
// borrowed probe 034's Google-Finance skill_id `khTcB4neLqAQivzTwVyiP`
// because the collect site at L77 used
//   cb.skill_id ?? post2.body?.trace?.skill_id ?? pre.body?.trace?.skill_id ?? null
// without checking whether the resolve actually matched. The orchestrator
// emits `status: "no_match"` paired with a `probeTrace` whose skill_id can
// be a sibling capture's id (see src/orchestrator/index.ts:3743). The fix
// is a two-line guard: only adopt resolve.trace.skill_id if resolve was
// not no_match. close.skill_id stays the authoritative source.

export type ResolveBodyForSkillPick = {
  status?: string;
  trace?: { skill_id?: string };
};

export type CloseBodyForSkillPick = {
  skill_id?: string;
};

export function pickSkillId(
  cb: CloseBodyForSkillPick,
  post2: ResolveBodyForSkillPick | undefined,
  pre: ResolveBodyForSkillPick | undefined,
): string | null {
  if (cb.skill_id) return cb.skill_id;
  if (post2 && post2.status !== "no_match" && post2.trace?.skill_id) return post2.trace.skill_id;
  if (pre && pre.status !== "no_match" && pre.trace?.skill_id) return pre.trace.skill_id;
  return null;
}
