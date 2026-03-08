import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { performance } from "perf_hooks";
import { join } from "path";
import { getSkillChunk, isOperationHardExcluded, knownBindingsFromInputs, operationSoftPenalty } from "./index.js";
import type { SkillChunk, SkillManifest, SkillOperationNode } from "../types/index.js";
import type { LocalHarnessCase } from "./local-fixtures.js";

export interface HarnessOperationHit {
  skill_id: string;
  skill_domain: string;
  operation_id: string;
  endpoint_id: string;
  score: number;
  runnable: boolean;
  action_kind: string;
  resource_kind: string;
  negative_tags: string[];
  auth_required: boolean;
}

export interface HarnessCaseResult {
  id: string;
  pass: boolean;
  selected?: HarnessOperationHit;
  top_hits: HarnessOperationHit[];
  chunk: SkillChunk;
  expected_skill_id: string;
  expected_operation_id: string;
  selection_ms: number;
  expected_rank: number;
  wrong_top1_before_correct: number;
  failure_reason?: string;
}

export interface HarnessSummary {
  total: number;
  passed: number;
  failed: number;
  hit_rate: number;
  runnable_top1_rate: number;
  public_total: number;
  public_passed: number;
  auth_total: number;
  auth_passed: number;
  avg_selection_ms: number;
  avg_time_to_correct_ms: number;
  avg_wrong_top1_before_correct: number;
}

export interface DependencyWalkCase {
  id: string;
  skill_id: string;
  intent: string;
  authenticated?: boolean;
  initial_params?: Record<string, unknown>;
  contextUrl?: string;
  target_operation_id: string;
  expected_path?: string[];
}

export interface DependencyWalkResult {
  id: string;
  skill_id: string;
  pass: boolean;
  target_operation_id: string;
  selected_path: string[];
  final_bindings: Record<string, unknown>;
  time_to_target_ms: number;
  wrong_before_target: number;
  failure_reason?: string;
}

export interface DependencyWalkSummary {
  total: number;
  passed: number;
  failed: number;
  hit_rate: number;
  avg_time_to_target_ms: number;
  avg_wrong_before_target: number;
}

export interface GeneratedCaseSet {
  selection_cases: LocalHarnessCase[];
  walk_cases: DependencyWalkCase[];
}

type SparseVector = Map<string, number>;

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function average(items: number[]): number {
  return items.length > 0 ? items.reduce((sum, value) => sum + value, 0) / items.length : 0;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean);
}

