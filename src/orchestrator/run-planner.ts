/**
 * src/orchestrator/run-planner.ts
 *
 * Shared planner for `unbrowse run`. Pure decision function consumed by:
 *   - CLI       (src/cli.ts cmdRun)
 *   - HTTP      (POST /v1/run, future)
 *   - MCP       (unbrowse_run tool, future)
 *
 * The decision tree mirrors cmdRun in src/cli.ts:835-1043 but injects all
 * I/O and host concerns (resolve/execute/capture/browse, telemetry) so the
 * same planner can run inside a CLI, a worker handler, or an MCP tool.
 *
 * NORTHSTAR.md is the spec. Do not import logging, spinners, or argv parsing
 * here — those belong to the host adapters.
 */

export type RunPolicy = {
  allow_browser?: boolean;
  allow_index?: boolean;
  allow_paid_graph?: boolean;
  allow_side_effects?: boolean;
  confirm_third_party_terms?: boolean;
  skip_robots?: boolean;
  budget_ms?: number;
};

export type RunPlannerInput = {
  url: string;
  intent: string;
  params?: Record<string, unknown>;
  policy?: RunPolicy;
  projection?: Record<string, unknown>;
};

export type RunPlanStepKind = "resolve" | "execute" | "index" | "browse";

export type RunPlanStep = {
  step: RunPlanStepKind;
  mode?: string;
  status: string;
  reason?: string;
  endpoint_id?: string;
  session_id?: string;
  label?: string;
  source?: string;
  endpoints_discovered?: number;
  auth_recommended?: boolean;
  auth_required?: boolean;
  capture_pattern?: string | null;
  error?: string | null;
};

export type RunPlannerStatus =
  | "ok"
  | "auth_required"
  | "browse_required"
  | "payment_required"
  | "blocked"
  | "error";

export type NextAction = {
  title?: string;
  command?: string;
  tool?: string;
  why: string;
};

export type RunPlannerResult = {
  status: RunPlannerStatus;
  result?: unknown;
  next_action?: NextAction;
  run_plan: RunPlanStep[];
};

export type ResolvedEndpoint = {
  endpoint_id: string;
  method?: string;
  needs_params?: boolean;
  requires_third_party_terms_confirmation?: boolean;
  [k: string]: unknown;
};

export type ResolveOutcome = {
  status?: "hit" | "miss" | string;
  error?: string;
  source?: string;
  skill?: { skill_id: string };
  available_endpoints?: ResolvedEndpoint[];
  result?: unknown;
  login_url?: string;
};

export type ExecuteOutcome = {
  result?: { data?: unknown; error?: string };
  trace?: { success?: boolean; endpoint_id?: string };
  error?: string;
  status?: string;
};

export type CaptureOutcome = {
  skill_id?: string;
  endpoints_discovered?: number;
  auth_recommended?: boolean;
  capture_pattern?: string | null;
  error?: string;
};

export type BrowseOutcome = {
  ok?: boolean;
  session_id?: string;
  auth_required?: boolean;
  url?: string;
  error?: string;
};

export type RunPlannerDeps = {
  resolve: (args: {
    url: string;
    intent: string;
    params?: Record<string, unknown>;
    policy: Required<RunPolicy>;
    label: string;
  }) => Promise<ResolveOutcome>;

  execute: (args: {
    skill_id: string;
    endpoint_id: string;
    url: string;
    intent: string;
    params?: Record<string, unknown>;
    confirm_third_party_terms?: boolean;
    skip_robots?: boolean;
  }) => Promise<ExecuteOutcome>;

  capture: (args: { url: string; intent: string }) => Promise<CaptureOutcome>;

  browse: (args: { url: string }) => Promise<BrowseOutcome>;

  onTelemetry?: (event: string, properties?: Record<string, unknown>) => void;
};

export const DEFAULT_RUN_POLICY: Required<RunPolicy> = {
  allow_browser: true,
  allow_index: true,
  allow_paid_graph: true,
  allow_side_effects: false,
  confirm_third_party_terms: false,
  skip_robots: false,
  budget_ms: 8000,
};

