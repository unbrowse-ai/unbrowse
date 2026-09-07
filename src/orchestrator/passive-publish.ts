import { cachePublishedSkill, validateManifest } from "../client/index.js";
import {
  formatMarketplacePublishSelection,
  selectMarketplacePublishClosure,
} from "../publish-admission.js";
import { attributeLifecycle, type LifecycleEvent } from "../runtime/lifecycle.js";
import { fingerprintMarketplacePublishDraft, publishSkill } from "../marketplace/index.js";
import { decideCheckpointPublish } from "../settings.js";
import { getContributionConfig } from "../config/contribution.js";
import type { SkillManifest } from "../types/index.js";
import { readWorkflowArtifact } from "../workflow/artifact.js";
import { buildWorkflowPublishArtifact, writeWorkflowPublishArtifact } from "../workflow/publish.js";
import {
  transitionRouteLifecycle,
  validateRoutePublishPermit,
  type RouteLifecycleIdentity,
  type RouteLifecycleStoreOptions,
  type RoutePublishPermit,
} from "../runtime/route-lifecycle.js";

type PassivePublishDeps = {
  cachePublishedSkill: typeof cachePublishedSkill;
  publishSkill: typeof publishSkill;
  validateManifest: typeof validateManifest;
};

export type PassiveParityVerdict = "pass" | "fail" | "skip";

export type PassivePublishOptions = {
  deps?: PassivePublishDeps;
  parity?: PassiveParityVerdict | Promise<PassiveParityVerdict> | (() => Promise<PassiveParityVerdict>);
  /** Durable capability issued by issueRoutePublishPermit; plain assertion objects are rejected. */
  publish_permit?: RoutePublishPermit;
  route_identity?: RouteLifecycleIdentity;
  lifecycle_store?: RouteLifecycleStoreOptions;
};

const defaultDeps: PassivePublishDeps = {
  cachePublishedSkill,
  publishSkill,
  validateManifest,
};

const passivePublishInFlight = new Map<string, Promise<void>>();

function mergeBackendDescriptions(
  localSkill: SkillManifest,
  publishedSkill: SkillManifest,
): SkillManifest["endpoints"] {
  return localSkill.endpoints.map((endpoint) => {
    const backendEndpoint = publishedSkill.endpoints.find(
      (candidate) =>
        candidate.endpoint_id === endpoint.endpoint_id ||
        (candidate.method === endpoint.method && candidate.url_template === endpoint.url_template),
    );
    if (!backendEndpoint?.description) return endpoint;
    return {
      ...endpoint,
      description: backendEndpoint.description,
    };
  });
}

function passivePublishDraft(skill: SkillManifest): SkillManifest {
  const selection = selectMarketplacePublishClosure(skill);
  const selectedOperations = new Set(selection.closure_operation_ids);
  const operationGraph = skill.operation_graph ? {
    ...skill.operation_graph,
    operations: skill.operation_graph.operations.filter((operation) => selectedOperations.has(operation.operation_id)),
    edges: (skill.operation_graph.edges ?? []).filter((edge) =>
      selectedOperations.has(edge.from_operation_id) && selectedOperations.has(edge.to_operation_id)),
  } : undefined;
  return {
    ...skill,
    endpoints: selection.endpoints,
    ...(operationGraph ? { operation_graph: operationGraph } : {}),
  };
}

/** Fingerprint of exactly the sanitized admitted manifest + selected DAG closure. */
export function passivePublishArtifactFingerprint(skill: SkillManifest): string {
  return fingerprintMarketplacePublishDraft(passivePublishDraft(skill));
}