function singularize(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

function toVector(text: string): SparseVector {
  const vec = new Map<string, number>();
  for (const token of tokenize(text)) {
    const normalized = singularize(token);
    vec.set(normalized, (vec.get(normalized) ?? 0) + 1);
  }
  return vec;
}

function cosine(lhs: SparseVector, rhs: SparseVector): number {
  let dot = 0;
  let lhsNorm = 0;
  let rhsNorm = 0;
  for (const value of lhs.values()) lhsNorm += value * value;
  for (const value of rhs.values()) rhsNorm += value * value;
  for (const [key, value] of lhs) {
    const rhsValue = rhs.get(key) ?? 0;
    dot += value * rhsValue;
  }
  if (lhsNorm === 0 || rhsNorm === 0) return 0;
  return dot / (Math.sqrt(lhsNorm) * Math.sqrt(rhsNorm));
}

function operationText(skill: SkillManifest, operation: SkillOperationNode): string {
  return [
    skill.domain,
    operation.action_kind,
    operation.resource_kind,
    operation.description_in ?? "",
    operation.description_out ?? "",
    operation.response_summary ?? "",
    operation.url_template,
    ...(operation.example_fields ?? []),
    ...operation.requires.map((binding) => binding.key),
    ...operation.provides.map((binding) => binding.key),
    ...(operation.negative_tags ?? []),
  ].join(" ");
}

function queryText(intent: string, params?: Record<string, unknown>, contextUrl?: string): string {
  const bindings = knownBindingsFromInputs(params ?? {}, contextUrl);
  return [
    intent,
    ...Object.keys(bindings),
    ...Object.values(bindings).map((value) => String(value)),
  ].join(" ");
}

function pluralize(resource: string): string {
  if (resource.endsWith("y")) return `${resource.slice(0, -1)}ies`;
  if (resource.endsWith("s")) return resource;
  return `${resource}s`;
}

function intentForOperation(operation: SkillOperationNode): string {
  switch (operation.action_kind) {
    case "search":
      return `search ${pluralize(operation.resource_kind)}`;
    case "list":
      return `get ${pluralize(operation.resource_kind)}`;
    case "detail":
      return `get ${operation.resource_kind} details`;
    case "timeline":
      return `get ${operation.resource_kind} timeline`;
    case "trending":
      return `get trending ${pluralize(operation.resource_kind)}`;
    case "status":
      return `get ${operation.resource_kind} status`;
    default:
      return `${operation.action_kind} ${pluralize(operation.resource_kind)}`;
  }
}

function collectNeighborIds(chunk: SkillChunk, operationId: string): string[] {
  return unique(
    chunk.edges.flatMap((edge) => {
      if (edge.from_operation_id === operationId) return [edge.to_operation_id];
      if (edge.to_operation_id === operationId) return [edge.from_operation_id];
      return [];
    }),
  );
}

function objectParams(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function findPrimitiveByKey(value: unknown, key: string): unknown {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPrimitiveByKey(item, key);
      if (found != null) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (entryKey === key && (entryValue == null || typeof entryValue !== "object")) return entryValue;
    if (entryKey === key && Array.isArray(entryValue) && entryValue.length > 0 && typeof entryValue[0] !== "object") return entryValue[0];
    const found = findPrimitiveByKey(entryValue, key);
    if (found != null) return found;
  }
  return undefined;
}

function bindingsFromOperation(operation: SkillOperationNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const request = objectParams(operation.example_request);
  for (const binding of operation.provides) {
    if (binding.example_value != null && binding.example_value !== "") {
      out[binding.key] = binding.example_value;
      continue;
    }
    if (request[binding.key] != null && request[binding.key] !== "") {
      out[binding.key] = request[binding.key];
      continue;
    }
    const example = operation.example_response_compact;
    const direct = example ? findPrimitiveByKey(example, binding.key) : undefined;
    if (direct != null && direct !== "") {
      out[binding.key] = direct;
      continue;
    }
    if (binding.key.endsWith("_id") && example) {
      const fallback = findPrimitiveByKey(example, "id");
      if (fallback != null && fallback !== "") out[binding.key] = fallback;
    }
  }
  return out;
}

function findOperation(skill: SkillManifest, operationId: string): SkillOperationNode | undefined {
  const chunk = getSkillChunk(skill, { max_operations: skill.operation_graph?.operations.length ?? skill.endpoints.length });
  return chunk.operations.find((operation) => operation.operation_id === operationId);
}

function shortestDependencyPath(skill: SkillManifest, targetOperationId: string): string[] {
  const chunk = getSkillChunk(skill, { max_operations: skill.operation_graph?.operations.length ?? skill.endpoints.length });
  const entries = skill.operation_graph?.entry_operation_ids?.length
    ? skill.operation_graph.entry_operation_ids
    : chunk.operations
      .filter((operation) => operation.requires.length === 0 || operation.requires.every((binding) => !binding.required))
      .map((operation) => operation.operation_id);
  const queue = entries.map((operationId) => [operationId]);
  const seen = new Set(entries);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path[path.length - 1]!;
    if (current === targetOperationId) return path;
    for (const edge of chunk.edges) {
      if (edge.from_operation_id !== current) continue;
      if (seen.has(edge.to_operation_id)) continue;
      seen.add(edge.to_operation_id);
      queue.push([...path, edge.to_operation_id]);
    }
  }
  return [];
}

