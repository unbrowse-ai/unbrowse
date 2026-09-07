// @experimental Optional embedding policy; no shipped CLI caller yet.
// Restrictions are evidence-derived denials. They are never an authorization source.

export const RESTRICT_EVALS = "bench/sites100/.artifacts/run-*.jsonl";
export const RESTRICTION_EVIDENCE_VERSION = "restriction-evidence/v1" as const;

export type AttributableFailureClass = "hallucination" | "over_scrape";

/** The only accepted wire format. Unknown/legacy judge output must be translated first. */
export interface RestrictionEvidenceV1 {
  version: typeof RESTRICTION_EVIDENCE_VERSION;
  sampleId: string;
  scope: string;
  used: string[];
  attribution: Partial<Record<AttributableFailureClass, string[]>>;
}

export interface RestrictionOptions {
  /** Complete catalog for the dispatcher surface being restricted. */
  knownTools: readonly string[];
  /** Evidence is never pooled across sites, tenants, or dispatcher surfaces. */
  scope: string;
  minSamples?: number;
  minAttributedFailures?: number;
  minFailureRate?: number;
}

export interface RestrictionStatistic {
  samples: number;
  attributedFailures: number;
  failureRate: number;
}

/** `allow` remains empty for compatibility; consumers must not treat it as authority. */
export interface Restriction {
  deny: string[];
  allow: never[];
  scope: string;
  evidenceVersion: typeof RESTRICTION_EVIDENCE_VERSION;
  statistics: Record<string, RestrictionStatistic>;
}

export class RestrictionEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestrictionEvidenceError";
  }
}

export class RestrictionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestrictionConfigurationError";
  }
}

export type RestrictionDenyReason = "unknown_tool" | "not_authorized" | "evidence_restriction";

export class RestrictionDeniedError extends Error {
  readonly reason: RestrictionDenyReason;
  readonly tool: string;

  constructor(tool: string, reason: RestrictionDenyReason) {
    super(`Tool ${JSON.stringify(tool)} cannot be dispatched: ${reason}`);
    this.name = "RestrictionDeniedError";
    this.tool = tool;
    this.reason = reason;
  }
}

const FAILURE_CLASSES: readonly AttributableFailureClass[] = ["hallucination", "over_scrape"];
const EVIDENCE_KEYS = new Set(["version", "sampleId", "scope", "used", "attribution"]);
const ATTRIBUTION_KEYS = new Set<string>(FAILURE_CLASSES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RestrictionEvidenceError(`${path} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new RestrictionEvidenceError(`${path} must be an array`);
  const result = value.map((entry, index) => nonEmptyString(entry, `${path}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new RestrictionEvidenceError(`${path} must not contain duplicates`);
  }
  return result;
}

/** Parse untrusted JSON without interpreting prose, booleans, verdicts, or `used` as failures. */
export function parseRestrictionEvidence(value: unknown, index = 0): RestrictionEvidenceV1 {
  const path = `evidence[${index}]`;
  if (!isRecord(value)) throw new RestrictionEvidenceError(`${path} must be an object`);
  for (const key of Object.keys(value)) {
    if (!EVIDENCE_KEYS.has(key)) throw new RestrictionEvidenceError(`${path}.${key} is not permitted`);
  }
  if (value.version !== RESTRICTION_EVIDENCE_VERSION) {
    throw new RestrictionEvidenceError(`${path}.version is unsupported`);
  }
  const sampleId = nonEmptyString(value.sampleId, `${path}.sampleId`);
  const scope = nonEmptyString(value.scope, `${path}.scope`);
  const used = stringArray(value.used, `${path}.used`);
  if (!isRecord(value.attribution)) {
    throw new RestrictionEvidenceError(`${path}.attribution must be an object`);
  }
  for (const key of Object.keys(value.attribution)) {
    if (!ATTRIBUTION_KEYS.has(key)) {
      throw new RestrictionEvidenceError(`${path}.attribution.${key} is not a supported failure class`);
    }
  }
  const attribution: RestrictionEvidenceV1["attribution"] = {};
  for (const failureClass of FAILURE_CLASSES) {
    const raw = value.attribution[failureClass];
    if (raw !== undefined) attribution[failureClass] = stringArray(raw, `${path}.attribution.${failureClass}`);
  }
  return { version: RESTRICTION_EVIDENCE_VERSION, sampleId, scope, used, attribution };
}

