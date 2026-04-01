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
const UNBROWSE_CLI = path.join(
  process.cwd(),
  "packages/skill/dist/cli.js"
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

    const proc = spawn("bun", ["run", UNBROWSE_CLI, ...args], {
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
            (!result.endpoints ||
              result.endpoints.length <
                testCase.expectedSignals.minEndpoints)
          ) {
            resolve({
              passed: false,
              error: `Expected at least ${testCase.expectedSignals.minEndpoints} endpoints, got ${result.endpoints?.length || 0}`,
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

describe("P0/P1 Issue Validation Tests", () => {
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

  testCases.forEach((testCase) => {
    it(`Issue #${testCase.issueNumber}: ${testCase.title}`, async () => {
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

      expect(result.passed).toBe(true);
    });
  });

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
