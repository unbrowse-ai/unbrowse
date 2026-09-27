// Unbrowse for OpenClaw: every core Unbrowse tool as a native OpenClaw tool (calling the hosted remote MCP),
// a `web_fetch` provider backed by unbrowse.scrape, and a before_tool_call hook that sends the built-in
// `browser` tool's web navigation to Unbrowse (local pages stay allowed).
import { UnbrowseError, UnbrowseMcp, resultText } from "@unbrowse/sdk";
import type { McpToolResult } from "@unbrowse/sdk";
import toolsJson from "../skills/unbrowse/references/tools.json" with { type: "json" };
import type { BeforeToolCallEvent, BeforeToolCallResult, HostConfig, HostTool, JsonSchema, PluginApi, ToolResult, WebFetchProvider } from "./host-types.ts";
import { isLocalUrl, webUrlsIn } from "./urls.ts";

export const PLUGIN_ID = "unbrowse";
export const WEB_FETCH_PROVIDER_ID = "unbrowse";
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

export type CoreTool = { name: string; description: string; inputSchema: JsonSchema };
/** The core Unbrowse tools (the skill's references/tools.json, synced from the server export). */
export const CORE_TOOLS: CoreTool[] = (toolsJson as { tools: CoreTool[] }).tools;

/** A host-safe tool name: anything outside [A-Za-z0-9_-] becomes `_` (`unbrowse.browse.open` → `unbrowse_browse_open`). */
export function safeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

export type UnbrowseConfig = {
  apiKey?: string;
  mcpUrl?: string;
  endUser?: string;
  /** Block the built-in `browser` tool for non-local URLs (default true). */
  replaceBrowser?: boolean;
  /** Also block `web_fetch` for non-local URLs, pointing at unbrowse_scrape (default false). */
  blockWebFetch?: boolean;
};

export type PluginOptions = {
  /** Test seam: the fetch the MCP client uses. */
  fetch?: typeof globalThis.fetch;
  /** Test seam: environment lookups (default process.env). */
  env?: Record<string, string | undefined>;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function readConfig(raw: unknown): UnbrowseConfig {
  const c = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    apiKey: str(c.apiKey),
    mcpUrl: str(c.mcpUrl),
    endUser: str(c.endUser),
    replaceBrowser: c.replaceBrowser !== false,
    blockWebFetch: c.blockWebFetch === true,
  };
}

function pluginConfigFrom(config?: HostConfig): Record<string, unknown> | undefined {
  return config?.plugins?.entries?.[PLUGIN_ID]?.config;
}

/** Config precedence: plugin config, then UNBROWSE_API_KEY / UNBROWSE_MCP_URL / UNBROWSE_END_USER. */
export function clientFor(cfg: UnbrowseConfig, opts: PluginOptions, signal?: AbortSignal): UnbrowseMcp {
  const env = opts.env ?? process.env;
  const apiKey = cfg.apiKey ?? str(env.UNBROWSE_API_KEY);
  if (!apiKey) {
    throw new Error("Unbrowse is not configured: set UNBROWSE_API_KEY for the gateway, or plugins.entries.unbrowse.config.apiKey (a ub_live_… key from https://unbrowse.ai).");
  }
  const base = opts.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  return new UnbrowseMcp({
    apiKey,
    url: cfg.mcpUrl ?? str(env.UNBROWSE_MCP_URL),
    endUser: cfg.endUser ?? str(env.UNBROWSE_END_USER),
    client: `openclaw/${VERSION}`,
    fetch: signal ? (input, init) => base(input, { ...init, signal }) : base,
  });
}

const HINTS: Record<string, string> = {
  browser_capacity: "The Unbrowse cloud browser is at capacity. Wait about 30 seconds and retry, or use unbrowse_scrape with render:\"never\" for a page that needs no browser.",
  invalid_token: "The Unbrowse API key was rejected. Check UNBROWSE_API_KEY or plugins.entries.unbrowse.config.apiKey.",
  unauthorized: "The Unbrowse API key was rejected. Check UNBROWSE_API_KEY or plugins.entries.unbrowse.config.apiKey.",
  insufficient_credits: "The Unbrowse workspace is out of credits; see unbrowse_credits.",
};

/** A thrown error the model can act on: `Unbrowse <code>: <message>` plus a next step when one is known. */
export function toToolError(e: unknown): Error {
  if (e instanceof UnbrowseError) {
    const hint = HINTS[e.code] ?? (e.status === 401 ? HINTS.invalid_token : undefined);
    const err = new Error(`Unbrowse ${e.code}: ${e.message}${hint ? ` ${hint}` : ""}`);
    (err as Error & { code?: string; status?: number }).code = e.code;
    (err as Error & { code?: string; status?: number }).status = e.status;
    return err;
  }
  if (e instanceof Error && e.name === "AbortError") return e;
  return e instanceof Error ? e : new Error(String(e));
}

