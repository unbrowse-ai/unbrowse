/**
 * Harness docs contract — pure predicates for "did the CLI follow what the docs want?"
 *
 * Source of truth is SKILL.md + AGENTS.md three-move contract:
 *   1. Default:  unbrowse "<task>" --url <url>  (or bare get) — harness auto-uses a local browser session when one exists for <url> (opt-out via UNBROWSE_IMPORT_BROWSER_COOKIES=0)
 *   2. On auth_required: if multiple browsers have plausible sessions, the harness surfaces an ask gate naming the browsers (choose one, then retry #1 once); when a single session exists the retry is automatic — `unbrowse auth <login_url>` is the fallback only when no artifact exists
 *   3. On miss/no_match: run next_step once (unbrowse capture --url <url> --intent "<task>"), then retry #1 once
 *   4. Mutations: dry-run first, then host approval — agent may NOT self-approve
 *   5. Never: curl/WebFetch loops, go→snap→click for ordinary reads, hand-run resolve→execute for reads, or retry beyond once.
 *
 * This module is pure (no FS/network) so tests can pin the harness invariants.
 */

import { AGENT_PATH } from "../agent-path.js";

export type HarnessViolationCode =
  | "hand_drove_browser_for_read"
  | "hand_drove_resolve_execute_for_read"
  | "ignored_next_step"
  | "retried_beyond_once"
  | "used_curl_or_webfetch_fallback"
  | "picked_browser_or_proxy_flag"
  | "mutation_without_dry_run"
  | "self_approved_mutation"
  | "next_step_not_executable"
  | "missing_next_step_on_recoverable_failure";

export interface HarnessCheckInput {
  /** Ordered CLI commands the agent ran (normalized to `unbrowse <rest>` form). */
  commands: string[];
  /** Optional per-command outcomes (same order as commands); unknown → undefined. */
  outcomes?: Array<{ ok?: boolean; status?: string; next_step?: string; gate?: unknown } | undefined>;
}

export interface HarnessVerdict {
  faithful: boolean;
  violations: Array<{ code: HarnessViolationCode; detail: string; at_index?: number }>;
  guidance: string[];
}

const BROWSER_LOOP_RE = /\bgo\b.*\bsnap\b|\bsnap\b.*\bclick\b|\bgo\b.*\bclick\b/i;
const RESOLVE_EXECUTE_RE = /\bresolve\b.*\bexecute\b/i;
const CURL_RE = /\bcurl\b|\bWebFetch\b|\bwget\b/i;
const PROXY_FLAG_RE = /--browser|--profile|--proxy|--headed|--chromium|--firefox/i;
const FLAGS_REQUIRING_DRY_RUN = new Set(["execute"]);
const AUTH_RE = /\bauth(_required)?\b/i;
const MISS_RE = /\bno_?match\b|\bno_cached_match\b|\bempty\b|\bnot_found\b/i;

// What the docs authorize as next_step targets
const ALLOWED_NEXT_STEPS = new Set([
  `unbrowse auth`,
  `unbrowse capture`,
]);

function isAuthNextStep(cmd: string): boolean {
  return cmd.trim().startsWith("unbrowse auth");
}
function isCaptureNextStep(cmd: string): boolean {
  return cmd.trim().startsWith("unbrowse capture");
}
function isFrontDoor(cmd: string): boolean {
  const t = cmd.trim();
  if (/\bunbrowse\s+capture\b/.test(t) || /\bunbrowse\s+auth\b/.test(t) || /\bunbrowse\s+execute\b/.test(t)) return false;
  return /\bunbrowse\b/.test(t) && (
    /--url\b/.test(t) ||
    /\bget\b/.test(t) ||
    /^unbrowse\s+"[^"]+"\s*$/.test(t) ||
    /^unbrowse\s+'[^']+'\s*$/.test(t)
  );
}
function isExecute(cmd: string): boolean {
  return /\bexecute\b/.test(cmd);
}

