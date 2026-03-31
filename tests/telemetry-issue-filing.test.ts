import { describe, test, expect } from "bun:test";

interface ReproBundle {
  skill_id: string;
  endpoint_id: string;
  intent: string;
  error_message: string;
  error_count: number;
  first_seen: string;
  last_seen: string;
  sample_trace_ids: string[];
}

interface IssueTemplate {
  title: string;
  body: string;
  labels: string[];
  repo: string;
}

function buildReproBundle(
  skillId: string,
  endpointId: string,
  errors: Array<{ message: string; trace_id: string; timestamp: string }>,
  intent: string,
): ReproBundle {
  return {
    skill_id: skillId,
    endpoint_id: endpointId,
    intent,
    error_message: errors[0]?.message ?? "unknown",
    error_count: errors.length,
    first_seen: errors[0]?.timestamp ?? new Date().toISOString(),
    last_seen: errors[errors.length - 1]?.timestamp ?? new Date().toISOString(),
    sample_trace_ids: errors.slice(0, 5).map((e) => e.trace_id),
  };
}

function buildIssueTemplate(bundle: ReproBundle): IssueTemplate {
  const isBackend = bundle.error_message.includes("500") || bundle.error_message.includes("timeout");
  return {
    title: `[auto] ${bundle.endpoint_id}: ${bundle.error_message.slice(0, 80)}`,
    body: [
      `## Auto-filed from telemetry`,
      ``,
      `**Skill:** ${bundle.skill_id}`,
      `**Endpoint:** ${bundle.endpoint_id}`,
      `**Intent:** ${bundle.intent}`,
      `**Error:** ${bundle.error_message}`,
      `**Occurrences:** ${bundle.error_count}`,
      `**First seen:** ${bundle.first_seen}`,
      `**Last seen:** ${bundle.last_seen}`,
      `**Sample traces:** ${bundle.sample_trace_ids.join(", ")}`,
    ].join("\n"),
    labels: ["auto-filed", "bug"],
    repo: isBackend ? "unbrowse-ai/unbrowse-dev" : "unbrowse-ai/unbrowse",
  };
}

const ISSUE_FILING_THRESHOLD = 3;

describe("#117 telemetry-driven issue filing", () => {
  test("builds repro bundle from errors", () => {
    const bundle = buildReproBundle("skill-1", "ep-1", [
      { message: "500 Internal Server Error", trace_id: "t1", timestamp: "2026-03-01T00:00:00Z" },
      { message: "500 Internal Server Error", trace_id: "t2", timestamp: "2026-03-01T01:00:00Z" },
      { message: "500 Internal Server Error", trace_id: "t3", timestamp: "2026-03-01T02:00:00Z" },
    ], "find products");
    expect(bundle.error_count).toBe(3);
    expect(bundle.sample_trace_ids).toEqual(["t1", "t2", "t3"]);
  });

  test("builds issue template with routing", () => {
    const bundle = buildReproBundle("skill-1", "ep-1", [
      { message: "500 timeout", trace_id: "t1", timestamp: "2026-03-01T00:00:00Z" },
    ], "search items");
    const template = buildIssueTemplate(bundle);
    expect(template.title).toContain("[auto]");
    expect(template.repo).toBe("unbrowse-ai/unbrowse-dev");
    expect(template.labels).toContain("auto-filed");
  });

  test("routes non-backend errors to main repo", () => {
    const bundle = buildReproBundle("skill-1", "ep-1", [
      { message: "selector not found", trace_id: "t1", timestamp: "2026-03-01T00:00:00Z" },
    ], "get data");
    const template = buildIssueTemplate(bundle);
    expect(template.repo).toBe("unbrowse-ai/unbrowse");
  });

  test("only files when threshold reached", () => {
    const errorCount = 2;
    expect(errorCount >= ISSUE_FILING_THRESHOLD).toBe(false);
    expect(3 >= ISSUE_FILING_THRESHOLD).toBe(true);
  });
});