export function queuePassiveSkillPublish(
  skill: SkillManifest,
  options: PassivePublishOptions = {},
): Promise<void> {
  const deps = options.deps ?? defaultDeps;
  const existing = passivePublishInFlight.get(skill.skill_id);
  if (existing) return existing;

  const job = (async () => {
    if (skill.execution_type !== "http") return;

    if (!getContributionConfig().contribution.share_pointers) {
      console.warn(`[publish] passive publish skipped for ${skill.skill_id}: explicit_opt_out`);
      return;
    }

    const publishDecision = decideCheckpointPublish(skill.domain);
    if (!publishDecision.publishQueued) {
      console.warn(
        `[publish] passive publish skipped for ${skill.skill_id}: ${publishDecision.mode} (${publishDecision.reason})`,
      );
      return;
    }

    const permit = options.publish_permit;
    const routeIdentity = options.route_identity;
    const artifactFingerprint = passivePublishArtifactFingerprint(skill);
    if (
      !permit ||
      !routeIdentity ||
      routeIdentity.skill_id !== skill.skill_id ||
      !(await validateRoutePublishPermit(
        permit,
        routeIdentity,
        artifactFingerprint,
        options.lifecycle_store,
      ))
    ) {
      console.warn(`[publish] passive publish skipped for ${skill.skill_id}: lifecycle_publish_permit_missing_or_invalid`);
      return;
    }

    const parityVerdict =
      typeof options.parity === "function"
        ? await options.parity()
        : options.parity instanceof Promise
          ? await options.parity
          : options.parity;
    if (parityVerdict !== "pass") {
      console.warn(
        `[publish] passive publish skipped for ${skill.skill_id}: ${parityVerdict === "fail" ? "parity_failed" : "parity_not_proven"}`,
      );
      return;
    }

    const selection = selectMarketplacePublishClosure(skill);
    if (selection.endpoints.length === 0) {
      console.warn(
        `[publish] passive publish skipped for ${skill.skill_id}: no admitted endpoints (${formatMarketplacePublishSelection(selection)})`,
      );
      return;
    }

    const publishDraft = passivePublishDraft(skill);

    const validation = await deps.validateManifest({ ...publishDraft, skill_id: "__validate__" });
    if (!validation.valid) {
      writeWorkflowPublishArtifact(buildWorkflowPublishArtifact(
        skill,
        readWorkflowArtifact(skill.skill_id),
        {
          publishStatus: "blocked-validation",
          validationErrors: validation.hardErrors,
          endpointIds: selection.closure_endpoint_ids,
          rootEndpointIds: selection.root_endpoint_ids,
        },
      ));
      console.warn(
        `[publish] passive publish skipped for ${skill.skill_id}: ${validation.hardErrors.join("; ") || "validation failed"}`,
      );
      return;
    }

    const publishStart = Date.now();
    const published = await deps.publishSkill(publishDraft, {
      publish_permit: permit,
      route_identity: routeIdentity,
      lifecycle_store: options.lifecycle_store,
    });
    const publishMs = Date.now() - publishStart;
    if (published.published_remotely !== true) {
      deps.cachePublishedSkill({
        ...skill,
        ...published,
        endpoints: mergeBackendDescriptions(skill, published),
        operation_graph: skill.operation_graph,
        ...(skill.auth_profile_ref ? { auth_profile_ref: skill.auth_profile_ref } : {}),
      });
      writeWorkflowPublishArtifact(buildWorkflowPublishArtifact(
        skill,
        readWorkflowArtifact(skill.skill_id),
        {
          publishStatus: "indexed",
          endpointIds: selection.closure_endpoint_ids,
          rootEndpointIds: selection.root_endpoint_ids,
        },
      ));
      console.warn(`[publish] passive publish remained local for ${skill.skill_id}: remote_transport_not_committed`);
      return;
    }
    await transitionRouteLifecycle(routeIdentity, {
      type: "publish_succeeded",
      visibility: "public",
      artifact_fingerprint: artifactFingerprint,
    }, options.lifecycle_store);
    console.log(
      `[publish] passive publish admitted ${selection.endpoints.length}/${selection.stats.total} endpoint(s) for ${skill.skill_id} (${selection.root_endpoint_ids.length} roots, ${selection.endpoints.length - selection.root_endpoint_ids.length} closure) (${formatMarketplacePublishSelection(selection)})`,
    );
    deps.cachePublishedSkill({
      ...skill,
      ...published,
      endpoints: mergeBackendDescriptions(skill, published),
      operation_graph: skill.operation_graph,
      ...(skill.auth_profile_ref ? { auth_profile_ref: skill.auth_profile_ref } : {}),
    });
    writeWorkflowPublishArtifact(buildWorkflowPublishArtifact(
      skill,
      readWorkflowArtifact(skill.skill_id),
      {
        // Honest status: "published" only if the skill actually reached the remote
        // marketplace. A silent local-cache fallback (remote failure) is "indexed",
        // not "published" — never claim a cloud publish that did not happen.
        publishStatus: published.published_remotely ? "published" : "indexed",
        publishedAt: new Date().toISOString(),
        endpointIds: selection.closure_endpoint_ids,
        rootEndpointIds: selection.root_endpoint_ids,
      },
    ));

    // The sanitized selected DAG is part of the permit-bound manifest payload.
    // No second, unpermitted graph transport is allowed.

    const publishEvent: LifecycleEvent = {
      phase: "publish",
      skill_id: skill.skill_id,
      timestamp: new Date().toISOString(),
      duration_ms: publishMs,
      source: "marketplace",
    };
    const totals = attributeLifecycle([publishEvent]);
    console.log(`[lifecycle] publish=${totals.get("publish")}ms for ${skill.skill_id}`);
    console.log(`[publish] passive publish succeeded for ${skill.skill_id}`);
  })()
    .catch((err) => {
      console.error(
        `[publish] passive publish failed for ${skill.skill_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      passivePublishInFlight.delete(skill.skill_id);
    });

  passivePublishInFlight.set(skill.skill_id, job);
  return job;
}

/** Await all in-flight passive publish jobs. Call before process exit.
 *
 * Hard-capped via UNBROWSE_DRAIN_HARD_MS (default 500ms). The cap timer is
 * `.unref()`'d so it never holds the event loop open by itself — if the
 * drain hits the cap and the in-flight promises are still pending, they
 * release their own event-loop refs (HTTP keepalive sockets, etc.) and the
 * process exits cleanly. This drain is retained for legacy/test callers only.
 * The canonical validated lifecycle path awaits its permit-bound publication;
 * it does not claim that this process-local map resumes after a crash.
 */
export async function drainPendingPassivePublishes(): Promise<void> {
  const pending = [...passivePublishInFlight.values()];
  if (pending.length === 0) return;
  const hardMs = Math.max(
    50,
    Number.parseInt(process.env.UNBROWSE_DRAIN_HARD_MS ?? "200", 10) || 200,
  );
  console.log(`[publish] draining ${pending.length} pending passive publish(es) (cap=${hardMs}ms)...`);
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  const capPromise = new Promise<"timeout">((resolve) => {
    capTimer = setTimeout(() => resolve("timeout"), hardMs);
    // Critical: do NOT hold the event loop open just for this cap timer.
    // If everything else has released, the process should exit.
    if (typeof capTimer.unref === "function") capTimer.unref();
  });
  const outcome = await Promise.race([
    Promise.allSettled(pending).then(() => "drained" as const),
    capPromise,
  ]);
  if (capTimer) clearTimeout(capTimer);
  if (outcome === "timeout") {
    console.log(`[publish] passive publish drain hit ${hardMs}ms cap — pending work continues in background`);
  } else {
    console.log(`[publish] all passive publishes drained`);
  }
}

export function resetPassivePublishQueueForTests(): void {
  passivePublishInFlight.clear();
}