function canBuildCaseFromOperation(skill: SkillManifest, operation: SkillOperationNode): boolean {
  if ((operation.negative_tags ?? []).length > 0) return false;
  if (["fetch", "status"].includes(operation.action_kind)) return false;
  const request = objectParams(operation.example_request);
  return operation.requires.every((binding) => !binding.required || request[binding.key] != null || binding.example_value != null);
}

function buildCaseForOperation(skill: SkillManifest, operation: SkillOperationNode): LocalHarnessCase {
  const request = objectParams(operation.example_request);
  const chunk = getSkillChunk(skill, {
    intent: intentForOperation(operation),
    known_bindings: knownBindingsFromInputs(request, operation.trigger_url),
    max_operations: 8,
  });
  return {
    id: `${skill.skill_id}:${operation.operation_id}`,
    intent: intentForOperation(operation),
    params: request,
    contextUrl: operation.trigger_url,
    authenticated: operation.auth_required,
    expected_skill_id: skill.skill_id,
    expected_operation_id: operation.operation_id,
    expected_chunk_contains: collectNeighborIds(chunk, operation.operation_id),
  };
}

export function buildGeneratedCasesFromSkills(
  skills: SkillManifest[],
  opts?: { per_bucket?: number },
): GeneratedCaseSet {
  const perBucket = Math.max(1, opts?.per_bucket ?? 3);
  const publicSelections: LocalHarnessCase[] = [];
  const authSelections: LocalHarnessCase[] = [];
  const publicWalks: DependencyWalkCase[] = [];
  const authWalks: DependencyWalkCase[] = [];

  for (const skill of skills) {
    const chunk = getSkillChunk(skill, { max_operations: skill.operation_graph?.operations.length ?? skill.endpoints.length });
    for (const operation of chunk.operations) {
      if (!canBuildCaseFromOperation(skill, operation)) continue;
      const target = operation.auth_required ? authSelections : publicSelections;
      if (target.length >= perBucket) continue;
      target.push(buildCaseForOperation(skill, operation));
    }

    for (const operation of chunk.operations) {
      const path = shortestDependencyPath(skill, operation.operation_id);
      if (path.length < 2) continue;
      const pathOps = path.map((operationId) => chunk.operations.find((candidate) => candidate.operation_id === operationId)).filter(Boolean) as SkillOperationNode[];
      if (pathOps.length !== path.length) continue;
      const entry = pathOps[0]!;
      if (!canBuildCaseFromOperation(skill, entry)) continue;
      const target = operation.auth_required ? authWalks : publicWalks;
      if (target.length >= perBucket) continue;
      target.push({
        id: `${skill.skill_id}:walk:${operation.operation_id}`,
        skill_id: skill.skill_id,
        intent: intentForOperation(operation),
        authenticated: operation.auth_required,
        initial_params: objectParams(entry.example_request),
        contextUrl: entry.trigger_url,
        target_operation_id: operation.operation_id,
      });
    }

    for (const edge of chunk.edges) {
      const source = chunk.operations.find((operation) => operation.operation_id === edge.from_operation_id);
      const target = chunk.operations.find((operation) => operation.operation_id === edge.to_operation_id);
      if (!source || !target) continue;
      if (!canBuildCaseFromOperation(skill, source)) continue;
      const bucket = target.auth_required ? authWalks : publicWalks;
      if (bucket.length >= perBucket) continue;
      bucket.push({
        id: `${skill.skill_id}:edge:${target.operation_id}`,
        skill_id: skill.skill_id,
        intent: intentForOperation(target),
        authenticated: target.auth_required,
        initial_params: objectParams(source.example_request),
        contextUrl: source.trigger_url,
        target_operation_id: target.operation_id,
      });
    }
  }

  return {
    selection_cases: [...publicSelections, ...authSelections],
    walk_cases: [...publicWalks, ...authWalks],
  };
}

