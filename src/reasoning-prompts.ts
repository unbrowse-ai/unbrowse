/**
 * Reasoning Prompts — Generate structured reasoning content for the OpenClaw agent.
 *
 * Takes AgenticAnalysis + ApiData and produces a ReasoningLayer with confidence
 * scores, investigation prompts, action plans, knowledge gaps, and deep-dive
 * topics. All logic is deterministic — no LLM calls. The output is designed
 * to be consumed by an LLM agent for reasoning about API exploration strategy.
 */

import type { ApiData, EndpointGroup } from "./types.js";
import type {
  AgenticAnalysis,
  Entity,
  AuthFlow,
  DataFlow,
  EndpointSuggestion,
  ConfidenceScores as AgenticConfidenceScores,
} from "./agentic-analyzer.js";

// ── Exported Interfaces ──────────────────────────────────────────────────

/** Enriched confidence score with reasoning string (extends the numeric score from AgenticAnalysis). */
export interface ReasoningConfidenceScore {
  value: number;
  reasoning: string;
}

/** Enriched confidence scores — each dimension has a value plus a reasoning explanation. */
export interface ReasoningConfidenceScores {
  overall: ReasoningConfidenceScore;
  entities: ReasoningConfidenceScore;
  auth: ReasoningConfidenceScore;
  dataFlows: ReasoningConfidenceScore;
  coverage: ReasoningConfidenceScore;
}

export interface InvestigationPrompt {
  topic: string;
  priority: "high" | "medium" | "low";
  question: string;
  hypothesis: string;
  verification: string;
  suggestedAction?: { tool: string; params: Record<string, unknown> };
}

export interface ActionStep {
  priority: number;
  action: string;
  tool: string;
  params: Record<string, unknown>;
  expectedOutcome: string;
  reasoning: string;
}

export interface DeepDiveTopic {
  topic: string;
  focusKey: string;
  why: string;
  currentConfidence: number;
  expectedImprovement: string;
}

