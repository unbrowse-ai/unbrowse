#!/usr/bin/env bun
/**
 * Analyze closed P0/P1 issues from GitHub
 * Extracts bug/feature summaries and determines test approach
 * 
 * Usage: bun scripts/analyze-p0-p1-issues.ts [--repo owner/repo]
 */

interface GitHubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
  body: string;
}

interface IssueAnalysis {
  number: number;
  title: string;
  priority: "P0" | "P1";
  category: "unit_testable" | "cli_testable" | "integration_testable" | "not_testable";
  bug_feature: string;
  test_description: string;
  website_url?: string;
  labels: string[];
}

async function fetchGitHubIssues(
  owner: string,
  repo: string,
  priority: "p0" | "p1"
): Promise<GitHubIssue[]> {
  const queries = [
    `is:issue is:closed repo:${owner}/${repo} label:priority:${priority}`,
    `is:issue is:closed repo:${owner}/${repo} label:${priority}`,
  ];

  const issues: GitHubIssue[] = [];

  for (const query of queries) {
    try {
      const response = await fetch(
        `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=created&order=desc&per_page=100`,
        {
          headers: {
            Accept: "application/vnd.github.v3+json",
            ...(process.env.GITHUB_TOKEN && {
              Authorization: `token ${process.env.GITHUB_TOKEN}`,
            }),
          },
        }
      );

      if (!response.ok) {
        console.warn(
          `Warning: GitHub API returned ${response.status} for query: ${query}`
        );
        continue;
      }

      const data = (await response.json()) as { items: GitHubIssue[] };
      issues.push(...data.items);
    } catch (error) {
      console.error(`Error fetching issues for query ${query}:`, error);
    }
  }

  // Remove duplicates
  const seen = new Set<number>();
  return issues.filter((issue) => {
    if (seen.has(issue.number)) return false;
    seen.add(issue.number);
    return true;
  });
}

function extractUrlFromBody(body: string): string | undefined {
  // Extract common URL patterns
  const patterns = [
    /https?:\/\/(?!github\.com)[^\s]+/i,
    /Domain:\s*([\w\.\-]+)/i,
    /Website:\s*(https?:\/\/[^\s]+)/i,
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) {
      return match[1] || match[0];
    }
  }
  return undefined;
}

function classifyIssue(title: string, body: string): "unit_testable" | "cli_testable" | "integration_testable" | "not_testable" {
  const combinedText = (title + " " + body).toLowerCase();

  // Not testable: docs, marketing, epics, planning
  if (
    combinedText.includes("doc") ||
    combinedText.includes("whitepaper") ||
    combinedText.includes("marketing") ||
    combinedText.includes("roadmap") ||
    combinedText.includes("epic") ||
    combinedText.includes("parent issue") ||
    combinedText.includes("parent:")
  ) {
    return "not_testable";
  }

  // Unit testable: parsing, utils, schema, merging, validation
  if (
    combinedText.includes("merge") ||
    combinedText.includes("schema") ||
    combinedText.includes("path") ||
    combinedText.includes("parse") ||
    combinedText.includes("util") ||
    combinedText.includes("validation") ||
    combinedText.includes("dedupl")
  ) {
    return "unit_testable";
  }

  // CLI testable: resolve, execute, capture, resolve
  if (
    combinedText.includes("resolve") ||
    combinedText.includes("execute") ||
    combinedText.includes("capture") ||
    combinedText.includes("cli")
  ) {
    return "cli_testable";
  }

  // Integration testable: auth, browser, cookies, server
  if (
    combinedText.includes("auth") ||
    combinedText.includes("browser") ||
    combinedText.includes("cookie") ||
    combinedText.includes("login") ||
    combinedText.includes("server")
  ) {
    return "integration_testable";
  }

  return "cli_testable"; // default
}

