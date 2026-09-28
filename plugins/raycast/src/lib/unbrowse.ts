export const MCP_ENDPOINT = "https://unbrowse.ai/api/mcp";

export class UnbrowseError extends Error {}

type Fetch = typeof fetch;

interface ToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

interface JsonRpcResponse {
  result?: ToolResult;
  error?: { code: number; message: string };
}

/** Calls one Unbrowse tool over plain HTTP JSON-RPC and returns the parsed JSON it answers with. */
export async function callTool<T>(
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; fetchImpl?: Fetch } = {},
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(MCP_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: options.signal,
  });

  if (response.status === 401 || response.status === 403) {
    throw new UnbrowseError("Unbrowse rejected the API key. Check it in the extension preferences.");
  }
  if (response.status === 402) {
    throw new UnbrowseError("Out of Unbrowse credits. Top up at unbrowse.ai/app.");
  }
  if (!response.ok) {
    throw new UnbrowseError(`Unbrowse answered HTTP ${response.status}.`);
  }

  const body = (await response.json()) as JsonRpcResponse;
  if (body.error) {
    throw new UnbrowseError(body.error.message);
  }
  const text = body.result?.content?.find((part) => part.type === "text")?.text ?? "";
  if (body.result?.isError) {
    throw new UnbrowseError(text || "The Unbrowse tool call failed.");
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UnbrowseError(text || "Unbrowse returned an empty answer.");
  }
}

export interface ScrapedPage {
  url: string;
  finalUrl?: string;
  via?: string;
  metadata?: { title?: string; description?: string; statusCode?: number };
  markdown?: string;
}

/** Adds https:// to a bare host so "example.com" works. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new UnbrowseError("Enter a URL.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new UnbrowseError(`"${trimmed}" is not a URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnbrowseError("Only http and https pages can be read.");
  }
  return parsed.toString();
}

export function scrapePage(apiKey: string, url: string, options: { signal?: AbortSignal; fetchImpl?: Fetch } = {}) {
  return callTool<ScrapedPage>(apiKey, "unbrowse.scrape", { url, formats: ["markdown"] }, options);
}

export interface RunResult {
  runId: string;
  status:
    "succeeded" | "input_required" | "failed" | "outcome_unknown" | "cancelled" | "working" | "accepted" | "expired";
  capabilityId?: string | null;
  result?: unknown;
  error?: { code?: string; message?: string } | null;
  requirements?: unknown[];
}

const PENDING = new Set(["working", "accepted"]);

/** Runs a plain-language task and waits (up to maxWaitMs) while the run is still working. */
export async function runTask(
  apiKey: string,
  task: string,
  site: string | undefined,
  options: { signal?: AbortSignal; fetchImpl?: Fetch; pollMs?: number; maxWaitMs?: number } = {},
): Promise<RunResult> {
  const args: Record<string, unknown> = { task: task.trim(), interactionMode: "unattended" };
  if (site?.trim()) args.targetUrl = normalizeUrl(site);
  let run = await callTool<RunResult>(apiKey, "unbrowse.run", args, options);

  const pollMs = options.pollMs ?? 2000;
  const deadline = Date.now() + (options.maxWaitMs ?? 120_000);
  while (PENDING.has(run.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (options.signal?.aborted) break;
    run = await callTool<RunResult>(apiKey, "unbrowse.inspect", { runId: run.runId }, options);
  }
  return run;
}

export function pageMarkdown(page: ScrapedPage): string {
  const title = page.metadata?.title?.trim();
  const body = page.markdown?.trim() || "_This page has no readable text._";
  return title ? `# ${title}\n\n${body}` : body;
}

export function runMarkdown(task: string, run: RunResult): string {
  const lines = [`## ${task.trim()}`, ""];
  if (run.status === "succeeded") {
    lines.push("```json", JSON.stringify(run.result ?? null, null, 2), "```");
  } else if (run.status === "input_required") {
    lines.push("This task needs more input (for example a sign-in). Finish it at unbrowse.ai/app.");
    if (run.requirements?.length) lines.push("", "```json", JSON.stringify(run.requirements, null, 2), "```");
  } else if (PENDING.has(run.status)) {
    lines.push(`Still running (run \`${run.runId}\`). Check it later at unbrowse.ai/app.`);
  } else {
    lines.push(`**${run.status}**: ${run.error?.message ?? "the run did not finish."}`);
  }
  return lines.join("\n");
}
