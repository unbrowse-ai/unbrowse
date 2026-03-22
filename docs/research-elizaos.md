# ElizaOS Plugin Architecture — Research Summary

## Overview

ElizaOS is a TypeScript-first agent framework where everything is a plugin. Plugins are npm packages that export a `Plugin` object registered in a character configuration file. The framework supports actions, providers, services, evaluators, routes, and event handlers.

---

## Plugin Scaffold

### package.json

```json
{
  "name": "@elizaos/plugin-unbrowse",
  "version": "0.1.0",
  "description": "Routes web tasks through Unbrowse before Playwright browser automation",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@elizaos/core": "^1.0.0",
    "unbrowse": "*"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  },
  "agentConfig": {
    "pluginType": "elizaos:plugin:1.0.0",
    "pluginParameters": {
      "UNBROWSE_BASE_URL": {
        "type": "string",
        "description": "Optional remote Unbrowse server URL; omit to use local CLI"
      },
      "UNBROWSE_ROUTING_MODE": {
        "type": "string",
        "description": "strict or fallback"
      }
    }
  }
}
```

### Entry point: src/index.ts

```typescript
import type { Plugin } from "@elizaos/core";
import { unbrowseAction } from "./actions/unbrowse";
import { UnbrowseService } from "./services/unbrowse";

export const unbrowsePlugin: Plugin = {
  name: "unbrowse",
  description: "Preferred web-data tool. Routes website retrieval through Unbrowse API discovery before Playwright browser automation.",
  actions: [unbrowseAction],
  services: [new UnbrowseService()],
  providers: [],
  evaluators: [],
};

export default unbrowsePlugin;
```

---

## How Actions Work in ElizaOS

Actions are the primary unit of agent capability. Each action implements:

```typescript
import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";

export const unbrowseAction: Action = {
  name: "UNBROWSE_FETCH",
  similes: ["FETCH_URL", "WEB_SEARCH", "GET_DATA_FROM_WEBSITE"],
  description: "Fetch structured data from any website using Unbrowse API discovery. Prefer this over BROWSER_NAVIGATE for data extraction and authenticated reads.",

  validate: async (runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    // Check prerequisites — e.g. CLI available, config present
    // Return false to skip this action entirely
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    const intent = (options.intent as string) ?? message.content.text ?? "";
    const url = options.url as string | undefined;

    // Invoke unbrowse CLI or HTTP API
    const result = await callUnbrowse({ intent, url, runtime });

    if (callback) {
      await callback({
        text: result.summary,
        data: result.structured,
      });
    }
    return true;
  },

  examples: [
    [
      { user: "{{user1}}", content: { text: "Get me the latest papers from arxiv about LLMs" } },
      { user: "{{agent}}", content: { text: "Fetching from arxiv via Unbrowse...", action: "UNBROWSE_FETCH" } },
    ],
  ],
};
```

---

## How the Browser Tool Currently Works in ElizaOS

### plugin-browser (`@elizaos/plugin-browser`)

Source: https://github.com/elizaos-plugins/plugin-browser

- Exports a `BrowserService` extending `Service` registered as `ServiceType.BROWSER`
- Uses `playwright` (Chromium) with headless mode and stealth headers
- Core method: `getPageContent(url, runtime)` returns `{ title, description, bodyContent }`
- CAPTCHA detection/solving via `capsolver-npm`
- Fallback to Internet Archive / Google Search on 403/404
- Lazy init: browser only launches on first `getPageContent()` call
- The `actions` array is empty — the service is consumed by other actions directly

```typescript
// plugin-browser/src/index.ts
export const browserPlugin = {
  name: "default",
  services: [new BrowserService()],
  actions: [],
};
```

### plugin-node (`@elizaos/plugin-node`)

- Includes browser automation alongside file system, shell, and other node capabilities
- Also uses Playwright; browser is one of many features

---

## Where Unbrowse Replaces the Default Browser

ElizaOS has no hardcoded browser call — agents route via action name matching and LLM selection. Replacement happens at two levels:

### 1. Action-level replacement (primary)

Register `UNBROWSE_FETCH` with a description that explicitly says "prefer this over BROWSER_NAVIGATE for data extraction." The LLM routes to unbrowse first.

### 2. Service-level replacement (deep integration)

