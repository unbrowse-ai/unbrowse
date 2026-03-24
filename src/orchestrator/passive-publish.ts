import { cachePublishedSkill, validateManifest } from "../client/index.js";
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

    const published = await deps.publishSkill(publishDraft);
    deps.cachePublishedSkill(
      {
        ...skill,
        ...published,
        endpoints: mergeBackendDescriptions(skill, published),
        operation_graph: skill.operation_graph,
        ...(skill.auth_profile_ref ? { auth_profile_ref: skill.auth_profile_ref } : {}),
      },
    );
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

export function resetPassivePublishQueueForTests(): void {
  passivePublishInFlight.clear();
}
