import { assessIntentResult } from "../src/intent-match.js";
import type { DeferredEndpoint, HarnessCaseValidation } from "./codex-harness-lib.js";
import { compactForArtifact } from "./codex-harness-lib.js";

export type EvalJudgeMode = "local";

export type EvalReviewResult = {
  verdict: "pass" | "fail" | "skip";
  reason: string;
  source_kind: "rows" | "record" | "scalar" | "empty" | "blocked";
  matched_fields: string[];
  missing_fields: string[];
  projected_excerpt: unknown;
  row_count: number;
  observed_entity_types: string[];
  validation_failures: string[];
  echoed_params: string[];
  side_effect_observed?: string;
};

function fieldAliases(field: string): string[] {
  const lower = field.trim().toLowerCase();
  if (lower === "url") return ["url", "link", "permalink", "html_url", "web_url", "mdn_url", "http_url_to_repo"];
  if (lower === "summary") return ["summary", "description", "excerpt", "snippet"];
  if (lower === "description") return ["description", "summary", "info", "excerpt", "snippet"];
  if (lower === "score") return ["score", "points", "votes"];
  if (lower === "rating") return ["rating", "averageRating", "average_rating", "avg_rating", "stars"];
  if (lower === "sender") return ["sender", "from"];
  if (lower === "term") return ["term", "word", "title", "name"];
  return [field];
}

function collectFieldMatches(value: unknown, field: string): boolean {
  const aliases = new Set(fieldAliases(field).map((entry) => entry.toLowerCase()));
  if (value == null) return false;
  if (Array.isArray(value)) return value.some((item) => collectFieldMatches(item, field));
  if (typeof value !== "object") return false;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (aliases.has(key.toLowerCase())) {
      if (entry == null) continue;
      if (typeof entry === "string") return entry.trim().length > 0;
      if (Array.isArray(entry)) return entry.length > 0;
      return true;
    }
    if (collectFieldMatches(entry, field)) return true;
  }
  return false;
}

function compactText(value: unknown): string {
  return JSON.stringify(compactForArtifact(value)).toLowerCase();
}