function scoreOperation(
  skill: SkillManifest,
  operation: SkillOperationNode,
  intent: string,
  params?: Record<string, unknown>,
  contextUrl?: string,
): number {
  const queryVec = toVector(queryText(intent, params, contextUrl));
  const opVec = toVector(operationText(skill, operation));
  const bindings = knownBindingsFromInputs(params ?? {}, contextUrl);
  let score = cosine(queryVec, opVec) * 100;

  const runnable = operation.requires.every((binding) => !binding.required || (bindings[binding.key] != null && bindings[binding.key] !== ""));
  if (runnable) score += 18;
  const satisfiedRequired = operation.requires.filter((binding) => binding.required && bindings[binding.key] != null && bindings[binding.key] !== "").length;
  if (satisfiedRequired > 0) score += satisfiedRequired * 14;

  const intentTokens = new Set(tokenize(intent).map(singularize));
  if (intentTokens.has(operation.action_kind)) score += 8;
  if (intentTokens.has(operation.resource_kind)) score += 12;

  const negativePenalty = (operation.negative_tags ?? []).reduce((sum, tag) => {
    if (intentTokens.has("status") && tag === "status") return sum;
    return sum + 12;
  }, 0);
  score -= negativePenalty;

  const requiresSatisfied = operation.requires.filter((binding) => binding.required).every((binding) => bindings[binding.key] != null && bindings[binding.key] !== "");
  if (operation.action_kind === "detail" && !requiresSatisfied) score -= 10;
  if (Object.keys(bindings).length > 0 && operation.requires.length === 0) {
    const redundantBootstrap = operation.provides.some((binding) => bindings[binding.key] != null && bindings[binding.key] !== "");
    if (redundantBootstrap) score -= 15;
  }
  score -= operationSoftPenalty(operation, intent);

  return score;
}

export function loadSkillsFromLocalCache(cacheDir = join(homedir(), ".unbrowse", "skill-cache")): SkillManifest[] {
  if (!existsSync(cacheDir)) return [];
  return readdirSync(cacheDir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      try {
        return [JSON.parse(readFileSync(join(cacheDir, file), "utf-8")) as SkillManifest];
      } catch {
        return [];
      }
    });
}