export function checkHarnessContract(input: HarnessCheckInput): HarnessVerdict {
  const violations: HarnessVerdict["violations"] = [];
  const guidance: string[] = [];
  const cmds = input.commands.map((c) => c.trim()).filter(Boolean);

  // Gather sequence string for loop detection
  const seq = cmds.join(" ; ");

  // Never: go→snap→click loops for ordinary reads (AGENTS.md: "Do not go→snap→click for ordinary reads")
  if (BROWSER_LOOP_RE.test(seq) && cmds.some(isFrontDoor) === false) {
    // Only flag when the loop appears WITHOUT a front-door intent — i.e. hand-driving browser instead of one-call
    // If the transcript is *only* DOM interaction with no front-door attempt, it's a violation.
    // If front-door was tried and failed, a subsequent go/snap is not automatically a violation — check outcomes.
    const hasFrontDoorAttempt = cmds.some(isFrontDoor);
    if (!hasFrontDoorAttempt) {
      // Heuristic: pure go/snap/click sequence for a site that could have been a front-door read
      if (/https?:\/\//.test(seq) && BROWSER_LOOP_RE.test(seq)) {
        violations.push({ code: "hand_drove_browser_for_read", detail: "Detected go→snap→click loop; use unbrowse \"<task>\" --url <url> for ordinary reads (SKILL.md step 1)." });
        guidance.push(AGENT_PATH.cli.primary);
      }
    } else {
      // Even with a front-door attempt, a full go→snap→click loop BEFORE exhausting next_step is suspect
      // Only flag if outcomes indicate no recoverable failure preceded the loop
      const outcomes = input.outcomes ?? [];
      const hadRecoverableFailureBeforeLoop = outcomes.slice(0, Math.max(0, cmds.findIndex((c) => /\bgo\b|\bsnap\b/.test(c)))).some((o) => o && (AUTH_RE.test(o.status ?? "") || MISS_RE.test(o.status ?? "") || o.next_step));
      if (!hadRecoverableFailureBeforeLoop && BROWSER_LOOP_RE.test(seq)) {
        violations.push({ code: "hand_drove_browser_for_read", detail: "Browser loop before following next_step; follow the single recovery step first." });
      }
    }
  }

  // Never: hand-run resolve→execute for ordinary reads
  if (RESOLVE_EXECUTE_RE.test(seq)) {
    // This is allowed ONLY when --no-execute was used for inspection or when debugging; for ordinary reads it's a bypass.
    // We flag when resolve→execute appears without explicit debug intent
    const isDebug = cmds.some((c) => /--no-execute|resolve\s+--intent/.test(c));
    if (!isDebug) {
      // Don't auto-flag if the harness itself produced the resolve→execute as next_step-like guidance
      const priorHadFrontDoor = cmds.some(isFrontDoor);
      if (priorHadFrontDoor) {
        violations.push({ code: "hand_drove_resolve_execute_for_read", detail: "Hand-drove resolve→execute for an ordinary read; use the one-call front door and follow next_step verbatim." });
        guidance.push(`Retry with: ${AGENT_PATH.cli.primary}`);
      }
    }
  }

  // Never: curl/WebFetch fallback
  for (let i = 0; i < cmds.length; i++) {
    if (CURL_RE.test(cmds[i])) {
      violations.push({ code: "used_curl_or_webfetch_fallback", detail: `Fallback to curl/WebFetch at step ${i + 1} violates SKILL.md "Never" — use unbrowse or report the blocker.`, at_index: i });
    }
  }

  // Never: picking browsers/profiles/proxy flags
  for (let i = 0; i < cmds.length; i++) {
    if (PROXY_FLAG_RE.test(cmds[i]) && !/unbrowse capture|unbrowse auth|unbrowse get/.test(cmds[i])) {
      // capture/auth/get may legitimately carry --url etc; flag only --browser-like selectors
      if (/\b--browser\b|\b--profile\b|\b--proxy\b/.test(cmds[i])) {
        violations.push({ code: "picked_browser_or_proxy_flag", detail: `Do not pick browsers/profiles/proxies at step ${i + 1} — the harness chooses the path.`, at_index: i });
      }
    }
  }

  // Mutation without dry-run and self-approval: scan execute commands
  for (let i = 0; i < cmds.length; i++) {
    if (isExecute(cmds[i])) {
      if (!/--dry-run/.test(cmds[i])) {
        violations.push({ code: "mutation_without_dry_run", detail: `Mutation at step ${i + 1} missing --dry-run; docs require dry-run then host approval.`, at_index: i });
        guidance.push('unbrowse execute --skill ID --endpoint ID --dry-run  # then surface the typed approval gate');
      }
      if (/--confirm|--approve/.test(cmds[i])) {
        violations.push({ code: "self_approved_mutation", detail: `Agent self-approved mutation at step ${i + 1}; an invoking agent cannot approve its own request.` , at_index: i });
      }
    }
  }

  // Recovery discipline: follow next_step exactly once, don't ignore it, don't retry beyond once
  const outcomes = input.outcomes ?? [];
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (!o) continue;
    const hasNextStep = typeof o.next_step === "string" && /^unbrowse(?:\s|$)/.test(o.next_step.trim());
    const hasGate = o.gate !== undefined;
    const isRecoverable = o.status && (AUTH_RE.test(o.status) || MISS_RE.test(o.status) || hasNextStep);
    const isFailed = o.ok === false || (o.status && /auth_required|no_?match|empty|not_found/i.test(o.status));

    if (isFailed && isRecoverable && !hasNextStep && !hasGate) {
      violations.push({ code: "missing_next_step_on_recoverable_failure", detail: `Recoverable failure at step ${i + 1} (${o.status}) produced no next_step or gate.`, at_index: i });
    }
    if (hasNextStep && !isExecute(o.next_step!) && !isAuthNextStep(o.next_step!) && !isCaptureNextStep(o.next_step!)) {
      // next_step must be executable unbrowse command — prose violates contract
      if (!/^unbrowse\s+\S+/.test(o.next_step!.trim())) {
        violations.push({ code: "next_step_not_executable", detail: `next_step at step ${i + 1} is not an executable unbrowse command: ${JSON.stringify(o.next_step)}`, at_index: i });
      }
    }
    // Ignored next_step: failure had next_step, but next command wasn't it
    if (hasNextStep && i + 1 < cmds.length) {
      const expected = o.next_step!.trim();
      const actual = cmds[i + 1].trim();
      if (actual !== expected && !actual.startsWith(expected.split(" ").slice(0, 3).join(" "))) {
        // Allow retry of front door as next action — docs say "run next_step then retry #1"
        const isRetry = isFrontDoor(actual);
        if (!isRetry) {
          violations.push({ code: "ignored_next_step", detail: `Ignored next_step at step ${i + 1}: expected ${JSON.stringify(expected)}, ran ${JSON.stringify(actual)}`, at_index: i });
          guidance.push(`Run next_step verbatim: ${expected}`);
        }
      }
    }
  }

  // Retry beyond once: count front-door retries after a single failure
  const frontDoorIndices = cmds.map((c, i) => isFrontDoor(c) ? i : -1).filter((i) => i !== -1);
  if (frontDoorIndices.length > 2) {
    // More than initial + one retry violates "retry step 1 once"
    violations.push({ code: "retried_beyond_once", detail: `Front-door retried ${frontDoorIndices.length} times; docs allow at most one retry after next_step (then stop).` });
    guidance.push("Stop and report the blocker.");
  }

  // Emit canonical guidance when violations exist but no specific guidance yet
  if (violations.length && guidance.length === 0) {
    guidance.push(...[`Agent path: ${AGENT_PATH.cli.primary}`, `Auth: ${AGENT_PATH.cli.auth}`, `Capture: ${AGENT_PATH.cli.capture}`]);
  }

  return { faithful: violations.length === 0, violations, guidance };
}

export function nextStepIsExecutable(nextStep: unknown): boolean {
  return typeof nextStep === "string" && /^unbrowse(?:\s|$)/.test(nextStep.trim());
}

export function payloadHasValidNextStep(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const rec = payload as Record<string, unknown>;
  const candidates = [rec.next_step, (rec.result as Record<string, unknown> | undefined)?.next_step];
  for (const c of candidates) {
    if (typeof c === "string" && /^unbrowse(?:\s|$)/.test(c.trim())) return true;
    if (c && typeof c === "object" && typeof (c as Record<string, unknown>).command === "string"
        && /^unbrowse(?:\s|$)/.test(((c as Record<string, unknown>).command as string).trim())) return true;
  }
  return false;
}