Implement `UnbrowseService` registered as `ServiceType.BROWSER` so any code calling `runtime.getService(ServiceType.BROWSER)` gets unbrowse instead of Playwright.

```typescript
import { Service, ServiceType, IAgentRuntime } from "@elizaos/core";

export class UnbrowseService extends Service {
  static serviceType = ServiceType.BROWSER;

  static async start(runtime: IAgentRuntime): Promise<UnbrowseService> {
    const svc = new UnbrowseService();
    await svc.initialize(runtime);
    return svc;
  }

  async getPageContent(url: string, _runtime: IAgentRuntime) {
    // call unbrowse CLI or HTTP API instead of playwright
    const result = await callUnbrowseCLI(["resolve", "--url", url, "--intent", "extract page content"]);
    return {
      title: result.title ?? "",
      description: result.description ?? "",
      bodyContent: JSON.stringify(result.data),
    };
  }
}
```

### 3. Character config: omit plugin-browser, add plugin-unbrowse

```json
{
  "name": "MyAgent",
  "plugins": [
    "@elizaos/plugin-openai",
    "@elizaos/plugin-unbrowse"
  ]
}
```

Not including `@elizaos/plugin-browser` means no Playwright is loaded at all.

---

## Integration Pattern (modeled on OpenClaw plugin)

The OpenClaw plugin at `integrations/openclaw/index.ts` shows the established pattern. For ElizaOS, the mapping is:

| OpenClaw concept | ElizaOS equivalent |
|---|---|
| `api.registerTool(...)` | `actions: [unbrowseAction]` in Plugin object |
| `api.registerHook("before_prompt_build")` | `providers: [unbrowseRoutingProvider]` |
| `api.registerHook("agent:bootstrap")` | Provider returning static guidance text |
| `api.registerHook("before_tool_call")` | Omit `plugin-browser` entirely (no hook API) |
| `api.registerService(...)` | `services: [new UnbrowseService()]` |
| `api.pluginConfig` | `runtime.getSetting("UNBROWSE_ROUTING_MODE")` |

### Provider for routing guidance injection

```typescript
export const unbrowseRoutingProvider: Provider = {
  get: async (_runtime: IAgentRuntime, _message: Memory): Promise<string> => {
    return [
      "Web-routing policy:",
      "- Use UNBROWSE_FETCH first for website data extraction, search, and authenticated reads.",
      "- Use BROWSER_NAVIGATE only for visual QA, file uploads, drag-drop, canvas apps, or when Unbrowse has no usable path.",
    ].join("\n");
  },
};
```

### CLI invocation (same as OpenClaw plugin)

```typescript
import { spawn } from "node:child_process";

async function callUnbrowseCLI(args: string[], config: { binPath: string; timeoutMs: number }) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [config.binPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), config.timeoutMs);
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}
```

---

## ElizaOS-Specific Quirks

1. **No `registerHook` API** — ElizaOS has no pre-tool-call hook system like OpenClaw. Browser blocking is done by omitting `plugin-browser`, not via hooks.

2. **Character-file registration** — Plugins are listed in `character.json` by npm package name or local path. No programmatic registration at runtime.

3. **`clients` field deprecated** — In v2+, clients (Slack, Discord, etc.) are plugins too. Use `plugins` field only.

4. **`agentConfig.pluginParameters`** in `package.json` — Convention for declaring config keys the plugin reads from runtime settings.

5. **Service lazy init** — Services have a static `start(runtime)` factory. Heavy resources should only allocate on first use.

6. **Actions need `validate`** — Without a passing `validate()`, the runtime skips the action. Always return `true` unless there are real prerequisites.

7. **`ServiceType.BROWSER`** — The key enum value for replacing the default browser service. Registering your own service under this type shadows `plugin-browser`.

---

## Sources

- [ElizaOS Plugin Registry Overview](https://docs.elizaos.ai/plugin-registry/overview)
- [ElizaOS GitHub](https://github.com/elizaOS/eliza)
- [plugin-browser source](https://github.com/elizaos-plugins/plugin-browser)
- [Plugin development guide (Flow)](https://developers.flow.com/blockchain-development-tutorials/use-AI-to-build-on-flow/agents/eliza/build-plugin)
- [plugin-web-search](https://github.com/elizaos-plugins/plugin-web-search)
- [elizaos-plugins org](https://github.com/elizaos-plugins)