export function selectOperationsLocally(
  skills: SkillManifest[],
  intent: string,
  opts?: {
    params?: Record<string, unknown>;
    contextUrl?: string;
    topK?: number;
    domain?: string;
    authenticated?: boolean;
  },
): HarnessOperationHit[] {
  const scored: HarnessOperationHit[] = [];
  for (const skill of skills) {
    if (opts?.domain && skill.domain !== opts.domain) continue;
    const chunk = getSkillChunk(skill, {
      intent,
      known_bindings: knownBindingsFromInputs(opts?.params ?? {}, opts?.contextUrl),
      max_operations: 8,
    });
    const allowed = new Set(chunk.operations.map((operation) => operation.operation_id));
    for (const operation of chunk.operations) {
      if (!allowed.has(operation.operation_id)) continue;
      if (isOperationHardExcluded(operation, intent)) continue;
      const authRequired = operation.auth_required ?? false;
      if (authRequired && !opts?.authenticated) continue;
      const runnable = chunk.available_operation_ids.includes(operation.operation_id);
      scored.push({
        skill_id: skill.skill_id,
        skill_domain: skill.domain,
        operation_id: operation.operation_id,
        endpoint_id: operation.endpoint_id,
        score: scoreOperation(skill, operation, intent, opts?.params, opts?.contextUrl),
        runnable,
        action_kind: operation.action_kind,
        resource_kind: operation.resource_kind,
        negative_tags: operation.negative_tags ?? [],
        auth_required: authRequired,
      });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, opts?.topK ?? 5);
}

export function evaluateLocalHarness(
  skills: SkillManifest[],
  cases: LocalHarnessCase[],
): { summary: HarnessSummary; results: HarnessCaseResult[] } {
  const results: HarnessCaseResult[] = cases.map((testCase) => {
    const started = performance.now();
    const hits = selectOperationsLocally(skills, testCase.intent, {
      params: testCase.params,
      contextUrl: testCase.contextUrl,
      authenticated: testCase.authenticated,
      topK: 5,
    });
    const selectionMs = performance.now() - started;
    const selected = hits[0];
    const skill = skills.find((candidate) => candidate.skill_id === (selected?.skill_id ?? testCase.expected_skill_id))
      ?? skills.find((candidate) => candidate.skill_id === testCase.expected_skill_id)!;
    const chunk = getSkillChunk(skill, {
      intent: testCase.intent,
      known_bindings: knownBindingsFromInputs(testCase.params ?? {}, testCase.contextUrl),
      max_operations: 8,
    });

    const pass = !!selected &&
      selected.skill_id === testCase.expected_skill_id &&
      selected.operation_id === testCase.expected_operation_id &&
      (testCase.expected_chunk_contains ?? []).every((operationId) => chunk.operations.some((operation) => operation.operation_id === operationId));
    const expectedRank = hits.findIndex((hit) =>
      hit.skill_id === testCase.expected_skill_id && hit.operation_id === testCase.expected_operation_id);
    const wrongTop1BeforeCorrect = expectedRank >= 0 ? expectedRank : hits.length;

    return {
      id: testCase.id,
      pass,
      selected,
      top_hits: hits,
      chunk,
      expected_skill_id: testCase.expected_skill_id,
      expected_operation_id: testCase.expected_operation_id,
      selection_ms: selectionMs,
      expected_rank: expectedRank,
      wrong_top1_before_correct: wrongTop1BeforeCorrect,
      failure_reason: pass
        ? undefined
        : selected
          ? `selected ${selected.skill_id}:${selected.operation_id}`
          : "no_selection",
    };
  });

  const passed = results.filter((result) => result.pass).length;
  const runnableTop1 = results.filter((result) => result.selected?.runnable).length;
  const authResults = results.filter((result) => cases.find((testCase) => testCase.id === result.id)?.authenticated);
  const publicResults = results.filter((result) => !cases.find((testCase) => testCase.id === result.id)?.authenticated);
  const selectionTimings = results.map((result) => result.selection_ms);
  const correctnessTimings = results
    .filter((result) => result.expected_rank >= 0)
    .map((result) => result.selection_ms);
  return {
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      hit_rate: results.length > 0 ? passed / results.length : 0,
      runnable_top1_rate: results.length > 0 ? runnableTop1 / results.length : 0,
      public_total: publicResults.length,
      public_passed: publicResults.filter((result) => result.pass).length,
      auth_total: authResults.length,
      auth_passed: authResults.filter((result) => result.pass).length,
      avg_selection_ms: average(selectionTimings),
      avg_time_to_correct_ms: average(correctnessTimings),
      avg_wrong_top1_before_correct: average(results.map((result) => result.wrong_top1_before_correct)),
    },
    results,
  };
}

