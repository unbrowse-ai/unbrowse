import { cachePublishedSkill, validateManifest, publishGraphEdges } from "../client/index.js";
import { attributeLifecycle, type LifecycleEvent } from "../runtime/lifecycle.js";
import { publishSkill } from "../marketplace/index.js";
import type { SkillManifest } from "../types/index.js";

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

    const publishableEndpoints = skill.endpoints.filter((endpoint) => endpoint.method !== "WS");
    if (publishableEndpoints.length === 0) return;

    const { operation_graph: _graph, ...publishBase } = skill;
    const publishDraft: SkillManifest = {
      ...publishBase,
      endpoints: publishableEndpoints,
    };

    const validation = await deps.validateManifest({ ...publishDraft, skill_id: "__validate__" });
    if (!validation.valid) {
      console.warn(
        `[publish] passive publish skipped for ${skill.skill_id}: ${validation.hardErrors.join("; ") || "validation failed"}`,
      );
      return;
    }

    const publishStart = Date.now();
    const published = await deps.publishSkill(publishDraft);
    const publishMs = Date.now() - publishStart;
    deps.cachePublishedSkill({
      ...skill,
      ...published,
      endpoints: mergeBackendDescriptions(skill, published),
      operation_graph: skill.operation_graph,
      ...(skill.auth_profile_ref ? { auth_profile_ref: skill.auth_profile_ref } : {}),
    });

    // Publish graph edges via dedicated endpoint (fire-and-forget)
    if (skill.operation_graph?.operations) {
      for (const op of skill.operation_graph.operations) {
        const opEdges = (skill.operation_graph.edges ?? [])
          .filter(e => e.from_operation_id === op.operation_id)
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

/** Await all in-flight passive publish jobs. Call before process exit. */
export async function drainPendingPassivePublishes(): Promise<void> {
  const pending = [...passivePublishInFlight.values()];
  if (pending.length === 0) return;
  console.log(`[publish] draining ${pending.length} pending passive publish(es)...`);
  await Promise.allSettled(pending);
  console.log(`[publish] all passive publishes drained`);
}

export function resetPassivePublishQueueForTests(): void {
  passivePublishInFlight.clear();
}
