import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

/**
 * P0/P1 Issue Test Suite
 * 
 * This test suite validates closed p0/p1 issues by:
 * 1. Reading test cases from p0-p1-issues.json
 * 2. Running each through the unbrowse CLI
 * 3. Validating responses match expected output
 */

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

interface TestResult {
  issue: number;
  title: string;
  passed: boolean;
  error?: string;
  duration: number;
}

let testResults: TestResult[] = [];
const runP0P1Integration = process.env.UNBROWSE_RUN_P0_P1 === "1";
const suite = runP0P1Integration ? describe : describe.skip;
const UNBROWSE_CLI = path.join(
  process.cwd(),
  "src/cli.ts"
);

// Load test cases from JSON
function loadTestCases(): TestCase[] {
  const testCasePath = path.join(process.cwd(), "tests/p0-p1-issues.json");
  if (!fs.existsSync(testCasePath)) {
    console.warn("No test cases file found at", testCasePath);
    return [];
  }
  const content = fs.readFileSync(testCasePath, "utf-8");
  return JSON.parse(content);
}

function countResultEvidence(result: any): number {
  if (Array.isArray(result?.result)) return result.result.length;
  if (Array.isArray(result?.available_endpoints)) return result.available_endpoints.length;
  if (Array.isArray(result?.result?.data)) return result.result.data.length;
  if (result?.result && typeof result.result === "object" && !result.result.error) return 1;
  return 0;
}

// Run unbrowse CLI and validate output
async function runUnbrowseTest(
  testCase: TestCase
): Promise<{ passed: boolean; error?: string }> {
  return new Promise((resolve) => {
    const args = [
      "resolve",
      "--intent",
      testCase.intent,
      "--url",
      testCase.url,
      "--force-capture",
    ];

    const proc = spawn("bun", [UNBROWSE_CLI, ...args], {
      cwd: process.cwd(),
      timeout: 60000,
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
      if (code !== 0) {
        resolve({
          passed: false,
          error: `CLI exited with code ${code}: ${stderr}`,
        });
        return;
      }

      try {
        const result = JSON.parse(stdout);
        
        // Validate expected signals
        if (testCase.expectedSignals) {
          if (
            testCase.expectedSignals.minEndpoints &&
            countResultEvidence(result) < testCase.expectedSignals.minEndpoints
          ) {
            resolve({
              passed: false,
              error: `Expected at least ${testCase.expectedSignals.minEndpoints} result signal(s), got ${countResultEvidence(result)}`,
            });
            return;
          }

          if (testCase.expectedSignals.requiresAuth && !result.authRequired) {
            resolve({
              passed: false,
              error: "Expected auth requirement not detected",
            });
            return;
          }
        }

        resolve({ passed: true });
      } catch (e) {
        resolve({
          passed: false,
          error: `Failed to parse CLI output: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    });

    proc.on("error", (err) => {
      resolve({
        passed: false,
        error: `Process error: ${err.message}`,
      });
    });
  });
}

suite("P0/P1 Issue Validation Tests (integration)", () => {
  const testCases = loadTestCases();

  if (testCases.length === 0) {
    it("should have test cases defined", () => {
      console.warn(
        "Skipping tests - create tests/p0-p1-issues.json with test cases"
      );
      expect(true).toBe(true);
    });
    return;
  }

  beforeAll(() => {
    console.log(`\nRunning ${testCases.length} P0/P1 issue tests...\n`);
  });

  it("runs configured issue validations sequentially", async () => {
    for (const testCase of testCases) {
      const startTime = Date.now();
      const result = await runUnbrowseTest(testCase);
      const duration = Date.now() - startTime;

      testResults.push({
        issue: testCase.issueNumber,
        title: testCase.title,
        passed: result.passed,
        error: result.error,
        duration,
      });

      if (!result.passed) {
        console.error(`  ❌ #${testCase.issueNumber}: ${result.error}`);
      } else {
        console.log(`  ✅ #${testCase.issueNumber} (${duration}ms)`);
      }
    }

    const failedIssues = testResults
      .filter((result) => !result.passed)
      .map((result) => `#${result.issue}: ${result.error ?? "failed"}`);

    expect(failedIssues).toEqual([]);
  }, 180_000);

  afterAll(() => {
    const passed = testResults.filter((r) => r.passed).length;
    const total = testResults.length;
    const passRate = ((passed / total) * 100).toFixed(1);

    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed}/${total} passed (${passRate}%)`);
    console.log(`${"=".repeat(50)}\n`);

    // Write results to file for CI/tracking
    const resultsPath = path.join(
      process.cwd(),
      "evals/p0-p1-test-results.json"
    );
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    fs.writeFileSync(resultsPath, JSON.stringify(testResults, null, 2));
  });
});
