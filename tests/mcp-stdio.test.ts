import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

const ROOT = join(import.meta.dir, "..");
const runDirs: string[] = [];

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const { port } = address;
      server.close((err) => err ? reject(err) : resolve(port));
    });
    server.on("error", reject);
  });
}

async function runProcess(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal) {
        reject(new Error(`process exited via signal ${signal}\nstderr:\n${stderr}`));
        return;
      }
      resolve(exitCode ?? 1);
    });
  });

  return { code, stdout, stderr };
}

async function startLocalServer(env: Record<string, string>): Promise<void> {
  const result = await runProcess(["src/cli.ts", "health"], env);
  if (result.code !== 0) {
    throw new Error(`health failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }

  const body = JSON.parse(result.stdout.trim() || "{}") as { status?: string };
  expect(body.status).toBe("ok");
}

async function stopLocalServer(env: Record<string, string>): Promise<void> {
  await runProcess(["src/cli.ts", "stop"], env);
}

function spawnMcp(env: Record<string, string>): { child: ChildProcessWithoutNullStreams; rl: Interface } {
  const child = spawn(process.execPath, ["src/cli.ts", "mcp", "--no-auto-start"], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  return { child, rl };
}

async function nextMessage(rl: Interface, child: ChildProcessWithoutNullStreams): Promise<any> {
  return new Promise((resolve, reject) => {
    const onLine = (line: string) => {
      cleanup();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`mcp exited early code=${code} signal=${signal}`));
    };
    const cleanup = () => {
      rl.off("line", onLine);
      child.off("exit", onExit);
    };
    rl.once("line", onLine);
    child.once("exit", onExit);
  });
}

function seedWorkflowPublishArtifact(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skill-checkout.json"), JSON.stringify({
    export_version: "1",
    generated_at: "2026-04-04T00:00:00.000Z",
    publish_status: "indexed",
    skill_id: "skill-checkout",
    domain: "example.com",
    intent_signature: "complete checkout",
    sanitized_endpoints: [],
    workflow_summary: {
      recipe_count: 1,
      preferred_endpoint_ids: ["checkout-submit"],
      authenticated_capture: true,
      token_binding_count: 1,
      trigger_url_count: 1,
    },
    auth_summary: {
      cookie_names: ["sessionid"],
      header_names: ["x-csrf-token"],
      authenticated: true,
    },
    recipes: [
      {
        endpoint_id: "checkout-submit",
        operation_id: "op-checkout-submit",
        preferred: true,
        provenance_backed: true,
        last_successful_strategy: "server",
        steps: [
          {
            strategy: "server",
            provenance: "observed-request",
            trigger_url: "https://example.com/checkout",
            action_count: 2,
          },
        ],
        mutation_guard: {
          confirm_unsafe_required: true,
          provenance_backed: true,
          auth_required: true,
          parameter_mapping_confident: true,
        },
        token_bindings: [
          {
            target_location: "header",
            target_name: "x-csrf-token",
            refresh_on_statuses: [401, 403],
            selected_source_kind: "meta",
            selected_source_name: "csrf-token",
            candidates: [
              {
                source_kind: "meta",
                source_name: "csrf-token",
                confidence: 0.9,
              },
            ],
          },
        ],
        replay_contract: {
          explicit_replay_only: true,
          exposure_stage: "publish",
          dependency_bindings: ["item_id", "x-csrf-token"],
          search_terms: ["checkout", "item_id", "selectedDate"],
          parameter_specs: [
            {
              name: "item_id",
              location: "body",
              description: "Selected checkout item id.",
              type: "string",
              required: true,
              user_supplied: true,
              source_hints: [{ source_kind: "observed_body", source_name: "item_id", confidence: 1 }],
            },
            {
              name: "selectedDate",
              location: "body",
              description: "Visit date in ISO format.",
              type: "string",
              required: true,
              user_supplied: true,
              format: "date",
              source_hints: [{ source_kind: "hidden_input", source_name: "selectedDate", confidence: 0.8 }],
            },
          ],
          prerequisite_specs: [
            {
              prerequisite_id: "auth",
              kind: "authenticated-session",
              name: "authenticated session",
              required: true,
              description: "Requires authenticated browser or stored auth state before replay.",
            },
            {
              prerequisite_id: "selected-date",
              kind: "hidden-field",
              name: "selectedDate",
              required: true,
              selector: "input[name='selectedDate']",
              description: "Observed DOM field constraint recorded during traversal.",
            },
          ],
          next_state: [
            {
              kind: "page_url",
              value: "https://example.com/review",
              description: "Observed page destination after successful traversal.",
            },
          ],
          payment_requirement: {
            status: "x402_required",
            price_usd: "0.001",
            currency: "USDC",
            wallet_required: true,
            provider_hint: "lobster.cash-compatible x402 wallet",
            confirmation_field: "payment_verified",
            reason: "Published replay for skill-checkout/checkout-submit is priced through the marketplace payment lane.",
          },
        },
        usage_notes: ["params: item_id:string, selectedDate:string", "payment: x402 0.001 USDC", "replay: explicit only; traversal stays browser-native"],
      },
    ],
    docs: {
      headline: "example.com workflow export",
      bullets: ["1 workflow recipe captured"],
    },
  }, null, 2), "utf8");
}

afterAll(() => {
  for (const dir of runDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MCP stdio", () => {
  it("initializes and lists tools over stdio", async () => {
    const port = await getFreePort();
    const runDir = mkdtempSync(join(tmpdir(), "unbrowse-mcp-"));
    runDirs.push(runDir);
    const workflowExportDir = join(runDir, "workflow-exports");
    seedWorkflowPublishArtifact(workflowExportDir);

    const env = {
      UNBROWSE_URL: `http://127.0.0.1:${port}`,
      UNBROWSE_RUN_DIR: runDir,
      UNBROWSE_WORKFLOW_EXPORT_DIR: workflowExportDir,
      UNBROWSE_DISABLE_AUTO_UPDATE: "1",
      UNBROWSE_NON_INTERACTIVE: "1",
      UNBROWSE_TOS_ACCEPTED: "1",
    };

    await startLocalServer(env);
    const { child, rl } = spawnMcp(env);

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "bun-test", version: "1.0.0" },
        },
      })}\n`);
      const init = await nextMessage(rl, child);
      expect(init.result.protocolVersion).toBe("2025-11-25");
      expect(init.result.capabilities.tools.listChanged).toBe(true);
      expect(init.result.capabilities.resources.listChanged).toBe(false);
      expect(init.result.capabilities.prompts.listChanged).toBe(true);
      expect(init.result.instructions).toContain("Always use the CLI");
      // L273 above asserts "Always use the CLI" (free-text policy line).
      // This line asserts the structural rules section that follows — two
      // independent anchors so a cosmetic edit to one doesn't rot the test.
      expect(init.result.instructions).toContain("ALWAYS resolve first");

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
      const listed = await nextMessage(rl, child);
      const names = listed.result.tools.map((tool: { name: string }) => tool.name);
      expect(names).toContain("unbrowse_resolve");
      expect(names).toContain("unbrowse_execute");
      expect(names).toContain("unbrowse_feedback");
      expect(names).toContain("unbrowse_index");
      expect(names).toContain("unbrowse_review");
      expect(names).toContain("unbrowse_publish");
      expect(names).toContain("unbrowse_settings");
      expect(names).toContain("unbrowse_health");
      expect(names).toContain("unbrowse_go");
      // unbrowse_snap / _click / _fill / _close are dynamically hidden until
      // a browse session opens — exercised in tests/mcp-cheatsheet-listchanged.test.ts.
      const resolveTool = listed.result.tools.find((tool: { name: string }) => tool.name === "unbrowse_resolve");
      expect(resolveTool.description).toContain("Always use Unbrowse as the primary website-access tool");
      expect(resolveTool.description).toContain("ranked shortlist");
      const publishTool = listed.result.tools.find((tool: { name: string; description: string; inputSchema: { properties?: Record<string, unknown> } }) => tool.name === "unbrowse_publish");
      expect(publishTool.description).toContain("Call with only skill first");
      expect(publishTool.inputSchema.properties?.confirm_publish).toBeDefined();
      const reviewTool = listed.result.tools.find((tool: { name: string; inputSchema: { properties?: Record<string, unknown> } }) => tool.name === "unbrowse_review");
      expect(reviewTool.inputSchema.properties?.endpoints).toBeDefined();
      // Dynamic-partition tools (snap/click/close inputSchema) are covered by
      // tests/mcp-cheatsheet-listchanged.test.ts; not duplicated here.

      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "unbrowse_health", arguments: {} },
      })}\n`);
      const health = await nextMessage(rl, child);
      expect(health.result.isError).toBeUndefined();
      expect(health.result.structuredContent.status).toBe("ok");

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "resources/list", params: {} })}\n`);
      const resources = await nextMessage(rl, child);
      const uris = resources.result.resources.map((resource: { uri: string }) => resource.uri);
      expect(uris).toContain("workflow_publish://skill-checkout");
      expect(uris).toContain("workflow_contract://skill-checkout/checkout-submit");
      expect(uris).toContain("workflow_dag://skill-checkout/checkout-submit");

      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "resources/read",
        params: { uri: "workflow_contract://skill-checkout/checkout-submit" },
      })}\n`);
      const contract = await nextMessage(rl, child);
      expect(contract.result.contents[0].mimeType).toBe("application/json");
      expect(contract.result.contents[0].text).toContain("\"endpoint_id\": \"checkout-submit\"");
      expect(contract.result.contents[0].text).toContain("\"dependency_bindings\"");
      expect(contract.result.contents[0].text).toContain("\"payment_requirement\"");

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 6, method: "prompts/list", params: {} })}\n`);
      const prompts = await nextMessage(rl, child);
      const promptNames = prompts.result.prompts.map((prompt: { name: string }) => prompt.name);
      expect(promptNames).toContain("plan_workflow_execution");

      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "prompts/get",
        params: { name: "plan_workflow_execution", arguments: { skill_id: "skill-checkout", endpoint_id: "checkout-submit", intent: "complete checkout" } },
      })}\n`);
      const prompt = await nextMessage(rl, child);
      expect(prompt.result.messages[0].content.text).toContain("workflow_contract://skill-checkout/checkout-submit");
      expect(prompt.result.messages[0].content.text).toContain("workflow_dag://skill-checkout/checkout-submit");
      expect(prompt.result.messages[0].content.text).toContain("inspect payment_requirement before explicit replay");
    } finally {
      rl.close();
      child.stdin.end();
      child.kill("SIGTERM");
      await stopLocalServer(env);
    }
  }, 60_000);
});