export function resolveRunPolicy(p?: RunPolicy): Required<RunPolicy> {
  return { ...DEFAULT_RUN_POLICY, ...(p ?? {}) };
}

function isResolveHit(r: ResolveOutcome): boolean {
  if (r.status === "hit") return true;
  if (r.error) return false;
  return Array.isArray(r.available_endpoints) && r.available_endpoints.length > 0;
}

function endpointIsSafeToAutoExecute(
  endpoint: ResolvedEndpoint | undefined,
  hasParams: boolean,
): boolean {
  if (!endpoint) return false;
  const method = String(endpoint.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (endpoint.needs_params && !hasParams) return false;
  return true;
}

function captureIsThin(c: CaptureOutcome): boolean {
  if (c.error) return true;
  const n = typeof c.endpoints_discovered === "number" ? c.endpoints_discovered : 0;
  return n <= 0;
}

/**
 * runPlanner — choose the cheapest correct path to the user's outcome.
 *
 * Decision order (mirrors cmdRun, src/cli.ts:835–1043):
 *   1. resolve(intent + url)
 *   2. resolve.auth_required          → return auth_required
 *   3. resolve.hit + safe endpoint    → execute → ok
 *   4. resolve.hit + unsafe endpoint  → blocked + next_action(unbrowse execute …)
 *   5. resolve.hit + 3p-terms         → blocked + next_action(--confirm-third-party-terms)
 *   6. resolve.miss + !allow_index    → blocked + next_action(retry without --no-index)
 *   7. resolve.miss + allow_index     → capture → re-resolve → branch by outcome
 *   8. still unresolved + allow_browser → browse → browse_required
 *   9. !allow_browser                 → blocked + next_action(unbrowse go …)
 */
export async function runPlanner(
  input: RunPlannerInput,
  deps: RunPlannerDeps,
): Promise<RunPlannerResult> {
  const policy = resolveRunPolicy(input.policy);
  const run_plan: RunPlanStep[] = [];
  const hasParams = !!input.params && Object.keys(input.params).length > 0;
  const tel = (event: string, props?: Record<string, unknown>) =>
    deps.onTelemetry?.(event, props);

  tel("run_planner_started", { url: input.url, intent: input.intent });

  const tryResolve = async (label: string): Promise<ResolveOutcome> => {
    run_plan.push({ step: "resolve", mode: "direct_or_cached", status: "started", label });
    let outcome: ResolveOutcome;
    try {
      outcome = await deps.resolve({
        url: input.url,
        intent: input.intent,
        params: input.params,
        policy,
        label,
      });
    } catch (err) {
      run_plan[run_plan.length - 1].status = "error";
      run_plan[run_plan.length - 1].error = (err as Error)?.message ?? String(err);
      throw err;
    }
    const last = run_plan[run_plan.length - 1];
    last.status = isResolveHit(outcome) ? "hit" : "miss";
    if (outcome.error) last.error = outcome.error;
    if (typeof outcome.source === "string") last.source = outcome.source;
    return outcome;
  };

  const tryExecute = async (
    skillId: string,
    endpoint: ResolvedEndpoint,
  ): Promise<ExecuteOutcome> => {
    run_plan.push({
      step: "execute",
      mode: "direct_api",
      status: "started",
      endpoint_id: endpoint.endpoint_id,
    });
    let res: ExecuteOutcome;
    try {
      res = await deps.execute({
        skill_id: skillId,
        endpoint_id: endpoint.endpoint_id,
        url: input.url,
        intent: input.intent,
        params: input.params,
        confirm_third_party_terms: policy.confirm_third_party_terms,
        skip_robots: policy.skip_robots,
      });
    } catch (err) {
      run_plan[run_plan.length - 1].status = "error";
      run_plan[run_plan.length - 1].error = (err as Error)?.message ?? String(err);
      throw err;
    }
    const last = run_plan[run_plan.length - 1];
    const ok = res?.trace?.success === true || (!res?.error && !res?.result?.error);
    last.status = ok ? "complete" : "error";
    if (res?.error) last.error = res.error;
    else if (res?.result?.error) last.error = res.result.error;
    return res;
  };

  // --- 1. First resolve ---
  let resolved: ResolveOutcome;
  try {
    resolved = await tryResolve("first_pass");
  } catch (err) {
    return {
      status: "error",
      next_action: { why: `resolve failed: ${(err as Error)?.message ?? String(err)}` },
      run_plan,
    };
  }

  // --- 2. Auth-required short-circuit ---
  if (resolved.error === "auth_required") {
    return {
      status: "auth_required",
      result: resolved,
      next_action: {
        title: "Authenticate site",
        command: `unbrowse auth "${resolved.login_url ?? input.url}"`,
        why: "The site needs an interactive login before Unbrowse can call or index private routes.",
      },
      run_plan,
    };
  }

  // --- 2b. Payment-required short-circuit ---
  // NORTHSTAR.md §"What Counts As A True Miss" forbids using capture/browse
  // to bypass payment gates. Surface as a terminal status; agent must opt in.
  if (resolved.error === "payment_required") {
    return {
      status: "payment_required",
      result: resolved,
      next_action: {
        title: "Payment required",
        why: "Resolve indicated payment is required for this route. Capture/browse fallback is not allowed to bypass payment gates.",
      },
      run_plan,
    };
  }

  // --- 3-5. Hit branch ---
  if (isResolveHit(resolved)) {
    const skillId = resolved.skill?.skill_id;
    const endpoint = resolved.available_endpoints?.[0];

    if (skillId && endpoint) {
      if (
        endpoint.requires_third_party_terms_confirmation === true &&
        !policy.confirm_third_party_terms
      ) {
        run_plan.push({
          step: "execute",
          mode: "direct_api",
          status: "skipped",
          reason: "requires_third_party_terms_confirmation",
          endpoint_id: endpoint.endpoint_id,
        });
        return {
          status: "blocked",
          result: resolved,
          next_action: {
            title: "Confirm third-party terms",
            command: `unbrowse run "${input.url}" "${input.intent}" --confirm-third-party-terms`,
            why: "The best endpoint requires explicit confirmation before execution.",
          },
          run_plan,
        };
      }

      if (endpointIsSafeToAutoExecute(endpoint, hasParams)) {
        const exec = await tryExecute(skillId, endpoint);
        const ok = exec?.trace?.success === true || (!exec?.error && !exec?.result?.error);
        return {
          status: ok ? "ok" : "error",
          result: exec,
          run_plan,
        };
      }

      run_plan.push({
        step: "execute",
        mode: "direct_api",
        status: "skipped",
        reason: "endpoint_not_safe_or_missing_params",
        endpoint_id: endpoint.endpoint_id,
      });
      return {
        status: "blocked",
        result: resolved,
        next_action: {
          title: "Execute selected endpoint",
          command: `unbrowse execute --skill ${skillId} --endpoint ${endpoint.endpoint_id}`,
          why: "Run found a candidate but did not auto-execute because it is not a safe ready GET.",
        },
        run_plan,
      };
    }
    // hit but no endpoint to execute — fall through to miss handling
  }

  // --- 6. Index gate ---
  if (!policy.allow_index) {
    return {
      status: "blocked",
      result: resolved,
      next_action: {
        title: "Index this page",
        command: `unbrowse run "${input.url}" "${input.intent}"`,
        why: "policy.allow_index=false stopped the automatic capture/index fallback.",
      },
      run_plan,
    };
  }

  // --- 7. Capture + re-resolve ---
  run_plan.push({ step: "index", mode: "capture", status: "started" });
  let capture: CaptureOutcome;
  try {
    capture = await deps.capture({ url: input.url, intent: input.intent });
  } catch (err) {
    run_plan[run_plan.length - 1].status = "error";
    run_plan[run_plan.length - 1].error = (err as Error)?.message ?? String(err);
    return {
      status: "error",
      next_action: { why: `capture failed: ${(err as Error)?.message ?? String(err)}` },
      run_plan,
    };
  }
  const captureStep = run_plan[run_plan.length - 1];
  captureStep.status = capture.error ? "error" : "complete";
  if (typeof capture.endpoints_discovered === "number") {
    captureStep.endpoints_discovered = capture.endpoints_discovered;
  }
  if (capture.auth_recommended === true) captureStep.auth_recommended = true;
  if (capture.capture_pattern !== undefined) captureStep.capture_pattern = capture.capture_pattern;
  if (capture.error) captureStep.error = capture.error;

  if (!captureIsThin(capture)) {
    const re = await tryResolve("after_index");
    if (re.error === "auth_required") {
      return {
        status: "auth_required",
        result: re,
        next_action: {
          title: "Authenticate site",
          command: `unbrowse auth "${re.login_url ?? input.url}"`,
          why: "The newly indexed route needs a site session before execution.",
        },
        run_plan,
      };
    }
    if (isResolveHit(re)) {
      const skillId = re.skill?.skill_id;
      const endpoint = re.available_endpoints?.[0];
      if (skillId && endpoint) {
        if (
          endpoint.requires_third_party_terms_confirmation === true &&
          !policy.confirm_third_party_terms
        ) {
          run_plan.push({
            step: "execute",
            mode: "direct_api",
            status: "skipped",
            reason: "requires_third_party_terms_confirmation",
            endpoint_id: endpoint.endpoint_id,
          });
          return {
            status: "blocked",
            result: re,
            next_action: {
              title: "Confirm third-party terms",
              command: `unbrowse run "${input.url}" "${input.intent}" --confirm-third-party-terms`,
              why: "The newly indexed endpoint requires explicit confirmation before execution.",
            },
            run_plan,
          };
        }
        if (endpointIsSafeToAutoExecute(endpoint, hasParams)) {
          const exec = await tryExecute(skillId, endpoint);
          const ok = exec?.trace?.success === true || (!exec?.error && !exec?.result?.error);
          return { status: ok ? "ok" : "error", result: exec, run_plan };
        }
        run_plan.push({
          step: "execute",
          mode: "direct_api",
          status: "skipped",
          reason: "endpoint_not_safe_or_missing_params",
          endpoint_id: endpoint.endpoint_id,
        });
        return {
          status: "blocked",
          result: re,
          next_action: {
            title: "Execute selected endpoint",
            command: `unbrowse execute --skill ${skillId} --endpoint ${endpoint.endpoint_id}`,
            why: "Newly indexed candidate is not a safe ready GET; agent must invoke execute manually.",
          },
          run_plan,
        };
      }
      return { status: "ok", result: re, run_plan };
    }
  }

  // --- 8-9. Browser fallback ---
  if (!policy.allow_browser) {
    return {
      status: "blocked",
      result: { capture, resolve_result: resolved },
      next_action: {
        title: "Browse interactively",
        command: `unbrowse go "${input.url}"`,
        why: "policy.allow_browser=false stopped the automatic live-browser fallback.",
      },
      run_plan,
    };
  }

  run_plan.push({ step: "browse", mode: "kuri_session", status: "started" });
  let browse: BrowseOutcome;
  try {
    browse = await deps.browse({ url: input.url });
  } catch (err) {
    run_plan[run_plan.length - 1].status = "error";
    run_plan[run_plan.length - 1].error = (err as Error)?.message ?? String(err);
    return {
      status: "error",
      next_action: { why: `browse failed: ${(err as Error)?.message ?? String(err)}` },
      run_plan,
    };
  }
  const browseStep = run_plan[run_plan.length - 1];
  browseStep.status = browse.error ? "error" : "opened";
  if (browse.session_id) browseStep.session_id = browse.session_id;
  if (browse.auth_required === true) browseStep.auth_required = true;
  if (browse.error) browseStep.error = browse.error;

  return {
    status: "browse_required",
    result: { capture, resolve_result: resolved, browse },
    next_action: {
      title: "Continue in browser",
      command: browse.session_id
        ? `unbrowse snap --session ${browse.session_id} --filter interactive`
        : "unbrowse snap --filter interactive",
      why: "The task needs page interaction before Unbrowse can finish or learn the reusable route.",
    },
    run_plan,
  };
}
