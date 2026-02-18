import { spawn } from "node:child_process";

export interface RunAgentBrowserOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface RunAgentBrowserResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function agentBrowserBin(): string {
  return (process.env.AGENT_BROWSER_BIN && process.env.AGENT_BROWSER_BIN.trim())
    ? process.env.AGENT_BROWSER_BIN.trim()
    : "agent-browser";
}

export async function runAgentBrowser(args: string[], opts: RunAgentBrowserOptions = {}): Promise<RunAgentBrowserResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(agentBrowserBin(), args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

export async function runAgentBrowserJson(args: string[], opts: RunAgentBrowserOptions = {}): Promise<any> {
  const res = await runAgentBrowser(args, opts);
  if (res.code !== 0) {
    const err = new Error(
      `[agent-browser] command failed (code=${res.code}): ${args.join(" ")}\n` +
      (res.stderr?.trim() ? res.stderr.trim() : res.stdout.trim()),
    );
    (err as any).stdout = res.stdout;
    (err as any).stderr = res.stderr;
    throw err;
  }
  const raw = res.stdout.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error(`[agent-browser] expected JSON output but got non-JSON stdout`);
    (err as any).stdout = res.stdout;
    (err as any).stderr = res.stderr;
    (err as any).parseError = e;
    throw err;
  }
}