function validateThreshold(value: number, name: string, minimum: number): number {
  if (!Number.isFinite(value) || value < minimum || !Number.isInteger(value)) {
    throw new RestrictionConfigurationError(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function validateOptions(options: RestrictionOptions) {
  if (!options || typeof options !== "object") {
    throw new RestrictionConfigurationError("restriction options are required");
  }
  const scope = typeof options.scope === "string" ? options.scope.trim() : "";
  if (!scope) throw new RestrictionConfigurationError("scope must be a non-empty string");
  if (!Array.isArray(options.knownTools) || options.knownTools.length === 0) {
    throw new RestrictionConfigurationError("knownTools must be a non-empty catalog");
  }
  const catalog = new Set<string>();
  for (const tool of options.knownTools) {
    if (typeof tool !== "string" || tool.trim() === "" || catalog.has(tool)) {
      throw new RestrictionConfigurationError("knownTools must contain unique non-empty strings");
    }
    catalog.add(tool);
  }
  const minSamples = validateThreshold(options.minSamples ?? 3, "minSamples", 1);
  const minAttributedFailures = validateThreshold(
    options.minAttributedFailures ?? 2,
    "minAttributedFailures",
    1,
  );
  const minFailureRate = options.minFailureRate ?? 0.5;
  if (!Number.isFinite(minFailureRate) || minFailureRate <= 0 || minFailureRate > 1) {
    throw new RestrictionConfigurationError("minFailureRate must be > 0 and <= 1");
  }
  return { scope, catalog, minSamples, minAttributedFailures, minFailureRate };
}

/**
 * Derive scoped denials from explicit, attributable v1 evidence.
 * A tool is denied only after all configured sample/count/rate thresholds pass.
 */
export function vibeRestrict(evalResults: readonly unknown[], options: RestrictionOptions): Restriction {
  if (!Array.isArray(evalResults)) throw new RestrictionEvidenceError("evidence must be an array");
  const config = validateOptions(options);
  const parsed = evalResults.map((value, index) => parseRestrictionEvidence(value, index));
  const seenSamples = new Set<string>();
  const samples = new Map<string, number>();
  const failures = new Map<string, number>();

  for (const evidence of parsed) {
    if (evidence.scope !== config.scope) continue;
    if (seenSamples.has(evidence.sampleId)) {
      throw new RestrictionEvidenceError(`duplicate sampleId ${JSON.stringify(evidence.sampleId)}`);
    }
    seenSamples.add(evidence.sampleId);

    for (const tool of evidence.used) {
      if (!config.catalog.has(tool)) {
        throw new RestrictionEvidenceError(`unknown tool ${JSON.stringify(tool)} in evidence ${JSON.stringify(evidence.sampleId)}`);
      }
    }
    const attributed = new Set<string>();
    for (const failureClass of FAILURE_CLASSES) {
      for (const tool of evidence.attribution[failureClass] ?? []) {
        if (!config.catalog.has(tool)) {
          throw new RestrictionEvidenceError(`unknown attributed tool ${JSON.stringify(tool)} in evidence ${JSON.stringify(evidence.sampleId)}`);
        }
        if (!evidence.used.includes(tool)) {
          throw new RestrictionEvidenceError(`attributed tool ${JSON.stringify(tool)} was not used in evidence ${JSON.stringify(evidence.sampleId)}`);
        }
        attributed.add(tool); // union classes; count a sample only once per tool
      }
    }
    for (const tool of evidence.used) samples.set(tool, (samples.get(tool) ?? 0) + 1);
    for (const tool of attributed) failures.set(tool, (failures.get(tool) ?? 0) + 1);
  }

  const statistics: Record<string, RestrictionStatistic> = {};
  const deny: string[] = [];
  for (const tool of [...config.catalog].sort()) {
    const sampleCount = samples.get(tool) ?? 0;
    const failureCount = failures.get(tool) ?? 0;
    const failureRate = sampleCount === 0 ? 0 : failureCount / sampleCount;
    statistics[tool] = { samples: sampleCount, attributedFailures: failureCount, failureRate };
    if (
      sampleCount >= config.minSamples &&
      failureCount >= config.minAttributedFailures &&
      failureRate >= config.minFailureRate
    ) deny.push(tool);
  }
  return {
    deny,
    allow: [],
    scope: config.scope,
    evidenceVersion: RESTRICTION_EVIDENCE_VERSION,
    statistics,
  };
}

export type RestrictionDecision =
  | { allowed: true }
  | { allowed: false; reason: RestrictionDenyReason };

export interface RestrictionPolicy {
  decide(tool: string, otherwiseAuthorized: boolean): RestrictionDecision;
  assertCanDispatch(tool: string, otherwiseAuthorized: boolean): void;
}

/**
 * Build the dispatcher gate. `otherwiseAuthorized` must come from the real permission system:
 * this policy can turn an authorization into a denial, but can never turn a denial into an allow.
 */
export function createRestrictionPolicy(
  restriction: Pick<Restriction, "deny">,
  knownTools: readonly string[],
): RestrictionPolicy {
  const config = validateOptions({ knownTools, scope: "dispatcher-policy" });
  const denied = new Set<string>();
  for (const tool of restriction.deny) {
    if (!config.catalog.has(tool)) {
      throw new RestrictionConfigurationError(`deny contains unknown tool ${JSON.stringify(tool)}`);
    }
    denied.add(tool);
  }
  const decide = (tool: string, otherwiseAuthorized: boolean): RestrictionDecision => {
    if (!config.catalog.has(tool)) return { allowed: false, reason: "unknown_tool" };
    if (otherwiseAuthorized !== true) return { allowed: false, reason: "not_authorized" };
    if (denied.has(tool)) return { allowed: false, reason: "evidence_restriction" };
    return { allowed: true };
  };
  return {
    decide,
    assertCanDispatch(tool, otherwiseAuthorized) {
      const decision = decide(tool, otherwiseAuthorized);
      if ("reason" in decision) throw new RestrictionDeniedError(tool, decision.reason);
    },
  };
}