/** Call one hosted tool. MCP protocol errors and `isError` results both throw (OpenClaw's tool contract). */
export async function callUnbrowse(cfg: UnbrowseConfig, opts: PluginOptions, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
  signal?.throwIfAborted();
  let result: McpToolResult;
  try {
    result = await clientFor(cfg, opts, signal).callTool(name, args);
  } catch (e) {
    throw toToolError(e);
  }
  if (result.isError) {
    const text = resultText(result) || "tool returned an error";
    const code = (result.structuredContent as { code?: unknown } | undefined)?.code;
    const hint = typeof code === "string" ? HINTS[code] : undefined;
    throw new Error(`Unbrowse ${name} failed: ${text}${hint ? ` ${hint}` : ""}`);
  }
  return result;
}

function toResult(upstream: string, result: McpToolResult): ToolResult {
  // `details` keeps the structured payload under a wrapper key: status/ok/success/error/timedOut/exitCode
  // are reserved at its top level by OpenClaw's outcome grading.
  return {
    content: [{ type: "text", text: resultText(result) }],
    details: { unbrowseTool: upstream, ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}) },
  };
}

function label(name: string): string {
  return `Unbrowse ${name.replace(/^unbrowse\./, "").replace(/[._]/g, " ")}`;
}

/** One OpenClaw tool per core Unbrowse tool. */
export function createTools(getConfig: () => UnbrowseConfig, opts: PluginOptions = {}): HostTool[] {
  return CORE_TOOLS.map((t) => ({
    name: safeToolName(t.name),
    label: label(t.name),
    description: t.description,
    parameters: t.inputSchema,
    resultContentSource: "network" as const,
    async execute(_toolCallId, params, signal) {
      return toResult(t.name, await callUnbrowse(getConfig(), opts, t.name, params ?? {}, signal));
    },
  }));
}

/** The scrape payload's fields, from structuredContent or the JSON text. */
function scrapePayload(result: McpToolResult): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)) {
    return result.structuredContent as Record<string, unknown>;
  }
  const text = resultText(result);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch { /* plain text */ }
  return { markdown: text };
}

/** unbrowse.scrape's result → the payload `web_fetch` expects from a provider (text, title, finalUrl, status, …). */
export function toWebFetchPayload(requestedUrl: string, extractMode: "markdown" | "text", result: McpToolResult): Record<string, unknown> {
  const p = scrapePayload(result);
  const meta = (p.metadata && typeof p.metadata === "object" ? p.metadata : {}) as Record<string, unknown>;
  const body = extractMode === "text" ? (str(p.text) ?? str(p.markdown)) : (str(p.markdown) ?? str(p.text));
  const text = body ?? "";
  const title = str(meta.title) ?? str(p.title);
  const finalUrl = str(p.finalUrl) ?? str(meta.sourceURL) ?? str(p.url) ?? requestedUrl;
  const status = typeof meta.statusCode === "number" ? meta.statusCode : typeof p.status === "number" ? p.status : undefined;
  const via = str(p.via);
  const warning = str(p.warning);
  return {
    url: requestedUrl,
    finalUrl,
    text,
    ...(title ? { title } : {}),
    ...(status !== undefined ? { status } : {}),
    contentType: extractMode === "text" ? "text/plain" : "text/markdown",
    extractor: via ? `unbrowse (${via})` : "unbrowse",
    rawLength: text.length,
    ...(warning ? { warning } : {}),
  };
}

function enablePluginInConfig(config: HostConfig): HostConfig {
  if (config.plugins?.enabled === false || config.plugins?.deny?.includes(PLUGIN_ID)) return config;
  const allow = config.plugins?.allow;
  return {
    ...config,
    plugins: {
      ...config.plugins,
      ...(allow && !allow.includes(PLUGIN_ID) ? { allow: [...allow, PLUGIN_ID] } : {}),
      entries: { ...config.plugins?.entries, [PLUGIN_ID]: { ...config.plugins?.entries?.[PLUGIN_ID], enabled: true } },
    },
  };
}

