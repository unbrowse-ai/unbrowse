#!/usr/bin/env bun
/**
 * Fetch closed P0/P1 issues from GitHub and generate test cases
 * 
 * Usage: bun scripts/fetch-p0-p1-issues.ts [--repo owner/repo] [--output path]
 */

import { parse } from "node:path";

interface GitHubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: Array<{ name: string }>;
  html_url: string;
  body: string;
}

interface TestCase {
  issueNumber: number;
  title: string;
  url: string;
  intent: string;
  expectedSignals?: {
    minEndpoints?: number;
    requiresAuth?: boolean;
    tags?: string[];
  };
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

function generateTestCase(issue: GitHubIssue): TestCase {
  // Extract intent from issue title or body
  const titleLower = issue.title.toLowerCase();
  const bodyLower = issue.body.toLowerCase();

  let intent = "test issue";
  if (titleLower.includes("endpoint"))
    intent = "test endpoint handling";
  else if (titleLower.includes("search"))
    intent = "test search functionality";
  else if (titleLower.includes("auth"))
    intent = "test authentication";
  else if (titleLower.includes("path"))
    intent = "test path handling";
  else if (titleLower.includes("capture"))
    intent = "test capture functionality";

  // Extract tags from labels
  const tags = issue.labels
    .map((l) => l.name)
    .filter((name) => !name.startsWith("priority:"));

  // Estimate expected signals
  const expectedSignals: TestCase["expectedSignals"] = {
    minEndpoints: 1,
    requiresAuth: titleLower.includes("auth") || bodyLower.includes("auth"),
    tags: tags.length > 0 ? tags : undefined,
  };

  return {
    issueNumber: issue.number,
    title: issue.title,
    url: issue.html_url,
    intent,
    expectedSignals,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let repo = "unbrowse-ai/unbrowse-dev";
  let outputPath = "tests/p0-p1-issues.json";

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo" && i + 1 < args.length) {
      repo = args[++i];
    } else if (args[i] === "--output" && i + 1 < args.length) {
      outputPath = args[++i];
    }
  }

  console.log(`Fetching closed P0/P1 issues from ${repo}...`);

  const [owner, repoName] = repo.split("/");

  // Fetch issues
  const p0Issues = await fetchGitHubIssues(owner, repoName, "p0");
  const p1Issues = await fetchGitHubIssues(owner, repoName, "p1");

  const allIssues = [...p0Issues, ...p1Issues];
  console.log(
    `Found ${p0Issues.length} P0 issues and ${p1Issues.length} P1 issues`
  );

  if (allIssues.length === 0) {
    console.warn("No closed P0/P1 issues found");
    return;
  }

  // Generate test cases
  const testCases = allIssues.map(generateTestCase);

  // Write to file
  const fs = await import("fs");
  const path = await import("path");

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(testCases, null, 2));
  console.log(`Generated ${testCases.length} test cases in ${outputPath}`);

  // Print summary
  console.log("\nTest cases by type:");
  const byIntentPrefix = new Map<string, number>();
  for (const tc of testCases) {
    const prefix = tc.intent.split(" ")[1] || "other";
    byIntentPrefix.set(prefix, (byIntentPrefix.get(prefix) || 0) + 1);
  }

  for (const [type, count] of byIntentPrefix) {
    console.log(`  - ${type}: ${count} cases`);
  }
}

main().catch(console.error);