function inferSourceKind(payload: unknown): EvalReviewResult["source_kind"] {
  if (payload == null) return "empty";
  const text = compactText(payload);
  if (/cloudflare|cf challenge|challenge-platform|challenge-running|just a moment|captcha|access denied|cf-browser-verification/.test(text)) return "blocked";
  if (Array.isArray(payload)) return "rows";
  if (typeof payload === "object") return "record";
  return "scalar";
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function rowScore(rows: unknown[]): number {
  return rows.reduce((score, row) => {
    if (!isObjectRecord(row)) return score;
    return score + Math.min(8, Object.keys(row).length);
  }, 0);
}

function collectCandidateCollections(value: unknown, depth = 0, out: unknown[][] = []): unknown[][] {
  if (depth > 4 || value == null) return out;
  if (Array.isArray(value)) {
    if (value.length > 0) out.push(value);
    for (const item of value.slice(0, 5)) collectCandidateCollections(item, depth + 1, out);
    return out;
  }
  if (!isObjectRecord(value)) return out;
  for (const entry of Object.values(value).slice(0, 12)) collectCandidateCollections(entry, depth + 1, out);
  return out;
}

function findBestCollection(payload: unknown): unknown[] {
  const collections = collectCandidateCollections(payload);
  if (collections.length === 0) return isObjectRecord(payload) ? [payload] : [];
  return [...collections].sort((lhs, rhs) => {
    const scoreDelta = rowScore(rhs) - rowScore(lhs);
    if (scoreDelta !== 0) return scoreDelta;
    return rhs.length - lhs.length;
  })[0] ?? [];
}

function estimateRowCount(payload: unknown): number {
  if (payload == null) return 0;
  if (Array.isArray(payload)) return payload.length;
  if (!isObjectRecord(payload)) return 1;
  const best = findBestCollection(payload);
  return best.length > 0 ? best.length : 1;
}

function normalizeEntityType(value: string): string {
  const lower = value.trim().toLowerCase();
  if (["people", "person", "profile", "profiles"].includes(lower)) return "person";
  if (["repositories", "repository", "repo", "repos"].includes(lower)) return "repository";
  if (["packages", "package"].includes(lower)) return "package";
  if (["models", "model"].includes(lower)) return "model";
  if (["posts", "post", "tweets", "tweet"].includes(lower)) return "post";
  if (["products", "product"].includes(lower)) return "product";
  if (["courses", "course"].includes(lower)) return "course";
  if (["papers", "paper"].includes(lower)) return "paper";
  if (["questions", "question"].includes(lower)) return "question";
  if (["definitions", "definition"].includes(lower)) return "definition";
  if (["quotes", "quote"].includes(lower)) return "quote";
  if (["channels", "channel", "server", "servers"].includes(lower)) return "channel";
  if (["companies", "company"].includes(lower)) return "company";
  if (["documents", "document", "docs", "doc"].includes(lower)) return "document";
  if (["topics", "topic"].includes(lower)) return "topic";
  if (["recipes", "recipe"].includes(lower)) return "recipe";
  return lower;
}

function reasonEntityType(reason: string): string | null {
  const normalized = reason.trim().toLowerCase();
  const map: Record<string, string> = {
    repository_rows: "repository",
    package_rows: "package",
    model_rows: "model",
    story_rows: "story",
    image_rows: "image",
    tag_rows: "tag",
    company_rows: "company",
    people_rows: "person",
    comment_rows: "comment",
    email_rows: "email",
    post_rows: "post",
    reddit_post_rows: "post",
    topic_rows: "topic",
    document_rows: "document",
    paper_rows: "paper",
    question_rows: "question",
    recipe_rows: "recipe",
    course_rows: "course",
    definition_rows: "definition",
    quote_rows: "quote",
    product_rows: "product",
    channel_rows: "channel",
  };
  return map[normalized] ?? null;
}

function payloadEntityHints(payload: unknown): string[] {
  const text = compactText(payload);
  const matches = new Set<string>();
  if (/\bfull_name\b|\bstargazers_count\b|\brepo_name\b/.test(text)) matches.add("repository");
  if (/\bpackage_url\b|\brequires_dist\b|\bpackage\b/.test(text)) matches.add("package");
  if (/\bcitationcount\b|\bauthors\b|\babstract\b/.test(text)) matches.add("paper");
  if (/\bdefinition\b|\bpart_of_speech\b/.test(text)) matches.add("definition");
  if (/\bregularmarketprice\b|\bquoteresponse\b|\bsymbol\b/.test(text)) matches.add("quote");
  if (/\bheadline\b|\bpublic_identifier\b|\bfollowers_count\b/.test(text)) matches.add("person");
  if (/\bfull_text\b|\bcommentary\b|\btweet_results\b|\bpost_count\b/.test(text)) matches.add("post");
  if (/\bprice\b|\brating\b|\bnumberofreviews\b|\baverageRating\b/.test(text)) matches.add("product");
  if (/\binstructor\b|\bsyllabus\b|\bduration\b/.test(text)) matches.add("course");
  if (/\banswer_count\b|\baccepted_answer\b|\bscore\b/.test(text)) matches.add("question");
  if (/\bamenities\b|\bingredients\b|\bcook\b/.test(text)) matches.add("recipe");
  if (/\bguild_id\b|\bchannel_id\b|\bserver\b/.test(text)) matches.add("channel");
  return [...matches];
}

function observedEntityTypes(payload: unknown, intentVerdict: ReturnType<typeof assessIntentResult>): string[] {
  const entities = new Set<string>();
  const fromReason = reasonEntityType(intentVerdict.reason);
  if (fromReason) entities.add(fromReason);
  for (const hint of payloadEntityHints(payload)) entities.add(hint);
  return [...entities];
}

function containsNormalizedValue(value: unknown, target: string): boolean {
  const normalizedTarget = target.trim().toLowerCase();
  if (!normalizedTarget) return false;
  if (value == null) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === normalizedTarget || normalized.includes(normalizedTarget);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).toLowerCase() === normalizedTarget;
  }
  if (Array.isArray(value)) return value.some((entry) => containsNormalizedValue(entry, target));
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some((entry) => containsNormalizedValue(entry, target));
  return false;
}

function findEchoedParams(payload: unknown, params: Record<string, unknown>, keys: string[]): string[] {
  const echoed: string[] = [];
  for (const key of keys) {
    const value = params[key];
    if (value == null) continue;
    if (containsNormalizedValue(payload, String(value))) echoed.push(key);
  }
  return echoed;
}

function detectSideEffect(payload: unknown): string | undefined {
  const text = compactText(payload);
  if (/\b(created|creation|newly_created)\b/.test(text) || /\b"id"\b/.test(text)) return "created";
  if (/\b(updated|modified|patched)\b/.test(text)) return "updated";
  if (/\bdeleted|removed|archived\b/.test(text)) return "deleted";
  if (/\bsent|delivered|posted|submitted\b/.test(text)) return "sent";
  return undefined;
}