export function evaluateDependencyWalks(
  skills: SkillManifest[],
  cases: DependencyWalkCase[],
): { summary: DependencyWalkSummary; results: DependencyWalkResult[] } {
  const results = cases.map((testCase) => {
    const skill = skills.find((candidate) => candidate.skill_id === testCase.skill_id);
    if (!skill) {
      return {
        id: testCase.id,
        skill_id: testCase.skill_id,
        pass: false,
        target_operation_id: testCase.target_operation_id,
        selected_path: [],
        final_bindings: {},
        time_to_target_ms: 0,
        wrong_before_target: 0,
        failure_reason: "missing_skill",
      } satisfies DependencyWalkResult;
    }

    const selectedPath: string[] = [];
    const visited = new Set<string>();
    const bindings = knownBindingsFromInputs(testCase.initial_params ?? {}, testCase.contextUrl);
    const started = performance.now();
    let failureReason = "max_steps";

    for (let step = 0; step < 6; step++) {
      const hits = selectOperationsLocally([skill], testCase.intent, {
        params: bindings,
        contextUrl: testCase.contextUrl,
        authenticated: testCase.authenticated,
        topK: 6,
      });
      const next = hits.find((hit) => hit.runnable && !visited.has(hit.operation_id))
        ?? hits.find((hit) => !visited.has(hit.operation_id));
      if (!next) {
        failureReason = "no_candidate";
        break;
      }

      visited.add(next.operation_id);
      selectedPath.push(next.operation_id);
      const operation = findOperation(skill, next.operation_id);
      if (operation) Object.assign(bindings, bindingsFromOperation(operation));
      if (next.operation_id === testCase.target_operation_id) {
        failureReason = "";
        break;
      }
    }

    const timeToTargetMs = performance.now() - started;
    const pass = selectedPath[selectedPath.length - 1] === testCase.target_operation_id &&
      (!testCase.expected_path || testCase.expected_path.every((operationId, index) => selectedPath[index] === operationId));
    return {
      id: testCase.id,
      skill_id: testCase.skill_id,
      pass,
      target_operation_id: testCase.target_operation_id,
      selected_path: selectedPath,
      final_bindings: bindings,
      time_to_target_ms: timeToTargetMs,
      wrong_before_target: Math.max(0, selectedPath.length - 1),
      failure_reason: pass ? undefined : failureReason || "wrong_path",
    } satisfies DependencyWalkResult;
  });

  const passed = results.filter((result) => result.pass).length;
  return {
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      hit_rate: results.length > 0 ? passed / results.length : 0,
      avg_time_to_target_ms: average(results.map((result) => result.time_to_target_ms)),
      avg_wrong_before_target: average(results.map((result) => result.wrong_before_target)),
    },
    results,
  };
}

export function formatHarnessReport(summary: HarnessSummary, results: HarnessCaseResult[]): string {
  const lines = [
    `Local graph harness`,
    `total=${summary.total} passed=${summary.passed} failed=${summary.failed} hit_rate=${Math.round(summary.hit_rate * 100)}% runnable_top1=${Math.round(summary.runnable_top1_rate * 100)}% public=${summary.public_passed}/${summary.public_total} auth=${summary.auth_passed}/${summary.auth_total} avg_select_ms=${summary.avg_selection_ms.toFixed(2)} avg_correct_ms=${summary.avg_time_to_correct_ms.toFixed(2)} avg_wrong_before_correct=${summary.avg_wrong_top1_before_correct.toFixed(2)}`,
    "",
  ];
  for (const result of results) {
    const head = result.pass ? "PASS" : "FAIL";
    const selected = result.selected ? `${result.selected.skill_id}:${result.selected.operation_id}` : "none";
    lines.push(`${head} ${result.id} -> ${selected}`);
    if (!result.pass) {
      lines.push(`  expected ${result.expected_skill_id}:${result.expected_operation_id}`);
      lines.push(`  chunk ${unique(result.chunk.operations.map((operation) => operation.operation_id)).join(", ")}`);
    }
  }
  return lines.join("\n");
}

export function formatDependencyWalkReport(summary: DependencyWalkSummary, results: DependencyWalkResult[]): string {
  const lines = [
    `Dependency walk harness`,
    `total=${summary.total} passed=${summary.passed} failed=${summary.failed} hit_rate=${Math.round(summary.hit_rate * 100)}% avg_target_ms=${summary.avg_time_to_target_ms.toFixed(2)} avg_wrong_before_target=${summary.avg_wrong_before_target.toFixed(2)}`,
    "",
  ];
  for (const result of results) {
    const head = result.pass ? "PASS" : "FAIL";
    lines.push(`${head} ${result.id} -> ${result.selected_path.join(" -> ") || "none"}`);
    if (!result.pass) lines.push(`  target ${result.target_operation_id} reason=${result.failure_reason ?? "unknown"}`);
  }
  return lines.join("\n");
}