export interface ReasoningLayer {
  confidenceScores: ReasoningConfidenceScores;
  investigationPrompts: InvestigationPrompt[];
  actionPlan: ActionStep[];
  knowledgeGaps: string[];
  deepDiveTopics: DeepDiveTopic[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function endpointKey(group: EndpointGroup): string {
  return `${group.method} ${group.normalizedPath}`;
}

/** Count how many endpoint groups have at least N request samples. */
function countGroupsWithMinSamples(groups: EndpointGroup[], minSamples: number): number {
  return groups.filter(g => g.exampleCount >= minSamples).length;
}

/** Count how many endpoint groups have a non-empty response body schema. */
function countGroupsWithResponseBody(groups: EndpointGroup[]): number {
  return groups.filter(g => g.responseBodySchema && Object.keys(g.responseBodySchema).length > 0).length;
}

/** Find entities that are only seen in a single endpoint group. */
function findSingleSampleEntities(groups: EndpointGroup[]): EndpointGroup[] {
  return groups.filter(g => g.exampleCount === 1);
}

/** Find produced IDs that are never consumed by any endpoint. */
function findDisconnectedProducers(groups: EndpointGroup[]): { endpoint: string; field: string }[] {
  const allConsumed = new Set<string>();
  for (const g of groups) {
    for (const c of g.consumes) {
      allConsumed.add(c.toLowerCase());
    }
  }

  const disconnected: { endpoint: string; field: string }[] = [];
  for (const g of groups) {
    for (const p of g.produces) {
      if (!allConsumed.has(p.toLowerCase())) {
        disconnected.push({ endpoint: endpointKey(g), field: p });
      }
    }
  }
  return disconnected;
}

// ── Confidence Scoring ───────────────────────────────────────────────────

function scoreEntitiesConfidence(analysis: AgenticAnalysis, groups: EndpointGroup[]): ReasoningConfidenceScore {
  if (analysis.entities.length === 0) {
    return { value: 0, reasoning: "No entities detected — API traffic may be too sparse or non-RESTful." };
  }

  const reasons: string[] = [];
  let score = 0.5; // baseline

  // More unique fields observed across entities increases confidence
  const totalFields = analysis.entities.reduce((sum, e) => sum + e.fields.length, 0);
  const avgFields = totalFields / analysis.entities.length;
  if (avgFields >= 5) {
    score += 0.15;
    reasons.push(`rich schemas (avg ${avgFields.toFixed(1)} fields/entity)`);
  } else if (avgFields < 2) {
    score -= 0.15;
    reasons.push(`sparse schemas (avg ${avgFields.toFixed(1)} fields/entity)`);
  }

  // More endpoints per entity means more coverage
  const avgEndpoints = analysis.entities.reduce((sum, e) =>
    sum + e.readEndpoints.length + e.writeEndpoints.length + e.deleteEndpoints.length, 0,
  ) / analysis.entities.length;
  if (avgEndpoints >= 3) {
    score += 0.1;
    reasons.push(`good endpoint coverage (avg ${avgEndpoints.toFixed(1)}/entity)`);
  } else if (avgEndpoints < 1.5) {
    score -= 0.1;
    reasons.push(`limited endpoint coverage (avg ${avgEndpoints.toFixed(1)}/entity)`);
  }

  // Single-sample endpoints reduce confidence
  const singleSample = findSingleSampleEntities(groups);
  const singleRatio = groups.length > 0 ? singleSample.length / groups.length : 0;
  if (singleRatio > 0.5) {
    score -= 0.15;
    reasons.push(`${singleSample.length}/${groups.length} endpoints have only 1 sample`);
  } else if (singleRatio < 0.2) {
    score += 0.05;
    reasons.push("most endpoints have multiple request samples");
  }

  // CRUD completeness bonus
  const completeRatio = analysis.entities.filter(e => e.crudComplete).length / analysis.entities.length;
  if (completeRatio > 0.5) {
    score += 0.1;
    reasons.push(`${Math.round(completeRatio * 100)}% entities have complete CRUD`);
  }

  return {
    value: clamp(score, 0, 1),
    reasoning: reasons.length > 0 ? reasons.join("; ") : "Baseline entity confidence.",
  };
}

function scoreAuthConfidence(analysis: AgenticAnalysis, data: ApiData): ReasoningConfidenceScore {
  if (analysis.authFlows.length === 0 && data.authMethod === "none") {
    return { value: 0.5, reasoning: "No auth detected — API may be public or auth was not captured." };
  }

  if (analysis.authFlows.length === 0 && data.authMethod !== "none") {
    return {
      value: 0.3,
      reasoning: `Auth method "${data.authMethod}" detected from headers but no auth flow endpoint found in traffic.`,
    };
  }

  const reasons: string[] = [];
  let score = 0.5;

  const flow = analysis.authFlows[0];

  // Token production observed
  if (flow.producedTokens.length > 0) {
    score += 0.15;
    reasons.push(`token production observed (${flow.producedTokens.join(", ")})`);
  } else {
    score -= 0.1;
    reasons.push("no token fields detected in auth response");
  }

  // Token consumption observed
  if (flow.consumedBy.length > 0) {
    score += 0.15;
    reasons.push(`tokens consumed by ${flow.consumedBy.length} endpoints`);
  } else {
    score -= 0.1;
    reasons.push("no token consumption traced to other endpoints");
  }

  // Refresh endpoint detected
  if (flow.refreshEndpoint) {
    score += 0.1;
    reasons.push("refresh endpoint detected");
  } else {
    score -= 0.05;
    reasons.push("no refresh endpoint found");
  }

  // Input fields (login form completeness)
  if (flow.inputFields.length >= 2) {
    score += 0.05;
    reasons.push(`auth input fields: ${flow.inputFields.join(", ")}`);
  }

  return {
    value: clamp(score, 0, 1),
    reasoning: reasons.join("; "),
  };
}

function scoreDataFlowsConfidence(analysis: AgenticAnalysis, groups: EndpointGroup[]): ReasoningConfidenceScore {
  if (analysis.dataFlows.length === 0) {
    return { value: 0.2, reasoning: "No data flows traced — endpoints may be independent or IDs not captured." };
  }

  const reasons: string[] = [];
  let score = 0.5;

  // More flows = better understanding
  if (analysis.dataFlows.length >= 5) {
    score += 0.2;
    reasons.push(`${analysis.dataFlows.length} data flows traced`);
  } else if (analysis.dataFlows.length >= 2) {
    score += 0.1;
    reasons.push(`${analysis.dataFlows.length} data flows traced`);
  }

  // Explicit ID matches (path params) are higher confidence than fuzzy body matches
  const pathFlows = analysis.dataFlows.filter(f => f.consumerLocation === "path");
  const bodyFlows = analysis.dataFlows.filter(f => f.consumerLocation === "body");
  if (pathFlows.length > bodyFlows.length) {
    score += 0.1;
    reasons.push("most flows are explicit path-param connections");
  } else if (bodyFlows.length > pathFlows.length * 2) {
    score -= 0.05;
    reasons.push("many flows are fuzzy body-field matches (may be false positives)");
  }

  // Disconnected producers reduce confidence
  const disconnected = findDisconnectedProducers(groups);
  if (disconnected.length > 0) {
    score -= 0.1;
    reasons.push(`${disconnected.length} produced IDs never consumed (missing consumers?)`);
  }

  return {
    value: clamp(score, 0, 1),
    reasoning: reasons.join("; "),
  };
}

function scoreCoverageConfidence(groups: EndpointGroup[], data: ApiData): ReasoningConfidenceScore {
  if (groups.length === 0) {
    return { value: 0, reasoning: "No endpoint groups — no traffic to analyze." };
  }

  const reasons: string[] = [];
  let score = 0.5;

  // Response body coverage
  const withBody = countGroupsWithResponseBody(groups);
  const bodyRatio = withBody / groups.length;
  if (bodyRatio >= 0.8) {
    score += 0.15;
    reasons.push(`${Math.round(bodyRatio * 100)}% endpoints have response schemas`);
  } else if (bodyRatio < 0.4) {
    score -= 0.15;
    reasons.push(`only ${Math.round(bodyRatio * 100)}% endpoints have response schemas`);
  }

  // Multi-sample coverage
  const multiSample = countGroupsWithMinSamples(groups, 2);
  const multiRatio = multiSample / groups.length;
  if (multiRatio >= 0.5) {
    score += 0.15;
    reasons.push(`${Math.round(multiRatio * 100)}% endpoints have 2+ samples`);
  } else if (multiRatio < 0.2) {
    score -= 0.1;
    reasons.push(`only ${Math.round(multiRatio * 100)}% endpoints have multiple samples`);
  }

  // Total request volume
  const totalRequests = data.requests.length;
  if (totalRequests >= 50) {
    score += 0.1;
    reasons.push(`${totalRequests} total requests captured (good volume)`);
  } else if (totalRequests < 10) {
    score -= 0.15;
    reasons.push(`only ${totalRequests} total requests captured (sparse)`);
  }

  // Spec-sourced endpoints are reliable
  const specSourced = groups.filter(g => g.fromSpec).length;
  if (specSourced > 0) {
    score += 0.1;
    reasons.push(`${specSourced} endpoints sourced from OpenAPI spec`);
  }

  return {
    value: clamp(score, 0, 1),
    reasoning: reasons.join("; "),
  };
}

function computeConfidenceScores(analysis: AgenticAnalysis, data: ApiData): ReasoningConfidenceScores {
  const groups = data.endpointGroups ?? [];

  const entities = scoreEntitiesConfidence(analysis, groups);
  const auth = scoreAuthConfidence(analysis, data);
  const dataFlows = scoreDataFlowsConfidence(analysis, groups);
  const coverage = scoreCoverageConfidence(groups, data);

  // Weighted average: entities 30%, auth 25%, dataFlows 25%, coverage 20%
  const overallValue = clamp(
    entities.value * 0.3 + auth.value * 0.25 + dataFlows.value * 0.25 + coverage.value * 0.2,
    0, 1,
  );

  const overallReasons: string[] = [];
  if (overallValue >= 0.7) {
    overallReasons.push("High overall confidence — rich traffic data with good coverage.");
  } else if (overallValue >= 0.4) {
    overallReasons.push("Moderate confidence — some gaps in captured traffic.");
  } else {
    overallReasons.push("Low confidence — limited traffic data. More captures recommended.");
  }

  // Call out the weakest area
  const scores = { entities: entities.value, auth: auth.value, dataFlows: dataFlows.value, coverage: coverage.value };
  const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];
  if (weakest[1] < 0.4) {
    overallReasons.push(`Weakest area: ${weakest[0]} (${(weakest[1] * 100).toFixed(0)}%).`);
  }

  return {
    overall: { value: overallValue, reasoning: overallReasons.join(" ") },
    entities,
    auth,
    dataFlows,
    coverage,
  };
}

// ── Investigation Prompts ────────────────────────────────────────────────

function generateInvestigationPrompts(
  analysis: AgenticAnalysis,
  data: ApiData,
): InvestigationPrompt[] {
  const prompts: InvestigationPrompt[] = [];
  const groups = data.endpointGroups ?? [];

  // Incomplete CRUD entities
  for (const entity of analysis.entities) {
    if (entity.crudComplete) continue;
    for (const missingOp of entity.missingOps) {
      prompts.push({
        topic: "Entity CRUD gaps",
        priority: "high",
        question: `Does ${entity.name} support ${missingOp}? No ${missingOp} endpoint was captured in traffic.`,
        hypothesis: missingOp === "delete"
          ? `${entity.name} may use soft-delete via PATCH with a status/deleted field, or deletion may not be exposed in the API.`
          : `The ${missingOp} endpoint for ${entity.name} likely exists but was not exercised during capture.`,
        verification: `Probe for the standard ${missingOp} endpoint pattern on the ${entity.name} resource path.`,
        suggestedAction: missingOp === "delete"
          ? { tool: "unbrowse_probe", params: { focus: "crud", entity: entity.name } }
          : { tool: "unbrowse_probe", params: { focus: "crud", entity: entity.name } },
      });
    }
  }

  // Missing auth refresh
  for (const flow of analysis.authFlows) {
    if (!flow.refreshEndpoint) {
      prompts.push({
        topic: "Auth token lifecycle",
        priority: "high",
        question: `No refresh endpoint detected for auth flow at ${flow.endpoint}. How are tokens renewed?`,
        hypothesis: "Could be: long-lived tokens, implicit refresh via cookies, sliding window session, or refresh endpoint not captured.",
        verification: "Check token expiry fields in auth response. Probe for /refresh, /token/refresh, or /auth/renew endpoints.",
        suggestedAction: { tool: "unbrowse_probe", params: { focus: "auth" } },
      });
    }
  }

  // Single-sample endpoints
  const singleSample = findSingleSampleEntities(groups);
  if (singleSample.length > 0) {
    const examples = singleSample.slice(0, 3).map(g => endpointKey(g));
    prompts.push({
      topic: "Single-sample endpoints",
      priority: "medium",
      question: `${singleSample.length} endpoint(s) have only 1 captured request (e.g., ${examples.join(", ")}). Response schemas may be incomplete.`,
      hypothesis: "Single samples may miss nullable fields, array variations, or error responses. Schema inference is less reliable.",
      verification: "Capture more traffic for these endpoints or probe with different parameters to see response variations.",
      suggestedAction: { tool: "unbrowse_capture", params: { targetEndpoints: examples } },
    });
  }

  // Disconnected data flows (produced IDs never consumed)
  const disconnected = findDisconnectedProducers(groups);
  if (disconnected.length > 0) {
    const examples = disconnected.slice(0, 3);
    for (const d of examples) {
      prompts.push({
        topic: "Disconnected data flows",
        priority: "medium",
        question: `"${d.field}" is produced by ${d.endpoint} but never consumed by any captured endpoint.`,
        hypothesis: "Likely consumed by endpoints not yet captured, or used by a different service/frontend.",
        verification: "Search for other endpoints that accept this ID as a path param, query param, or body field.",
        suggestedAction: { tool: "unbrowse_probe", params: { focus: "data-flow", field: d.field } },
      });
    }
  }

  // Low-confidence path parameter detection
  for (const group of groups) {
    for (const pp of group.pathParams) {
      if (pp.type === "unknown" || pp.type === "slug") {
        prompts.push({
          topic: "Ambiguous path parameters",
          priority: "low",
          question: `Path parameter detection uncertain for ${group.normalizedPath} — segment "${pp.example}" classified as "${pp.type}".`,
          hypothesis: `Could be: a dynamic ID, a slug, or a fixed path segment. Type "${pp.type}" is ambiguous.`,
          verification: "Try the endpoint with a different value in this position to see if it still returns valid data.",
          suggestedAction: { tool: "unbrowse_probe", params: { endpoint: group.normalizedPath, testParam: pp.name } },
        });
      }
    }
  }

  // Pagination without known page size
  for (const p of analysis.pagination) {
    if (p.type !== "unknown" && Object.keys(p.examples).length === 0) {
      prompts.push({
        topic: "Pagination details unknown",
        priority: "low",
        question: `Pagination detected on ${p.endpoint} (${p.type}) but no example values captured for params.`,
        hypothesis: "Default page size and total count are unknown. Multiple pages need to be fetched to determine behavior.",
        verification: "Fetch the endpoint with explicit pagination params (e.g., page=1&per_page=10) and compare.",
      });
    }
  }

  // Error patterns without example messages
  for (const err of analysis.errors) {
    if (!err.example && err.fields.length === 0) {
      prompts.push({
        topic: "Opaque error responses",
        priority: "low",
        question: `HTTP ${err.status} responses from ${err.endpoints.slice(0, 2).join(", ")} have unknown error body structure.`,
        hypothesis: "Error response may be HTML, plain text, or empty body rather than structured JSON.",
        verification: "Trigger a controlled error (e.g., invalid ID) and inspect the raw response.",
      });
    }
  }

  return prompts;
}

// ── Action Plan ──────────────────────────────────────────────────────────

function generateActionPlan(
  analysis: AgenticAnalysis,
  data: ApiData,
  confidenceScores: ReasoningConfidenceScores,
): ActionStep[] {
  const steps: ActionStep[] = [];
  let priority = 1;

  // If low overall confidence, recommend capturing more traffic first
  if (confidenceScores.overall.value < 0.35) {
    steps.push({
      priority: priority++,
      action: "Capture more API traffic to improve analysis confidence",
      tool: "unbrowse_capture",
      params: { duration: 60 },
      expectedOutcome: "More request/response pairs for richer schema inference and entity detection.",
      reasoning: `Overall confidence is only ${(confidenceScores.overall.value * 100).toFixed(0)}% — more data is the highest-impact action.`,
    });
  }

  // If auth flow unclear, analyze deeper with focus on auth
  if (confidenceScores.auth.value < 0.4 && data.authMethod !== "none") {
    steps.push({
      priority: priority++,
      action: "Deep-analyze authentication flow",
      tool: "unbrowse_analyze",
      params: { focus: "auth" },
      expectedOutcome: "Clearer picture of token lifecycle, refresh mechanism, and session management.",
      reasoning: `Auth confidence is ${(confidenceScores.auth.value * 100).toFixed(0)}% — need to understand token flow before making authenticated requests.`,
    });
  }

  // If CRUD gaps exist, probe for missing endpoints
  const incompleteEntities = analysis.entities.filter(e => !e.crudComplete);
  if (incompleteEntities.length > 0) {
    const entityNames = incompleteEntities.slice(0, 3).map(e => e.name);
    steps.push({
      priority: priority++,
      action: `Probe for missing CRUD operations on ${entityNames.join(", ")}`,
      tool: "unbrowse_probe",
      params: { focus: "crud", entities: entityNames },
      expectedOutcome: `Discover missing ${incompleteEntities.flatMap(e => e.missingOps).slice(0, 4).join(", ")} endpoints.`,
      reasoning: `${incompleteEntities.length} entities have incomplete CRUD — probing may reveal undocumented endpoints.`,
    });
  }

  // If there are high-confidence suggestions, probe them
  const highConfSuggestions = analysis.suggestions.filter(s => s.confidence === "high");
  if (highConfSuggestions.length > 0) {
    const targets = highConfSuggestions.slice(0, 5).map(s => `${s.method} ${s.path}`);
    steps.push({
      priority: priority++,
      action: `Probe ${highConfSuggestions.length} likely undiscovered endpoints`,
      tool: "unbrowse_probe",
      params: { endpoints: targets },
      expectedOutcome: "Confirm or rule out predicted endpoints, expanding API surface knowledge.",
      reasoning: `${highConfSuggestions.length} high-confidence endpoint suggestions from CRUD gap analysis.`,
    });
  }

  // If medium-confidence suggestions exist, probe with lower priority
  const medConfSuggestions = analysis.suggestions.filter(s => s.confidence === "medium");
  if (medConfSuggestions.length > 0) {
    const targets = medConfSuggestions.slice(0, 5).map(s => `${s.method} ${s.path}`);
    steps.push({
      priority: priority++,
      action: `Probe ${medConfSuggestions.length} possible endpoints`,
      tool: "unbrowse_probe",
      params: { endpoints: targets },
      expectedOutcome: "Discover additional API surface beyond what was captured in traffic.",
      reasoning: `${medConfSuggestions.length} medium-confidence suggestions worth checking.`,
    });
  }

  // If data flow confidence is low, recommend targeted analysis
  if (confidenceScores.dataFlows.value < 0.4) {
    steps.push({
      priority: priority++,
      action: "Re-analyze with focus on data flow tracing",
      tool: "unbrowse_analyze",
      params: { focus: "data-flows" },
      expectedOutcome: "Better understanding of how IDs and tokens flow between endpoints.",
      reasoning: `Data flow confidence is ${(confidenceScores.dataFlows.value * 100).toFixed(0)}% — relationships between endpoints are unclear.`,
    });
  }

  // If no HAR data and low coverage, recommend live interception
  const groups = data.endpointGroups ?? [];
  const specSourced = groups.filter(g => g.fromSpec).length;
  if (specSourced > groups.length * 0.5 && groups.length > 0) {
    steps.push({
      priority: priority++,
      action: "Set up live traffic interception to capture real request/response pairs",
      tool: "unbrowse_intercept",
      params: { mode: "capture" },
      expectedOutcome: "Real traffic data to supplement spec-sourced endpoint definitions.",
      reasoning: `${specSourced}/${groups.length} endpoints are from OpenAPI spec only — real traffic will improve schema accuracy.`,
    });
  }

  // Always suggest re-generating the skill as a final step
  if (steps.length > 0) {
    steps.push({
      priority: priority++,
      action: "Re-generate skill file with enriched data",
      tool: "unbrowse_generate",
      params: { service: data.service },
      expectedOutcome: "Updated skill with richer endpoint documentation and type information.",
      reasoning: "After probing and capturing, regenerate to incorporate new findings.",
    });
  }

  return steps;
}

// ── Knowledge Gaps ───────────────────────────────────────────────────────

function identifyKnowledgeGaps(
  analysis: AgenticAnalysis,
  data: ApiData,
): string[] {
  const gaps: string[] = [];
  const groups = data.endpointGroups ?? [];

  // Webhook / outbound patterns
  gaps.push(
    "Cannot determine if API uses webhook callbacks (no outbound request patterns in traffic).",
  );

  // Rate limits
  if (analysis.rateLimits.length === 0) {
    gaps.push(
      "Rate limits may exist but no rate-limit headers observed — could be IP-based, account-based, or hidden.",
    );
  } else {
    for (const rl of analysis.rateLimits) {
      if (rl.limit === undefined) {
        gaps.push(
          `Rate limit headers present for ${rl.scope} but actual limit value not parsed.`,
        );
      }
      if (rl.windowSeconds === undefined) {
        gaps.push(
          `Rate limit window unknown for ${rl.scope} — reset timing not captured.`,
        );
      }
    }
  }

  // Pagination page sizes
  for (const p of analysis.pagination) {
    if (Object.keys(p.examples).length <= 1) {
      gaps.push(
        `Response pagination detected on ${p.endpoint} but actual page size unknown (need multiple pages).`,
      );
    }
  }

  // Auth token expiry
  for (const flow of analysis.authFlows) {
    if (flow.producedTokens.length > 0 && !flow.refreshEndpoint) {
      gaps.push(
        "Auth token expiry unknown — observed tokens may be expired. No refresh endpoint detected.",
      );
      break; // One gap message is enough
    }
  }

  // Error response coverage
  const errorStatuses = new Set(analysis.errors.map(e => e.status));
  const commonErrorStatuses = [400, 401, 403, 404, 422, 429, 500];
  const missingErrors = commonErrorStatuses.filter(s => !errorStatuses.has(s));
  if (missingErrors.length > 3) {
    gaps.push(
      `Error responses for HTTP ${missingErrors.join(", ")} not observed — error handling patterns may be incomplete.`,
    );
  }

  // Content types
  const contentTypes = new Set<string>();
  for (const req of data.requests) {
    if (req.responseContentType) contentTypes.add(req.responseContentType.split(";")[0].trim());
  }
  if (contentTypes.size === 0) {
    gaps.push("No response content-type headers captured — cannot verify JSON vs XML vs other formats.");
  }

  // Versioning uncertainty
  if (!analysis.versioning) {
    gaps.push(
      "No API versioning detected — could be unversioned, or versioning may use a method not in captured traffic (e.g., Accept header).",
    );
  }

  // GraphQL schema
  if (analysis.apiStyle === "graphql") {
    gaps.push(
      "GraphQL API detected but full schema unknown — introspection query not captured. Available queries/mutations may be much broader.",
    );
  }

  // Endpoints with no response body
  const noBody = groups.filter(g => !g.responseBodySchema || Object.keys(g.responseBodySchema).length === 0);
  if (noBody.length > 0 && noBody.length <= groups.length * 0.5) {
    gaps.push(
      `${noBody.length} endpoint(s) have no captured response body — may return data not observed in traffic.`,
    );
  }

  return gaps;
}

// ── Deep Dive Topics ─────────────────────────────────────────────────────

function generateDeepDiveTopics(
  analysis: AgenticAnalysis,
  confidenceScores: ReasoningConfidenceScores,
): DeepDiveTopic[] {
  const topics: DeepDiveTopic[] = [];

  // Auth deep dive
  if (confidenceScores.auth.value < 0.6) {
    topics.push({
      topic: "Authentication & Authorization",
      focusKey: "auth",
      why: confidenceScores.auth.reasoning,
      currentConfidence: confidenceScores.auth.value,
      expectedImprovement: "Clarify token lifecycle, refresh mechanism, and scope/permission model.",
    });
  }

  // Entity relationship deep dive
  if (confidenceScores.entities.value < 0.6) {
    topics.push({
      topic: "Domain Entity Relationships",
      focusKey: "entities",
      why: confidenceScores.entities.reasoning,
      currentConfidence: confidenceScores.entities.value,
      expectedImprovement: "Better entity field maps, relationship detection, and CRUD gap filling.",
    });
  }

  // Data flow deep dive
  if (confidenceScores.dataFlows.value < 0.5) {
    topics.push({
      topic: "Inter-endpoint Data Flows",
      focusKey: "data-flows",
      why: confidenceScores.dataFlows.reasoning,
      currentConfidence: confidenceScores.dataFlows.value,
      expectedImprovement: "Map how IDs and tokens flow between endpoints for proper sequencing.",
    });
  }

  // Pagination deep dive (if multiple patterns detected)
  if (analysis.pagination.length > 0) {
    const unknownPagination = analysis.pagination.filter(p => p.type === "unknown");
    if (unknownPagination.length > 0) {
      topics.push({
        topic: "Pagination Mechanics",
        focusKey: "pagination",
        why: `${unknownPagination.length} endpoints have unclassified pagination patterns.`,
        currentConfidence: 0.3,
        expectedImprovement: "Determine pagination type, page sizes, and total-count availability.",
      });
    }
  }

  // Error handling deep dive
  if (analysis.errors.length > 0) {
    const opaqueErrors = analysis.errors.filter(e => e.fields.length === 0);
    if (opaqueErrors.length > 0) {
      topics.push({
        topic: "Error Response Patterns",
        focusKey: "errors",
        why: `${opaqueErrors.length} error status codes have no structured error body detected.`,
        currentConfidence: 0.3,
        expectedImprovement: "Understand error response shapes for proper error handling in generated skill.",
      });
    }
  }

  // Coverage deep dive if many endpoints lack body schemas
  if (confidenceScores.coverage.value < 0.5) {
    topics.push({
      topic: "Endpoint Coverage",
      focusKey: "coverage",
      why: confidenceScores.coverage.reasoning,
      currentConfidence: confidenceScores.coverage.value,
      expectedImprovement: "Fill in missing response schemas and capture more request variations.",
    });
  }

  return topics;
}

// ── Main Export ───────────────────────────────────────────────────────────

/**
 * Generate a structured reasoning layer from agentic analysis and API data.
 *
 * The output provides confidence scores, investigation prompts, an action plan,
 * knowledge gaps, and deep-dive topics — all deterministic, designed for an LLM
 * agent to reason about API exploration strategy.
 *
 * @param analysis - Output from analyzeTraffic()
 * @param data - Enriched API data (with endpointGroups)
 * @returns Complete reasoning layer for agent consumption
 */
export function generateReasoningLayer(
  analysis: AgenticAnalysis,
  data: ApiData,
): ReasoningLayer {
  const confidenceScores = computeConfidenceScores(analysis, data);
  const investigationPrompts = generateInvestigationPrompts(analysis, data);
  const actionPlan = generateActionPlan(analysis, data, confidenceScores);
  const knowledgeGaps = identifyKnowledgeGaps(analysis, data);
  const deepDiveTopics = generateDeepDiveTopics(analysis, confidenceScores);

  return {
    confidenceScores,
    investigationPrompts,
    actionPlan,
    knowledgeGaps,
    deepDiveTopics,
  };
}
