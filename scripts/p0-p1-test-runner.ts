#!/usr/bin/env bun
/**
 * P0/P1 Regression Test Runner
 * Runs unit tests, CLI tests, and integration tests for closed issues
 * 
 * Usage: bun scripts/p0-p1-test-runner.ts [--category unit|cli|integration|all] [--priority P0|P1|all]
 */

import { spawn } from "child_process";
import path from "path";
import fs from "fs";

interface TestAnalysis {
  number: number;
  title: string;
  priority: "P0" | "P1";
  category: "unit_testable" | "cli_testable" | "integration_testable" | "not_testable";
  test_description: string;
  labels: string[];
}

interface TestResult {
  issueNumber: number;
  title: string;
  category: string;
  passed: boolean;
  error?: string;
  duration: number;
  timestamp: string;
}

async function loadAnalyses(): Promise<TestAnalysis[]> {
  const analysiePath = path.join(process.cwd(), "tests/p0-p1-analyses.json");
  if (!fs.existsSync(analysiePath)) {
    console.warn("No analysis file found. Run: bun scripts/analyze-p0-p1-issues.ts");
    return [];
  }
  const content = fs.readFileSync(analysiePath, "utf-8");
  return JSON.parse(content);
}

async function runUnitTests(issues: TestAnalysis[]): Promise<TestResult[]> {
  console.log(`\n📦 Running unit tests (${issues.length} issues)...\n`);

  const results: TestResult[] = [];
  const startTime = Date.now();

  return new Promise((resolve) => {
    const proc = spawn("bun", ["test", "tests/"], {
      cwd: process.cwd(),
      stdio: "inherit",
    });

    proc.on("close", (code) => {
      const duration = Date.now() - startTime;
      results.push({
        issueNumber: 0,
        title: "Unit tests",
        category: "unit_testable",
        passed: code === 0,
        error: code === 0 ? undefined : `Tests exited with code ${code}`,
        duration,
        timestamp: new Date().toISOString(),
      });
      resolve(results);
    });
  });
}

async function runCliTest(issue: TestAnalysis): Promise<TestResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();

    // For CLI tests, we run: bun scripts/build-kuri-binaries.mjs && bun src/cli.ts health
    const proc = spawn("bun", ["src/cli.ts", "health"], {
      cwd: process.cwd(),
      timeout: 30000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      const duration = Date.now() - startTime;
      resolve({
        issueNumber: issue.number,
        title: issue.title,
        category: "cli_testable",
        passed: code === 0,
        error: code === 0 ? undefined : `CLI exited with code ${code}: ${stderr}`,
        duration,
        timestamp: new Date().toISOString(),
      });
    });

    proc.on("error", (err) => {
      const duration = Date.now() - startTime;
      resolve({
        issueNumber: issue.number,
        title: issue.title,
        category: "cli_testable",
        passed: false,
        error: err.message,
        duration,
        timestamp: new Date().toISOString(),
      });
    });
  });
}

async function runCliTests(issues: TestAnalysis[]): Promise<TestResult[]> {
  console.log(`\n🖥️  Running CLI tests (${issues.length} issues)...\n`);

  const results: TestResult[] = [];

  for (const issue of issues) {
    console.log(`  Testing #${issue.number}: ${issue.title}...`);
    const result = await runCliTest(issue);
    results.push(result);

    if (result.passed) {
      console.log(`    ✅ Passed (${result.duration}ms)\n`);
    } else {
      console.log(`    ❌ Failed: ${result.error}\n`);
    }
  }

  return results;
}

function printIntegrationTestGuide(issues: TestAnalysis[]): TestResult[] {
  console.log(`\n🔌 Integration tests need manual setup (${issues.length} issues)\n`);
  console.log("These tests require running servers or auth setup:\n");

  for (const issue of issues) {
    console.log(`  #${issue.number}: ${issue.title}`);
    console.log(`     Category: ${issue.category}`);
    console.log(`     Test: ${issue.test_description}`);
    if (issue.labels.length > 0) {
      console.log(`     Labels: ${issue.labels.join(", ")}`);
    }
    console.log();
  }

  // Return placeholder results
  return issues.map((issue) => ({
    issueNumber: issue.number,
    title: issue.title,
    category: "integration_testable",
    passed: false,
    error: "Integration test not automated - requires manual setup",
    duration: 0,
    timestamp: new Date().toISOString(),
  }));
}

async function main() {
  const args = process.argv.slice(2);
  let categoryFilter: string | null = null;
  let priorityFilter: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--category" && i + 1 < args.length) {
      categoryFilter = args[++i];
    } else if (args[i] === "--priority" && i + 1 < args.length) {
      priorityFilter = args[++i];
    }
  }

  const analyses = await loadAnalyses();
  if (analyses.length === 0) {
    console.log("No analyses found. Generating...");
    spawn("bun", ["scripts/analyze-p0-p1-issues.ts"], {
      stdio: "inherit",
    });
    return;
  }

  // Filter by priority and category
  let testIssues = analyses;
  if (priorityFilter && priorityFilter !== "all") {
    testIssues = testIssues.filter((a) => a.priority === priorityFilter);
  }

  const allResults: TestResult[] = [];

  // Run tests by category
  if (!categoryFilter || categoryFilter === "all" || categoryFilter === "unit") {
    const unitIssues = testIssues.filter((a) => a.category === "unit_testable");
    if (unitIssues.length > 0) {
      allResults.push(...(await runUnitTests(unitIssues)));
    }
  }

  if (!categoryFilter || categoryFilter === "all" || categoryFilter === "cli") {
    const cliIssues = testIssues.filter((a) => a.category === "cli_testable");
    if (cliIssues.length > 0) {
      allResults.push(...(await runCliTests(cliIssues)));
    }
  }

  if (!categoryFilter || categoryFilter === "all" || categoryFilter === "integration") {
    const integrationIssues = testIssues.filter(
      (a) => a.category === "integration_testable"
    );
    if (integrationIssues.length > 0) {
      allResults.push(...printIntegrationTestGuide(integrationIssues));
    }
  }

  // Print summary
  const passed = allResults.filter((r) => r.passed).length;
  const total = allResults.length;
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(1) : "N/A";

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed}/${total} passed (${passRate}%)`);
  console.log(`${"=".repeat(50)}\n`);

  // Write results
  const resultsPath = path.join(process.cwd(), "evals/p0-p1-test-results.json");
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, JSON.stringify(allResults, null, 2));
}

main().catch(console.error);