/** `web_fetch` provider: OpenClaw calls it when its own fetch fails or extracts nothing. */
export function createWebFetchProvider(getConfig: () => UnbrowseConfig, opts: PluginOptions = {}): WebFetchProvider {
  return {
    id: WEB_FETCH_PROVIDER_ID,
    label: "Unbrowse",
    hint: "Read pages through Unbrowse: renders JavaScript in its cloud browser and reuses saved logins.",
    requiresCredential: true,
    credentialLabel: "Unbrowse API key",
    envVars: ["UNBROWSE_API_KEY"],
    placeholder: "ub_live_...",
    signupUrl: "https://unbrowse.ai",
    docsUrl: "https://github.com/unbrowse-ai/unbrowse/tree/main/plugins/openclaw",
    autoDetectOrder: 40,
    credentialPath: `plugins.entries.${PLUGIN_ID}.config.apiKey`,
    inactiveSecretPaths: [`plugins.entries.${PLUGIN_ID}.config.apiKey`],
    getCredentialValue: (fetchConfig) => {
      const own = fetchConfig?.[PLUGIN_ID];
      return own && typeof own === "object" ? (own as { apiKey?: unknown }).apiKey : undefined;
    },
    setCredentialValue: (target, value) => {
      const own = target[PLUGIN_ID] && typeof target[PLUGIN_ID] === "object" ? (target[PLUGIN_ID] as Record<string, unknown>) : {};
      own.apiKey = value;
      target[PLUGIN_ID] = own;
    },
    getConfiguredCredentialValue: (config) => pluginConfigFrom(config)?.apiKey,
    setConfiguredCredentialValue: (config, value) => {
      const plugins = (config.plugins ??= {});
      const entries = (plugins.entries ??= {});
      const entry = (entries[PLUGIN_ID] ??= {});
      entry.config = { ...entry.config, apiKey: value };
    },
    applySelectionConfig: enablePluginInConfig,
    createTool: (ctx) => ({
      description: "Fetch a page through Unbrowse (unbrowse.scrape): clean markdown, JavaScript rendered when needed.",
      parameters: { type: "object", properties: { url: { type: "string" }, extractMode: { type: "string", enum: ["markdown", "text"] }, maxChars: { type: "number" } }, required: ["url"] },
      async execute(args, context) {
        const url = typeof args.url === "string" ? args.url : "";
        const extractMode = args.extractMode === "text" ? "text" : "markdown";
        const cfg = { ...readConfig(pluginConfigFrom(ctx.config)), ...definedOnly(getConfig()) };
        const result = await callUnbrowse(cfg, opts, "unbrowse.scrape", { url, formats: [extractMode] }, context?.signal);
        return toWebFetchPayload(url, extractMode, result);
      },
    }),
  };
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const SCRAPE = safeToolName("unbrowse.scrape");
const OPEN = safeToolName("unbrowse.browse.open");
const DISCOVER = safeToolName("unbrowse.discover");
const RUN = safeToolName("unbrowse.run");

/** The block reason for a tool call Unbrowse replaces, or undefined to let it run. */
export function blockReason(event: BeforeToolCallEvent, cfg: UnbrowseConfig): string | undefined {
  const name = event.toolName;
  const watched = (name === "browser" && cfg.replaceBrowser !== false) || (name === "web_fetch" && cfg.blockWebFetch === true);
  if (!watched) return undefined;
  const remote = webUrlsIn(event.params).find((u) => !isLocalUrl(u));
  if (!remote) return undefined;
  const target = remote.href;
  const use =
    name === "web_fetch"
      ? `${SCRAPE} {url: "${target}"} to read the page (clean markdown, renders JavaScript, reuses saved logins)`
      : `${SCRAPE} {url: "${target}"} to read it, ${DISCOVER} + ${RUN} for a task on the site, or ${OPEN} {url: "${target}", task} then unbrowse_browse_act / unbrowse_browse_finish to drive the Unbrowse cloud browser (it learns the route for next time)`;
  return `Unbrowse replaces the built-in ${name} tool for web pages. Use ${use}. Local pages (localhost, 127.0.0.1) stay allowed. To turn this off set plugins.entries.unbrowse.config.${name === "web_fetch" ? "blockWebFetch" : "replaceBrowser"} to false.`;
}

/** Register everything on the OpenClaw plugin API. */
export function register(api: PluginApi, opts: PluginOptions = {}): void {
  const getConfig = () => readConfig(api.pluginConfig);
  for (const tool of createTools(getConfig, opts)) api.registerTool(tool);
  if (typeof api.registerWebFetchProvider === "function") api.registerWebFetchProvider(createWebFetchProvider(getConfig, opts));
  api.on("before_tool_call", (event): BeforeToolCallResult => {
    const reason = blockReason(event, getConfig());
    return reason ? { block: true, blockReason: reason } : undefined;
  });
}
