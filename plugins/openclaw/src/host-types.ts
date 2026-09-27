// The slice of the OpenClaw plugin API this plugin uses, typed structurally so the package needs no
// runtime or type dependency on `openclaw` (verified against openclaw 2026.9.6:
// src/plugins/plugin-api.types.ts, src/plugins/hook-types.ts, src/plugins/web-provider-types.ts,
// packages/agent-core/src/types.ts).

export type JsonSchema = { type: "object"; properties?: Record<string, unknown>; required?: string[] } & Record<string, unknown>;

export type ToolResult = {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
};

/** OpenClaw `AgentTool`: execute(toolCallId, params, signal?, onUpdate?); throw on failure. */
export type HostTool = {
  name: string;
  label: string;
  description: string;
  parameters: JsonSchema;
  resultContentSource?: "network";
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown) => Promise<ToolResult>;
};

export type BeforeToolCallEvent = { toolName: string; params: Record<string, unknown>; toolCallId?: string; runId?: string };
export type BeforeToolCallResult = { block?: boolean; blockReason?: string; params?: Record<string, unknown> } | undefined;

/** The OpenClaw config object, as far as this plugin reads it. */
export type HostConfig = {
  plugins?: {
    enabled?: boolean;
    allow?: string[];
    deny?: string[];
    entries?: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
  };
} & Record<string, unknown>;

export type WebFetchTool = {
  description: string;
  parameters: JsonSchema;
  execute: (args: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<Record<string, unknown>>;
};

export type WebFetchProvider = {
  id: string;
  label: string;
  hint: string;
  requiresCredential?: boolean;
  credentialLabel?: string;
  envVars: string[];
  placeholder: string;
  signupUrl: string;
  docsUrl?: string;
  autoDetectOrder?: number;
  credentialPath: string;
  inactiveSecretPaths?: string[];
  getCredentialValue: (fetchConfig?: Record<string, unknown>) => unknown;
  setCredentialValue: (fetchConfigTarget: Record<string, unknown>, value: unknown) => void;
  getConfiguredCredentialValue?: (config?: HostConfig) => unknown;
  setConfiguredCredentialValue?: (configTarget: HostConfig, value: unknown) => void;
  applySelectionConfig?: (config: HostConfig) => HostConfig;
  createTool: (ctx: { config?: HostConfig; fetchConfig?: Record<string, unknown> }) => WebFetchTool | null;
};

export type PluginApi = {
  id: string;
  config?: HostConfig;
  pluginConfig?: Record<string, unknown>;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void; debug?: (msg: string) => void };
  registerTool: (tool: HostTool) => void;
  registerWebFetchProvider?: (provider: WebFetchProvider) => void;
  on: (hookName: "before_tool_call", handler: (event: BeforeToolCallEvent, ctx: unknown) => BeforeToolCallResult | Promise<BeforeToolCallResult>) => void;
};