function isMutationIntent(intent: string): boolean {
  return /\b(create|update|delete|remove|send|submit|post|archive)\b/i.test(intent);
}

function describeReason(args: {
  intentVerdict: ReturnType<typeof assessIntentResult>;
  missingFields: string[];
  validationFailures: string[];
  sourceKind: EvalReviewResult["source_kind"];
  mutationPass: boolean;
}): string {
  if (args.sourceKind === "blocked") return "blocked_challenge";
  if (args.mutationPass) return "mutation_validated";
  if (args.intentVerdict.verdict === "fail") return args.intentVerdict.reason;
  if (args.validationFailures.length > 0) return args.validationFailures[0]!;
  if (args.missingFields.length > 0) return `missing_fields:${args.missingFields.join(",")}`;
  return args.intentVerdict.reason;
}

export function resolveEvalJudgeMode(): EvalJudgeMode {
  return "local";
}

export async function reviewEvalPayload(args: {
  intent: string;
  expected_fields: string[];
  payload: unknown;
  endpoint?: DeferredEndpoint;
  judge_mode?: EvalJudgeMode;
  validate?: HarnessCaseValidation;
  params?: Record<string, unknown>;
}): Promise<EvalReviewResult> {
  const _endpoint = args.endpoint;
  const _judgeMode = args.judge_mode ?? "local";
  void _endpoint;
  void _judgeMode;

  const sourceKind = inferSourceKind(args.payload);
  const intentVerdict = assessIntentResult(args.payload, args.intent);
  const projectedPayload = intentVerdict.projected ?? args.payload;
  const matchedFields = [...new Set(args.expected_fields.filter((field) =>
    collectFieldMatches(projectedPayload, field) || collectFieldMatches(args.payload, field)
  ))];
  const missingFields = args.expected_fields.filter((field) => !matchedFields.includes(field));
  const rowCount = estimateRowCount(projectedPayload);
  const entityTypes = observedEntityTypes(projectedPayload, intentVerdict);
  const echoedParams = args.validate?.echo_params?.length && args.params
    ? findEchoedParams(projectedPayload, args.params, args.validate.echo_params)
    : [];
  const sideEffectObserved = detectSideEffect(projectedPayload);

  const validationFailures: string[] = [];
  if (args.validate?.entity_type) {
    const expected = normalizeEntityType(args.validate.entity_type);
    if (!entityTypes.map(normalizeEntityType).includes(expected)) {
      validationFailures.push(`wrong_entity_type:${expected}:${entityTypes.join("|") || "unknown"}`);
    }
  }
  if (args.validate?.min_rows != null && rowCount < args.validate.min_rows) {
    validationFailures.push(`min_rows:${rowCount}/${args.validate.min_rows}`);
  }
  if (args.validate?.echo_params?.length) {
    const missingEchoes = args.validate.echo_params.filter((key) => !echoedParams.includes(key));
    if (missingEchoes.length > 0) validationFailures.push(`echo_params:${missingEchoes.join(",")}`);
  }
  if (args.validate?.side_effect) {
    const expected = args.validate.side_effect.trim().toLowerCase();
    if (sideEffectObserved !== expected) validationFailures.push(`side_effect:${expected}:${sideEffectObserved ?? "missing"}`);
  }

  const mutationPass =
    isMutationIntent(args.intent) &&
    sourceKind !== "blocked" &&
    missingFields.length === 0 &&
    validationFailures.length === 0;
  const fieldCompletePass =
    !isMutationIntent(args.intent) &&
    sourceKind !== "blocked" &&
    intentVerdict.verdict === "skip" &&
    missingFields.length === 0 &&
    validationFailures.length === 0;
  const pass =
    mutationPass ||
    fieldCompletePass ||
    (
      sourceKind !== "blocked" &&
      intentVerdict.verdict === "pass" &&
      missingFields.length === 0 &&
      validationFailures.length === 0
    );

  return {
    verdict: pass ? "pass" : "fail",
    reason: describeReason({
      intentVerdict,
      missingFields,
      validationFailures,
      sourceKind,
      mutationPass,
    }),
    source_kind: sourceKind,
    matched_fields: matchedFields,
    missing_fields: missingFields,
    projected_excerpt: compactForArtifact(projectedPayload),
    row_count: rowCount,
    observed_entity_types: entityTypes,
    validation_failures: validationFailures,
    echoed_params: echoedParams,
    side_effect_observed: sideEffectObserved,
  };
}