function extractBugFeatureSummary(title: string, body: string): string {
  // Try to extract What happened / Expected sections
  const whatHappenedMatch = body.match(/## What happened\n([\s\S]*?)(?=##|$)/);
  if (whatHappenedMatch) {
    return whatHappenedMatch[1].trim().split("\n")[0];
  }

  const scopeMatch = body.match(/## Scope\n([\s\S]*?)(?=##|$)/);
  if (scopeMatch) {
    return scopeMatch[1].trim().split("\n")[0];
  }

  // Fallback to title
  return title.replace(/^(feat|fix|perf|refactor|chore|docs)(\(.+\))?:\s*/i, "").trim();
}

function generateTestDescription(
  number: number,
  title: string,
  category: string,
  body: string
): string {
  const titleClean = title.replace(/^(feat|fix|perf|refactor|chore|docs)(\(.+\))?:\s*/i, "");

  if (category === "unit_testable") {
    // Check what component is being tested
    if (title.includes("merge")) {
      return `Assert that merging endpoints with same path+method combines richer metadata without data loss (issue #${number})`;
    }
    if (title.includes("path")) {
      return `Assert that path template mining correctly extracts and deduplicates path variables from captured URLs (issue #${number})`;
    }
    if (title.includes("schema")) {
      return `Assert that schema merging preserves all properties without silently dropping fields (issue #${number})`;
    }
    return `Assert core logic correctly handles ${titleClean.toLowerCase()} (issue #${number})`;
  }

  if (category === "cli_testable") {
    return `Run \`unbrowse resolve --intent "..." --url "..." --force-capture\` and verify successful endpoint capture without errors (issue #${number})`;
  }

  if (category === "integration_testable") {
    if (title.includes("auth") || title.includes("cookie")) {
      return `Test CLI with auth-required site: verify correct cookie extraction, header injection, and authenticated request execution (issue #${number})`;
    }
    return `Test CLI against running server: verify correct network handling and state management (issue #${number})`;
  }

  return `Verify fix for: ${titleClean} (issue #${number})`;
}

async function analyzeIssue(issue: GitHubIssue, priority: "P0" | "P1"): Promise<IssueAnalysis> {
  const category = classifyIssue(issue.title, issue.body);
  const bugFeature = extractBugFeatureSummary(issue.title, issue.body);
  const testDescription = generateTestDescription(
    issue.number,
    issue.title,
    category,
    issue.body
  );
  const websiteUrl = extractUrlFromBody(issue.body);
  const labels = issue.labels
    .map((l) => l.name)
    .filter((name) => !name.startsWith("priority:"));

  return {
    number: issue.number,
    title: issue.title,
    priority,
    category,
    bug_feature: bugFeature,
    test_description: testDescription,
    website_url: websiteUrl,
    labels,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let repo = "unbrowse-ai/unbrowse-dev";

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo" && i + 1 < args.length) {
      repo = args[++i];
    }
  }

  console.log(`Analyzing closed P0/P1 issues from ${repo}...\n`);

  const [owner, repoName] = repo.split("/");

  // Fetch issues
  const p0Issues = await fetchGitHubIssues(owner, repoName, "p0");
  const p1Issues = await fetchGitHubIssues(owner, repoName, "p1");

  console.log(
    `Found ${p0Issues.length} P0 issues and ${p1Issues.length} P1 issues\n`
  );

  // Analyze all issues
  const analyses: IssueAnalysis[] = [];

  for (const issue of p0Issues) {
    analyses.push(await analyzeIssue(issue, "P0"));
  }

  for (const issue of p1Issues) {
    analyses.push(await analyzeIssue(issue, "P1"));
  }

  // Write to file
  const fs = await import("fs");
  const path = await import("path");

  const outputPath = "tests/p0-p1-analyses.json";
  fs.writeFileSync(outputPath, JSON.stringify(analyses, null, 2));
  console.log(`✅ Wrote ${analyses.length} issue analyses to ${outputPath}\n`);

  // Print summary by category
  console.log("Coverage by test category:");
  const byCat = new Map<string, number>();
  for (const a of analyses) {
    byCat.set(a.category, (byCat.get(a.category) || 0) + 1);
  }

  for (const [cat, count] of Array.from(byCat).sort()) {
    console.log(`  ${cat}: ${count}`);
  }

  // Print summary by priority
  console.log("\nCoverage by priority:");
  const p0count = analyses.filter((a) => a.priority === "P0").length;
  const p1count = analyses.filter((a) => a.priority === "P1").length;
  console.log(`  P0: ${p0count}`);
  console.log(`  P1: ${p1count}`);
}

main().catch(console.error);
