import { cachePublishedSkill, validateManifest, publishGraphEdges } from "../client/index.js";
import {
  formatMarketplacePublishSelection,
  selectMarketplacePublishClosure,
} from "../publish-admission.js";
import { attributeLifecycle, type LifecycleEvent } from "../runtime/lifecycle.js";
import { publishSkill } from "../marketplace/index.js";
import { decideCheckpointPublish } from "../settings.js";
import type { SkillManifest } from "../types/index.js";
import { readWorkflowArtifact } from "../workflow/artifact.js";
import { buildWorkflowPublishArtifact, writeWorkflowPublishArtifact } from "../workflow/publish.js";

type PassivePublishDeps = {
  cachePublishedSkill: typeof cachePublishedSkill;
  publishSkill: typeof publishSkill;
  validateManifest: typeof validateManifest;
};

export type PassiveParityVerdict = "pass" | "fail" | "skip";

type PassivePublishOptions = {
  deps?: PassivePublishDeps;
  parity?: PassiveParityVerdict | Promise<PassiveParityVerdict> | (() => Promise<PassiveParityVerdict>);
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

export function queuePassiveSkillPublish(
  skill: SkillManifest,
  options: PassivePublishOptions = {},
): Promise<void> {
  const deps = options.deps ?? defaultDeps;
  const existing = passivePublishInFlight.get(skill.skill_id);
  if (existing) return existing;

  const job = (async () => {
    if (skill.execution_type !== "http") return;

    const publishDecision = decideCheckpointPublish(skill.domain);
    if (!publishDecision.publishQueued) {
      console.warn(
        `[publish] passive publish skipped for ${skill.skill_id}: ${publishDecision.mode} (${publishDecision.reason})`,
      );
      return;
    }

    const parityVerdict =
      typeof options.parity === "function"
        ? await options.parity()
        : options.parity instanceof Promise
          ? await options.parity
          : options.parity;
    if (parityVerdict === "fail") {
      console.warn(`[publish] passive publish skipped for ${skill.skill_id}: parity_failed`);
      return;
    }

    const selection = selectMarketplacePublishClosure(skill);
    if (selection.endpoints.length === 0) {
      console.warn(
        `[publish] passive publish skipped for ${skill.skill_id}: no admitted endpoints (${formatMarketplacePublishSelection(selection)})`,
      );
      return;
    }

    const { operation_graph: _graph, ...publishBase } = skill;
    const publishDraft: SkillManifest = {
      ...publishBase,
      endpoints: selection.endpoints,
    };

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
    const published = await deps.publishSkill(publishDraft);
    const publishMs = Date.now() - publishStart;
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

    // Publish graph edges via dedicated endpoint (fire-and-forget)
    if (skill.operation_graph?.operations) {
      for (const op of skill.operation_graph.operations) {
        if (!selection.closure_operation_ids.includes(op.operation_id)) continue;
        const opEdges = (skill.operation_graph.edges ?? [])
          .filter(e => e.from_operation_id === op.operation_id && selection.closure_operation_ids.includes(e.to_operation_id))
          .map(e => ({
            target_endpoint_id: skill.operation_graph!.operations.find(
              t => t.operation_id === e.to_operation_id
            )?.endpoint_id ?? e.to_operation_id,
            kind: e.kind,
            confidence: e.confidence,
          }));
        if (opEdges.length > 0) {
          publishGraphEdges(skill.domain, {
            endpoint_id: op.endpoint_id,
            method: op.method,
            url_template: op.url_template,
          }, opEdges).catch(() => {});
        }
      }
    }

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
 * process exits cleanly. The publish work is best-effort by design; the
 * canonical path is the marketplace publish-on-execute, and any in-flight
 * passive publish that doesn't settle here resumes on the next invocation
 * via the queue. CLI exit speed (D5 north-star: p50 ≤2s) wins over
 * waiting for a network publish to round-trip.
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
