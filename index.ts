/**
 * Unbrowse — Reverse-engineer internal APIs from any website.
 *
 * Pure native Rust implementation. All functionality provided by unbrowse-native.
 */

// @ts-nocheck - Native module types handled separately
import * as native from "./native/index.js";

// Re-export native module
export * from "./native/index.js";

export default function unbrowsePlugin(api: any) {
  // =========================================================================
  // Tool: unbrowse_capture
  // =========================================================================
  api.registerTool({
    name: "unbrowse_capture",
    description: `Capture internal API traffic from browser and generate a skill.

Visit URLs in the browser, capture all API calls, extract auth tokens, and generate a reusable skill package.

Returns: Skill with endpoints, auth method, and generated TypeScript client.`,
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "URLs to visit and capture API traffic from",
        },
        output_dir: {
          type: "string",
          description: "Optional output directory for skill files",
        },
      },
      required: ["urls"],
    },
    async execute(args: { urls: string[]; output_dir?: string }) {
      const apiData = await native.captureFromUrls(args.urls, undefined);
      const result = native.generateSkill(apiData, args.output_dir, undefined);

      return {
        success: true,
        service: result.service,
        skill_dir: result.skillDir,
        endpoints_count: result.endpointsCount,
        auth_method: result.authMethod,
        message: `Captured ${result.endpointsCount} endpoints from ${result.service}. Skill saved to ${result.skillDir}`,
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_replay
  // =========================================================================
  api.registerTool({
    name: "unbrowse_replay",
    description: `Call an internal API endpoint using captured auth.

Execute HTTP requests against internal APIs with proper authentication headers and cookies.

Returns: Response status, body, and timing.`,
    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Service name (skill name) to use for auth",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method",
        },
        path: {
          type: "string",
          description: "API path (e.g., /api/users)",
        },
        body: {
          type: "string",
          description: "Request body (JSON string)",
        },
      },
      required: ["service", "method", "path"],
    },
    async execute(args: { service: string; method: string; path: string; body?: string }) {
      const skillInfo = native.getSkillInfo(args.service);
      if (!skillInfo) {
        return { success: false, error: `Skill not found: ${args.service}` };
      }

      const vaultEntry = await native.vaultGet(args.service);
      const authHeaders = vaultEntry?.headers || {};
      const cookies = vaultEntry?.cookies || {};
      const baseUrl = vaultEntry?.baseUrl || `https://${args.service}`;

      const result = await native.testEndpoint(
        baseUrl,
        args.method,
        args.path,
        authHeaders,
        cookies,
        30000
      );

      return {
        success: result.status >= 200 && result.status < 400,
        status: result.status,
        latency_ms: result.latencyMs,
        response_shape: result.responseShape,
        response_size: result.responseSize,
        error: result.error,
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_login
  // =========================================================================
  api.registerTool({
    name: "unbrowse_login",
    description: `Login to a website and capture session auth.

Navigates to login page, fills credentials, and captures resulting session cookies/tokens.

Returns: Captured auth headers and cookies.`,
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Login page URL",
        },
        username: {
          type: "string",
          description: "Username or email (optional - will lookup from keychain)",
        },
        password: {
          type: "string",
          description: "Password (optional - will lookup from keychain)",
        },
      },
      required: ["url"],
    },
    async execute(args: { url: string; username?: string; password?: string }) {
      const domain = new URL(args.url).hostname;
      let username = args.username;
      let password = args.password;

      if (!username || !password) {
        const creds = native.lookupCredentials(domain);
        if (creds) {
          username = username || creds.username;
          password = password || creds.password;
        }
      }

      if (!username || !password) {
        return { success: false, error: "Credentials not provided and not found in keychain" };
      }

      await native.browserStart(undefined);
      await native.browserNavigate(args.url, undefined);
      await new Promise(r => setTimeout(r, 2000));

      const snapshot = await native.browserSnapshot(undefined);

      for (const el of snapshot.elements) {
        const elType = el.elementType?.toLowerCase() || "";
        const elName = el.name?.toLowerCase() || "";

        if (elType === "email" || elType === "text" || elName.includes("user") || elName.includes("email")) {
          await native.browserAct("type", el.index, username, undefined);
        }
        if (elType === "password" || elName.includes("pass")) {
          await native.browserAct("type", el.index, password, undefined);
        }
      }

      for (const el of snapshot.elements) {
        const elType = el.elementType?.toLowerCase() || "";
        const elText = el.text?.toLowerCase() || "";
        if (elType === "submit" || elText.includes("sign in") || elText.includes("log in")) {
          await native.browserAct("click", el.index, undefined, undefined);
          break;
        }
      }

      await new Promise(r => setTimeout(r, 3000));
      const authJson = await native.extractBrowserAuth(domain, undefined);

      await native.vaultStore(
        authJson.service,
        authJson.baseUrl,
        authJson.authMethod,
        authJson.headers || {},
        authJson.cookies || {}
      );

      return {
        success: true,
        service: authJson.service,
        auth_method: authJson.authMethod,
        headers_count: Object.keys(authJson.headers || {}).length,
        cookies_count: Object.keys(authJson.cookies || {}).length,
        message: `Logged in and captured auth for ${authJson.service}`,
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_learn
  // =========================================================================
  api.registerTool({
    name: "unbrowse_learn",
    description: `Parse a HAR file and generate an API skill.

Takes a HAR file (from browser DevTools export) and generates a complete skill package.

Returns: Generated skill with endpoints and auth.`,
    parameters: {
      type: "object",
      properties: {
        har_path: {
          type: "string",
          description: "Path to HAR file",
        },
        seed_url: {
          type: "string",
          description: "Seed URL to determine service name",
        },
        output_dir: {
          type: "string",
          description: "Optional output directory",
        },
      },
      required: ["har_path"],
    },
    async execute(args: { har_path: string; seed_url?: string; output_dir?: string }) {
      const fs = await import("node:fs");

      if (!fs.existsSync(args.har_path)) {
        return { success: false, error: `HAR file not found: ${args.har_path}` };
      }

      const harJson = fs.readFileSync(args.har_path, "utf-8");
      const apiData = native.parseHar(harJson, args.seed_url);
      const result = native.generateSkill(apiData, args.output_dir, undefined);

      await native.vaultStore(
        apiData.service,
        apiData.baseUrl,
        apiData.authMethod,
        apiData.authHeaders,
        apiData.cookies
      );

      return {
        success: true,
        service: result.service,
        skill_dir: result.skillDir,
        endpoints_count: result.endpointsCount,
        auth_method: result.authMethod,
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_skills
  // =========================================================================
  api.registerTool({
    name: "unbrowse_skills",
    description: `List all captured API skills.

Shows locally learned skills with their endpoints and auth methods.`,
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const skills = native.listSkills();
      const details = skills.map((service: string) => {
        const info = native.getSkillInfo(service);
        return {
          service,
          name: info?.name,
          endpoints: info?.endpointsCount || 0,
          version: info?.version,
        };
      });

      return { success: true, count: skills.length, skills: details };
    },
  });

  // =========================================================================
  // Tool: unbrowse_auth
  // =========================================================================
  api.registerTool({
    name: "unbrowse_auth",
    description: `Extract auth from current browser session.

Captures cookies, localStorage, and request headers from the browser.`,
    parameters: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Domain to extract auth for",
        },
      },
      required: ["domain"],
    },
    async execute(args: { domain: string }) {
      const authJson = await native.extractBrowserAuth(args.domain, undefined);

      await native.vaultStore(
        authJson.service,
        authJson.baseUrl,
        authJson.authMethod,
        authJson.headers || {},
        authJson.cookies || {}
      );

      return {
        success: true,
        service: authJson.service,
        auth_method: authJson.authMethod,
        base_url: authJson.baseUrl,
        headers: Object.keys(authJson.headers || {}),
        cookies: Object.keys(authJson.cookies || {}),
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_publish
  // =========================================================================
  api.registerTool({
    name: "unbrowse_publish",
    description: `Publish a skill to the marketplace.

Shares your API skill for others to use. Credentials are stripped before publishing.`,
    parameters: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: "Service name to publish",
        },
        description: {
          type: "string",
          description: "Description of the skill",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for discoverability",
        },
        price_usdc: {
          type: "number",
          description: "Price in USDC (0 for free)",
        },
      },
      required: ["service"],
    },
    async execute(args: { service: string; description?: string; tags?: string[]; price_usdc?: number }) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");

      const skillDir = path.join(os.homedir(), ".openclaw", "skills", args.service);
      const skillMdPath = path.join(skillDir, "SKILL.md");
      const apiTsPath = path.join(skillDir, "scripts", "api.ts");
      const authJsonPath = path.join(skillDir, "auth.json");

      if (!fs.existsSync(skillMdPath)) {
        return { success: false, error: `Skill not found: ${args.service}` };
      }

      const skillMd = fs.readFileSync(skillMdPath, "utf-8");
      const apiTs = fs.existsSync(apiTsPath) ? fs.readFileSync(apiTsPath, "utf-8") : undefined;
      const authJson = fs.existsSync(authJsonPath) ? fs.readFileSync(authJsonPath, "utf-8") : "{}";

      const payload = native.prepareForPublish(skillMd, apiTs, authJson);
      payload.description = args.description;
      payload.tags = args.tags;
      payload.priceUsdc = args.price_usdc;

      const wallet = native.walletGetOrCreate();
      const message = JSON.stringify({ service: args.service, timestamp: Date.now() });
      const signature = native.walletSign(message);

      const result = await native.marketplacePublish(payload, wallet.pubkey, signature, undefined);

      return {
        success: true,
        id: result.id,
        name: result.name,
        service: result.service,
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_search
  // =========================================================================
  api.registerTool({
    name: "unbrowse_search",
    description: `Search the skill marketplace.

Find API skills others have created and shared.`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
      },
      required: ["query"],
    },
    async execute(args: { query: string }) {
      const results = await native.marketplaceSearch(args.query, undefined);

      return {
        success: true,
        count: results.length,
        skills: results.map((s: any) => ({
          id: s.id,
          name: s.name,
          service: s.service,
          description: s.description,
          author: s.author,
          endpoints: s.endpointsCount,
          installs: s.installs,
          price_usdc: s.priceUsdc,
          badge: s.badge,
        })),
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_download
  // =========================================================================
  api.registerTool({
    name: "unbrowse_download",
    description: `Download a skill from the marketplace.

Install a skill locally. May require x402 payment for paid skills.`,
    parameters: {
      type: "object",
      properties: {
        skill_id: {
          type: "string",
          description: "Skill ID to download",
        },
      },
      required: ["skill_id"],
    },
    async execute(args: { skill_id: string }) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");

      const skillInfo = await native.marketplaceGetSkill(args.skill_id, undefined);
      if (!skillInfo) {
        return { success: false, error: `Skill not found: ${args.skill_id}` };
      }

      let paymentSig: string | undefined;
      if (skillInfo.priceUsdc && skillInfo.priceUsdc > 0 && skillInfo.authorWallet) {
        paymentSig = native.walletSignPayment(args.skill_id, skillInfo.priceUsdc, skillInfo.authorWallet);
      }

      const pkg = await native.marketplaceDownload(args.skill_id, paymentSig, undefined);

      const skillDir = path.join(os.homedir(), ".openclaw", "skills", pkg.id);
      fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
      fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });

      fs.writeFileSync(path.join(skillDir, "SKILL.md"), pkg.skillMd);
      if (pkg.apiTs) {
        fs.writeFileSync(path.join(skillDir, "scripts", "api.ts"), pkg.apiTs);
      }
      if (pkg.referenceMd) {
        fs.writeFileSync(path.join(skillDir, "references", "REFERENCE.md"), pkg.referenceMd);
      }

      await native.marketplaceTrackInstall(args.skill_id, undefined);

      return {
        success: true,
        id: pkg.id,
        skill_dir: skillDir,
        endpoints: pkg.endpoints.length,
        auth_method: pkg.authMethod,
      };
    },
  });

  // =========================================================================
  // Tool: unbrowse_wallet
  // =========================================================================
  api.registerTool({
    name: "unbrowse_wallet",
    description: `Manage your marketplace wallet.

Create or view your Ed25519 wallet for x402 payments.`,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "create"],
          description: "Action to perform",
        },
      },
      required: ["action"],
    },
    async execute(args: { action: "get" | "create" }) {
      if (args.action === "create") {
        const existing = native.walletGet();
        if (existing) {
          return { success: true, pubkey: existing.pubkey, created_at: existing.createdAt, message: "Wallet already exists" };
        }
        const wallet = native.walletCreate();
        return { success: true, pubkey: wallet.pubkey, created_at: wallet.createdAt, message: "Created new wallet" };
      } else {
        const wallet = native.walletGet();
        if (!wallet) {
          return { success: false, error: "No wallet found. Use action: create" };
        }
        return { success: true, pubkey: wallet.pubkey, created_at: wallet.createdAt };
      }
    },
  });

  // =========================================================================
  // Tool: unbrowse_record
  // =========================================================================
  api.registerTool({
    name: "unbrowse_record",
    description: `Record a workflow session.

Start/stop recording browser interactions to learn multi-step workflows.`,
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "stop", "status"],
          description: "Recording action",
        },
      },
      required: ["action"],
    },
    async execute(args: { action: "start" | "stop" | "status" }) {
      if (args.action === "start") {
        const id = native.recordingStart();
        return { success: true, session_id: id, message: "Recording started" };
      } else if (args.action === "stop") {
        const session = native.recordingStop();
        if (!session) {
          return { success: false, error: "No active recording" };
        }
        const workflow = native.workflowLearn(session);
        return {
          success: true,
          session_id: session.id,
          steps: session.steps.length,
          domains: session.domains,
          workflow_id: workflow.id,
          workflow_name: workflow.name,
        };
      } else {
        const isActive = native.recordingIsActive();
        const current = native.recordingCurrent();
        return {
          success: true,
          is_active: isActive,
          session: current ? { id: current.id, steps: current.steps.length, domains: current.domains } : null,
        };
      }
    },
  });

  return {
    name: "unbrowse",
    version: native.getVersion(),
    native: native.isNative(),
  };
}
