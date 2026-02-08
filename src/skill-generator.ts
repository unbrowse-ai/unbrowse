/**
 * Skill Generator — Generate SKILL.md, auth.json, api.ts, and test files.
 *
 * Refactored into OOP: SkillGenerator delegates to EndpointMerger,
 * VersionHasher, SkillDiffCalculator, and SkillFileWriter.
 *
 * Ported from meta_learner_simple.py generate_skill_md(), generate_auth_py(),
 * generate_test_py(), generate_skill(). Outputs TypeScript instead of Python.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { ApiData, AuthInfo, SkillResult, EndpointGroup } from "./types.js";
import { generateAuthInfo } from "./auth-extractor.js";
import { enrichEndpointDescriptions } from "./llm-describer.js";

// ---------------------------------------------------------------------------
// VersionHasher — content-addressable versioning
// ---------------------------------------------------------------------------

export class VersionHasher {
  /**
   * Generate SHA-256 hash for version fingerprinting.
   * Returns first 8 characters of the hash.
   */
  hash(
    skillMd: string,
    scripts: Record<string, string>,
    references: Record<string, string>,
  ): string {
    const content = JSON.stringify({ skillMd, scripts, references }, null, 2);
    return createHash("sha256").update(content).digest("hex").slice(0, 8);
  }

  /** Extract version info from SKILL.md frontmatter. */
  extractVersionInfo(skillMd: string): { version?: string; versionHash?: string } {
    const versionMatch = skillMd.match(/^\s*version:\s*"?([^"\n]+)"?/m);
    const hashMatch = skillMd.match(/^\s*versionHash:\s*"?([^"\n]+)"?/m);
    return {
      version: versionMatch?.[1]?.trim(),
      versionHash: hashMatch?.[1]?.trim(),
    };
  }
}

// ---------------------------------------------------------------------------
// SkillDiffCalculator — compute diffs between skill versions
// ---------------------------------------------------------------------------

export class SkillDiffCalculator {
  /**
   * Parse existing SKILL.md to extract endpoint keys (METHOD /path).
   */
  parseExistingEndpoints(skillMd: string): Set<string> {
    const endpoints = new Set<string>();
    const regex = /^- `(GET|POST|PUT|DELETE|PATCH)\s+([^`]+)`/gm;
    let match;
    while ((match = regex.exec(skillMd)) !== null) {
      endpoints.add(`${match[1]} ${match[2]}`);
    }
    return endpoints;
  }

  /**
   * Compute a human-readable diff between old and new endpoint counts.
   */
  computeDiff(
    oldEndpointCount: number,
    newEndpointCount: number,
    oldSkillMd: string | undefined,
    newSkillMd: string,
  ): { changed: boolean; diff: string | null } {
    if (oldEndpointCount === 0) {
      return { changed: true, diff: null };
    }

    let changed = true;
    let diff: string | null = null;

    if (newEndpointCount === oldEndpointCount && oldSkillMd) {
      changed = oldSkillMd !== newSkillMd;
    }

    const added = newEndpointCount - oldEndpointCount;
    if (added > 0) {
      diff = `+${added} new endpoint(s) (${oldEndpointCount} → ${newEndpointCount})`;
    } else if (changed) {
      diff = `Updated (${newEndpointCount} endpoints)`;
    }

    return { changed, diff };
  }
}

// ---------------------------------------------------------------------------
// EndpointMerger — handles merging endpoints across captures
// ---------------------------------------------------------------------------

export class EndpointMerger {
  private diffCalculator: SkillDiffCalculator;

  constructor(diffCalculator?: SkillDiffCalculator) {
    this.diffCalculator = diffCalculator ?? new SkillDiffCalculator();
  }

  /**
   * Merge existing endpoints from a SKILL.md file into API data.
   * Never loses previously discovered endpoints.
   *
   * @returns The count of previously existing endpoints.
   */
  mergeExisting(data: ApiData, skillMdPath: string): number {
    if (!existsSync(skillMdPath)) return 0;

    const oldSkillMd = readFileSync(skillMdPath, "utf-8");
    const existingEndpoints = this.diffCalculator.parseExistingEndpoints(oldSkillMd);
    const oldEndpointCount = existingEndpoints.size;

    // Add back endpoints that weren't captured this session
    for (const epKey of existingEndpoints) {
      const [method, ...pathParts] = epKey.split(" ");
      const path = pathParts.join(" ");
      if (!data.endpoints[epKey]) {
        data.endpoints[epKey] = [{
          method,
          path,
          url: data.baseUrl + path,
          domain: new URL(data.baseUrl).hostname,
          status: 200,
          fromSpec: false,
          verified: undefined,
        }];
      }
    }

    return oldEndpointCount;
  }
}

// ---------------------------------------------------------------------------
// SkillFileWriter — handles SKILL.md, auth.json, api.ts generation
// ---------------------------------------------------------------------------

export class SkillFileWriter {
  /** PascalCase from kebab-case. */
  private toPascalCase(s: string): string {
    return s.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  }

  /** Get a human-readable endpoint description. */
  private endpointDesc(path: string, method: string): string {
    if (method === "GET") {
      return path.match(/\/\{|\/:/) ? "Get resource" : "List resources";
    }
    if (method === "POST") return "Create resource";
    if (method === "PUT" || method === "PATCH") return "Update resource";
    if (method === "DELETE") return "Delete resource";
    return "Endpoint";
  }

  /** Generate auth.json content. */
  generateAuthJson(service: string, data: ApiData): string {
    const auth = generateAuthInfo(service, data);
    return JSON.stringify(auth, null, 2);
  }

  /** Generate SKILL.md content following agentskills.io specification. */
  generateSkillMd(service: string, data: ApiData, endpointGroups?: EndpointGroup[]): string {
    const className = this.toPascalCase(service);
    const title = service.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    const endpointLines: string[] = [];
    let endpointCount: number;

    if (endpointGroups && endpointGroups.length > 0) {
      endpointCount = endpointGroups.length;
      for (const g of endpointGroups) {
        const schema = g.responseBodySchema ? ` \u2192 ${g.responseBodySchema.summary}` : "";
        const method = g.methodName ? ` \`${g.methodName}()\`` : "";
        const whenHint = g.whenToUse ? ` | **Use when:** ${g.whenToUse}` : "";
        endpointLines.push(`- \`${g.method} ${g.normalizedPath}\`${method} \u2014 ${g.description}${schema}${whenHint}`);
      }
    } else {
      endpointCount = Object.keys(data.endpoints).length;
      for (const [, reqs] of Object.entries(data.endpoints)) {
        const req = reqs[0];
        const desc = this.endpointDesc(req.path, req.method);
        const badge = req.verified === true ? " \u2713"
                   : req.fromSpec ? " [from-spec]"
                   : "";
        endpointLines.push(`- \`${req.method} ${req.path}\` \u2014 ${desc}${badge}`);
      }
    }

    // Auth summary
    const authParts: string[] = [];
    if (Object.keys(data.authHeaders).length > 0) {
      authParts.push(`${Object.keys(data.authHeaders).length} auth headers`);
    }
    if (Object.keys(data.cookies).length > 0) {
      authParts.push(`${Object.keys(data.cookies).length} session cookies`);
    }
    const authSummary = authParts.length > 0 ? authParts.join(", ") : "none captured";

    // Extract domain for description
    const domain = new URL(data.baseUrl).hostname;

    // Build a useful description from actual endpoints
    const endpointSummaries: string[] = [];
    for (const [, reqs] of Object.entries(data.endpoints).slice(0, 5)) {
      const req = reqs[0];
      const segments = req.path.split("/").filter(Boolean);
      const lastSegment = segments[segments.length - 1]?.replace(/[{}:]/g, "") || "resource";
      const action = req.method === "GET" ? `get ${lastSegment}` :
                     req.method === "POST" ? `create ${lastSegment}` :
                     req.method === "PUT" || req.method === "PATCH" ? `update ${lastSegment}` :
                     req.method === "DELETE" ? `delete ${lastSegment}` : lastSegment;
      endpointSummaries.push(action);
    }
    const capabilitiesText = endpointSummaries.length > 0
      ? `Capabilities: ${endpointSummaries.join(", ")}.`
      : "";

    return `---
name: ${service}
description: >-
  ${title} API skill for OpenClaw. ${capabilitiesText}
  Service: ${domain}. Auth: ${data.authMethod || "Unknown"}.
metadata:
  author: unbrowse
  version: "1.0"
  versionHash: "PLACEHOLDER"
  baseUrl: "${data.baseUrl}"
  authMethod: "${data.authMethod}"
  endpointCount: ${endpointCount}
  apiType: "internal"
---

# ${title} Internal API

**Type:** Reverse-engineered internal API (unofficial)
**Auth:** ${data.authMethod}
**Base URL:** \`${data.baseUrl}\`
**Captured Auth:** ${authSummary}

## About This Skill

This skill provides access to ${title}'s internal API \u2014 the hidden endpoints that power their web/mobile app.
These are NOT official public APIs. They were captured by observing network traffic while using the site.

**Important:**
- Auth tokens in \`auth.json\` may expire \u2014 re-capture if you get 401 errors
- Internal APIs can change without notice \u2014 endpoints may break
- Rate limits are unknown \u2014 be conservative with request frequency

## When to Use This Skill

Use this skill when you need to:
- Access ${title} data without official API access
- Automate actions on ${domain} (faster than browser automation)
- Call the same endpoints the ${title} frontend uses

## Quick Start

\`\`\`typescript
import { ${className}Client } from "./scripts/api.ts";

// Load captured auth from auth.json
const client = await ${className}Client.fromAuthFile("auth.json");

// Make requests to internal endpoints
const result = await client.get("/endpoint");
\`\`\`

## Captured Authentication

The \`auth.json\` file contains credentials extracted from browser traffic:
- **Auth headers:** ${Object.keys(data.authHeaders).length} (${Object.keys(data.authHeaders).join(", ") || "none"})
- **Session cookies:** ${Object.keys(data.cookies).length}

If auth expires, re-run \`unbrowse_login\` or \`unbrowse_capture\` to refresh tokens.

## Internal Endpoints (${endpointCount})

${endpointLines.join("\n")}

## Error Handling

\`\`\`typescript
try {
  const data = await client.get("/resource");
} catch (err) {
  if (err.message.includes("401")) {
    // Auth expired \u2014 need to re-capture
    console.error("Auth expired, re-run unbrowse_login");
  } else {
    console.error("API error:", err.message);
  }
}
\`\`\`
`;
  }

  /** Generate typed wrapper methods for endpoint groups. */
  private generateTypedWrappers(endpointGroups?: EndpointGroup[]): string {
    if (!endpointGroups || endpointGroups.length === 0) return "";

    const lines: string[] = ["\n  // ── Typed endpoint wrappers ──────────────────────────────────────\n"];
    const usedNames = new Set<string>();

    for (const g of endpointGroups) {
      if (!g.methodName) continue;

      const m = g.method.toUpperCase();
      const hasPathParams = g.pathParams.length > 0;
      const hasBody = m === "POST" || m === "PUT" || m === "PATCH";

      // Build parameter list
      const params: string[] = [];
      for (const p of g.pathParams) {
        params.push(`${p.name}: string`);
      }
      if (hasBody) {
        params.push("body?: Record<string, unknown>");
      }

      // Build the endpoint path with template literals
      let pathExpr: string;
      if (hasPathParams) {
        let p = g.normalizedPath;
        for (const param of g.pathParams) {
          p = p.replace(`{${param.name}}`, `\${${param.name}}`);
        }
        pathExpr = `\`${p}\``;
      } else {
        pathExpr = `"${g.normalizedPath}"`;
      }

      // Deduplicate method names
      let methodName = g.methodName;
      if (usedNames.has(methodName)) {
        let counter = 2;
        while (usedNames.has(`${methodName}${counter}`)) counter++;
        methodName = `${methodName}${counter}`;
      }
      usedNames.add(methodName);

      // Return type hint
      const returnType = "Promise<unknown>";

      // JSDoc
      const schemaHint = g.responseBodySchema ? ` Returns: ${g.responseBodySchema.summary}` : "";
      lines.push(`  /** ${g.description}.${schemaHint} */`);
      lines.push(`  async ${methodName}(${params.join(", ")}): ${returnType} {`);

      if (m === "GET") {
        lines.push(`    return this.get(${pathExpr});`);
      } else if (m === "POST") {
        lines.push(`    return this.post(${pathExpr}${hasBody ? ", { body }" : ""});`);
      } else if (m === "PUT" || m === "PATCH") {
        lines.push(`    return this.put(${pathExpr}${hasBody ? ", { body }" : ""});`);
      } else if (m === "DELETE") {
        lines.push(`    return this.delete(${pathExpr});`);
      }

      lines.push("  }\n");
    }

    return lines.join("\n");
  }

  /** Generate TypeScript API client. */
  generateApiTs(service: string, data: ApiData, endpointGroups?: EndpointGroup[]): string {
    const className = this.toPascalCase(service);
    const primaryAuthHeader = Object.keys(data.authHeaders)[0] ?? "Authorization";
    // Derive a stable skillId from service name (used for proxy routing)
    const skillId = service.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    return `/**
 * ${className} API Client
 * Generated by Unbrowse from HAR capture.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface RequestOptions {
  params?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

interface ProxyOptions {
  proxyUrl?: string;
  proxyApiKey?: string;
  proxyCredentialKey?: string;
  proxySession?: string;
}

export class ${className}Client {
  readonly baseUrl: string;
  readonly skillId: string;
  private authToken?: string;
  private cookies: Record<string, string>;
  private extraHeaders: Record<string, string>;
  private timeout: number;
  private proxyUrl?: string;
  private proxyApiKey?: string;
  private proxyCredentialKey?: string;
  private proxySession?: string;

  constructor(opts: {
    baseUrl?: string;
    authToken?: string;
    cookies?: Record<string, string>;
    extraHeaders?: Record<string, string>;
    timeout?: number;
  } & ProxyOptions = {}) {
    this.baseUrl = opts.baseUrl ?? ${JSON.stringify(data.baseUrl)};
    this.skillId = ${JSON.stringify(skillId)};
    this.authToken = opts.authToken;
    this.cookies = opts.cookies ?? {};
    this.extraHeaders = opts.extraHeaders ?? {};
    this.timeout = opts.timeout ?? 30_000;
    this.proxyUrl = opts.proxyUrl;
    this.proxyApiKey = opts.proxyApiKey;
    this.proxyCredentialKey = opts.proxyCredentialKey;
    this.proxySession = opts.proxySession;
  }

  /** Load auth from auth.json file. */
  static async fromAuthFile(authPath: string, proxyOpts?: ProxyOptions): Promise<${className}Client> {
    if (!existsSync(authPath)) {
      throw new Error(\`Auth file not found: \${authPath}\`);
    }
    const data = JSON.parse(readFileSync(authPath, "utf-8"));
    return new ${className}Client({
      authToken: data.headers?.[${JSON.stringify(primaryAuthHeader)}],
      cookies: data.cookies ?? {},
      extraHeaders: data.headers ?? {},
      ...proxyOpts,
    });
  }

  /** Start a proxy session. Returns the session ID. */
  async startSession(goal?: string): Promise<string> {
    if (!this.proxyUrl) throw new Error("Proxy not configured. Pass proxyUrl to constructor.");
    const resp = await fetch(\`\${this.proxyUrl}/proxy/sessions\`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": \`Bearer \${this.proxyApiKey}\`,
      },
      body: JSON.stringify({ skillId: this.skillId, goalDescription: goal }),
    });
    if (!resp.ok) throw new Error(\`Failed to start proxy session: \${resp.status}\`);
    const result = await resp.json() as any;
    this.proxySession = result.sessionId;
    return result.sessionId;
  }

  /** End the current proxy session. */
  async endSession(): Promise<void> {
    if (!this.proxyUrl || !this.proxySession) return;
    const resp = await fetch(\`\${this.proxyUrl}/proxy/sessions/\${this.proxySession}/complete\`, {
      method: "POST",
      headers: {
        "Authorization": \`Bearer \${this.proxyApiKey}\`,
      },
    });
    if (!resp.ok) throw new Error(\`Failed to end proxy session: \${resp.status}\`);
    this.proxySession = undefined;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders,
    };

    if (this.authToken) {
      headers[${JSON.stringify(primaryAuthHeader)}] = this.authToken;
    }

    if (Object.keys(this.cookies).length > 0) {
      headers["Cookie"] = Object.entries(this.cookies)
        .map(([k, v]) => \`\${k}=\${v}\`)
        .join("; ");
    }

    return headers;
  }

  /**
   * Route request through proxy or directly.
   * When proxy is configured, rewrites URL to proxy endpoint and adds auth headers.
   */
  private async proxyFetch(endpoint: string, init: RequestInit): Promise<Response> {
    if (!this.proxyUrl) {
      // Direct mode: use baseUrl
      const url = new URL(endpoint, this.baseUrl).toString();
      return fetch(url, init);
    }

    // Proxy mode: rewrite URL to proxy endpoint
    const proxyTarget = \`\${this.proxyUrl}/proxy/\${this.skillId}\${endpoint.startsWith("/") ? endpoint : "/" + endpoint}\`;
    const proxyHeaders: Record<string, string> = {
      ...(init.headers as Record<string, string>),
      "Authorization": \`Bearer \${this.proxyApiKey}\`,
    };
    if (this.proxyCredentialKey) {
      proxyHeaders["X-Credential-Key"] = this.proxyCredentialKey;
    }
    if (this.proxySession) {
      proxyHeaders["X-Proxy-Session"] = this.proxySession;
    }

    const resp = await fetch(proxyTarget, { ...init, headers: proxyHeaders });

    // Capture session ID from response for continuity
    const sessionHeader = resp.headers.get("X-Proxy-Session");
    if (sessionHeader) {
      this.proxySession = sessionHeader;
    }

    return resp;
  }

  async get(endpoint: string, opts?: RequestOptions): Promise<unknown> {
    const url = new URL(endpoint, this.baseUrl);
    if (opts?.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        url.searchParams.set(k, v);
      }
    }
    const targetEndpoint = url.pathname + url.search;
    const resp = await this.proxyFetch(this.proxyUrl ? targetEndpoint : url.toString(), {
      method: "GET",
      headers: { ...this.buildHeaders(), ...opts?.headers },
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) throw new Error(\`GET \${endpoint} failed: \${resp.status} \${resp.statusText}\`);
    return resp.json();
  }

  async post(endpoint: string, opts?: RequestOptions): Promise<unknown> {
    const resp = await this.proxyFetch(endpoint, {
      method: "POST",
      headers: { ...this.buildHeaders(), ...opts?.headers },
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) throw new Error(\`POST \${endpoint} failed: \${resp.status} \${resp.statusText}\`);
    return resp.json();
  }

  async put(endpoint: string, opts?: RequestOptions): Promise<unknown> {
    const resp = await this.proxyFetch(endpoint, {
      method: "PUT",
      headers: { ...this.buildHeaders(), ...opts?.headers },
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) throw new Error(\`PUT \${endpoint} failed: \${resp.status} \${resp.statusText}\`);
    return resp.json();
  }

  async delete(endpoint: string, opts?: RequestOptions): Promise<unknown> {
    const resp = await this.proxyFetch(endpoint, {
      method: "DELETE",
      headers: { ...this.buildHeaders(), ...opts?.headers },
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) throw new Error(\`DELETE \${endpoint} failed: \${resp.status} \${resp.statusText}\`);
    return resp.json();
  }
${this.generateTypedWrappers(endpointGroups)}}

// Auth method: ${data.authMethod}
`;
  }

  /** Generate REFERENCE.md with detailed endpoint documentation. */
  generateReferenceMd(service: string, data: ApiData, endpointGroups?: EndpointGroup[]): string {
    const title = service.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    const sections: string[] = [];

    if (endpointGroups && endpointGroups.length > 0) {
      for (const g of endpointGroups) {
        let section = `### ${g.method} ${g.normalizedPath}\n\n`;
        section += `**Description:** ${g.description}\n`;
        if (g.whenToUse) section += `**When to use:** ${g.whenToUse}\n`;
        if (g.methodName) section += `**Method:** \`client.${g.methodName}()\`\n`;
        section += `**Category:** ${g.category}\n\n`;

        if (g.pathParams.length > 0) {
          section += "**Path Parameters:**\n";
          for (const p of g.pathParams) {
            const hint = g.paramHints?.[p.name];
            const desc = hint ? ` ${hint}` : ` e.g. \`${p.example}\``;
            section += `- \`${p.name}\` (${p.type}) \u2014${desc}\n`;
          }
          section += "\n";
        }

        if (g.queryParams.length > 0) {
          section += "**Query Parameters:**\n";
          for (const p of g.queryParams) {
            const hint = g.paramHints?.[p.name];
            const desc = hint ? ` ${hint}` : ` e.g. \`${p.example}\``;
            section += `- \`${p.name}\` (${p.type}) \u2014${desc}\n`;
          }
          section += "\n";
        }

        if (g.requestBodySchema) {
          section += `**Request Body:** ${g.requestBodySchema.summary}\n`;
          const fields = Object.entries(g.requestBodySchema.fields).slice(0, 8);
          if (fields.length > 0) {
            section += "| Field | Type |\n|-------|------|\n";
            for (const [k, v] of fields) section += `| ${k} | ${v} |\n`;
            section += "\n";
          }
        }

        if (g.responseBodySchema) {
          section += `**Response:** ${g.responseBodySchema.summary}\n`;
          const fields = Object.entries(g.responseBodySchema.fields).slice(0, 8);
          if (fields.length > 0) {
            section += "| Field | Type |\n|-------|------|\n";
            for (const [k, v] of fields) section += `| ${k} | ${v} |\n`;
            section += "\n";
          }
        }

        // Example using typed wrapper
        if (g.methodName) {
          section += `**Example:**\n\`\`\`typescript\nconst result = await client.${g.methodName}(${g.pathParams.map(p => `"${p.example}"`).join(", ")});\n\`\`\`\n\n`;
        }

        sections.push(section);
      }

      return `# ${title} API Reference

Detailed documentation for all ${endpointGroups.length} endpoints.

**Base URL:** \`${data.baseUrl}\`
**Auth Method:** ${data.authMethod}

---

## Endpoints

${sections.join("\n---\n\n")}
`;
    }

    // Fallback to raw endpoints
    for (const [, reqs] of Object.entries(data.endpoints)) {
      const req = reqs[0];
      const statusBadge = req.verified === true ? "\u2713 Verified"
                        : req.fromSpec ? "From OpenAPI"
                        : "Observed";

      let section = `### ${req.method} ${req.path}\n\n`;
      section += `**Status:** ${statusBadge}\n`;
      section += `**HTTP Status:** ${req.status}\n\n`;

      if (req.method === "GET") {
        section += `**Example:**\n\`\`\`typescript\nconst result = await client.get("${req.path}");\n\`\`\`\n\n`;
      } else if (req.method === "POST") {
        section += `**Example:**\n\`\`\`typescript\nconst result = await client.post("${req.path}", { body: { /* data */ } });\n\`\`\`\n\n`;
      } else if (req.method === "PUT") {
        section += `**Example:**\n\`\`\`typescript\nconst result = await client.put("${req.path}", { body: { /* data */ } });\n\`\`\`\n\n`;
      } else if (req.method === "DELETE") {
        section += `**Example:**\n\`\`\`typescript\nconst result = await client.delete("${req.path}");\n\`\`\`\n\n`;
      }

      sections.push(section);
    }

    return `# ${title} API Reference

Detailed documentation for all ${Object.keys(data.endpoints).length} endpoints.

**Base URL:** \`${data.baseUrl}\`
**Auth Method:** ${data.authMethod}

---

## Endpoints

${sections.join("\n---\n\n")}
`;
  }

  /** Generate test file. */
  generateTestTs(service: string, data: ApiData): string {
    const className = this.toPascalCase(service);

    const sampleEndpoints = Object.entries(data.endpoints)
      .slice(0, 5)
      .map(([, reqs]) => {
        const req = reqs[0];
        return `  "${req.method}: ${req.path}",`;
      })
      .join("\n");

    return `#!/usr/bin/env -S node --loader ts-node/esm
/**
 * Test ${className} API Client
 * Generated by Unbrowse.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { ${className}Client } from "./scripts/api.ts";

async function testApi() {
  // Load auth
  const authPath = join(dirname(new URL(import.meta.url).pathname), "auth.json");
  let client: ${className}Client;

  if (existsSync(authPath)) {
    console.log("Loaded auth from auth.json");
    client = await ${className}Client.fromAuthFile(authPath);
  } else {
    const apiKey = process.env.${service.toUpperCase().replace(/-/g, "_")}_API_KEY;
    if (!apiKey) {
      console.log("No auth found! Set ${service.toUpperCase().replace(/-/g, "_")}_API_KEY or create auth.json");
      process.exit(1);
    }
    client = new ${className}Client({ authToken: apiKey });
  }

  console.log("\\nTesting ${className} API");
  console.log("Base URL: ${data.baseUrl}");
  console.log("Auth: ${data.authMethod}\\n");

  const endpoints = [
${sampleEndpoints}
  ];

  let passed = 0;
  let failed = 0;

  for (const endpoint of endpoints) {
    const [method, path] = endpoint.split(": ");
    console.log(\`  Testing \${method} \${path}...\`);
    try {
      if (method === "GET") {
        await client.get(path);
        console.log("  OK");
        passed++;
      } else if (method === "POST") {
        await client.post(path, { body: {} });
        console.log("  OK");
        passed++;
      } else {
        console.log(\`  SKIPPED (\${method})\`);
      }
    } catch (err) {
      console.log(\`  FAILED: \${String(err).slice(0, 100)}\`);
      failed++;
    }
  }

  console.log(\`\\nResults: \${passed} passed, \${failed} failed\\n\`);
  return failed === 0;
}

testApi().then((ok) => process.exit(ok ? 0 : 1));
`;
  }
}

// ---------------------------------------------------------------------------
// SkillGenerator — top-level orchestrator
// ---------------------------------------------------------------------------

export class SkillGenerator {
  readonly versionHasher = new VersionHasher();
  readonly diffCalculator = new SkillDiffCalculator();
  readonly endpointMerger = new EndpointMerger(this.diffCalculator);
  readonly fileWriter = new SkillFileWriter();

  /**
   * Generate a complete skill package from parsed API data.
   *
   * Creates the skill directory with SKILL.md, auth.json, scripts/api.ts,
   * and test.ts. Credentials are also stored in the encrypted vault if available.
   *
   * IMPORTANT: Merges new endpoints with existing ones - never loses endpoints.
   */
  async generate(
    data: ApiData,
    outputDir?: string,
    meta?: {
      verifiedEndpoints?: number;
      unverifiedEndpoints?: number;
      openApiSource?: string | null;
      pagesCrawled?: number;
      llmApiKey?: string;
    },
  ): Promise<SkillResult> {
    const service = data.service;
    const resolvedOutputDir = outputDir ? resolve(outputDir) : join(homedir(), ".openclaw", "skills");

    // Prevent nested directories
    const outputBasename = basename(resolvedOutputDir);
    const skillDir = outputBasename === service ? resolvedOutputDir : join(resolvedOutputDir, service);

    // agentskills.io standard directories
    const scriptsDir = join(skillDir, "scripts");
    const referencesDir = join(skillDir, "references");

    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(referencesDir, { recursive: true });

    // Merge existing endpoints
    const skillMdPath = join(skillDir, "SKILL.md");
    const oldEndpointCount = this.endpointMerger.mergeExisting(data, skillMdPath);

    // Enrich endpoints with LLM-generated descriptions (if API key available)
    const groups = data.endpointGroups;
    if (groups && groups.length > 0) {
      await enrichEndpointDescriptions(service, data.baseUrl, groups, {
        apiKey: meta?.llmApiKey,
      });
    }

    // Generate content
    const authJson = this.fileWriter.generateAuthJson(service, data);
    let skillMd = this.fileWriter.generateSkillMd(service, data, groups);
    const apiTs = this.fileWriter.generateApiTs(service, data, groups);
    const testTs = this.fileWriter.generateTestTs(service, data);
    const referenceMd = this.fileWriter.generateReferenceMd(service, data, groups);

    // Compute version hash
    const scripts = { "api.ts": apiTs };
    const references = { "REFERENCE.md": referenceMd };
    const versionHash = this.versionHasher.hash(
      skillMd.replace(/versionHash: "PLACEHOLDER"/, ""),
      scripts,
      references,
    );

    // Replace placeholder with actual hash
    skillMd = skillMd.replace(/versionHash: "PLACEHOLDER"/, `versionHash: "${versionHash}"`);

    // Diff calculation
    const newEndpointCount = Object.keys(data.endpoints).length;
    const oldSkillMd = oldEndpointCount > 0 && existsSync(skillMdPath)
      ? readFileSync(skillMdPath, "utf-8")
      : undefined;
    const { changed, diff } = this.diffCalculator.computeDiff(
      oldEndpointCount,
      newEndpointCount,
      oldSkillMd,
      skillMd,
    );

    // Write files — only overwrite if content changed
    if (changed) {
      writeFileSync(skillMdPath, skillMd, "utf-8");
      writeFileSync(join(scriptsDir, "api.ts"), apiTs, "utf-8");
      writeFileSync(join(skillDir, "test.ts"), testTs, "utf-8");
      writeFileSync(join(referencesDir, "REFERENCE.md"), referenceMd, "utf-8");
    }
    // auth.json always overwritten — may contain fresh tokens
    writeFileSync(join(skillDir, "auth.json"), authJson, "utf-8");

    // Store credentials in encrypted vault (best-effort)
    try {
      const { Vault } = await import("./vault.js");
      const vault = new Vault();
      vault.store(service, {
        baseUrl: data.baseUrl,
        authMethod: data.authMethod,
        headers: Object.keys(data.authHeaders).length > 0 ? data.authHeaders : undefined,
        cookies: Object.keys(data.cookies).length > 0 ? data.cookies : undefined,
        extra: Object.keys(data.authInfo).length > 0
          ? Object.fromEntries(Object.entries(data.authInfo).slice(0, 20))
          : undefined,
      });
      vault.close();
    } catch {
      // Vault not available — that's fine, auth.json still written
    }

    return {
      skillFile: join(skillDir, `${service}.skill`),
      skillDir,
      service,
      authMethod: data.authMethod,
      endpointCount: Object.keys(data.endpoints).length,
      authHeaderCount: Object.keys(data.authHeaders).length,
      cookieCount: Object.keys(data.cookies).length,
      verifiedEndpoints: meta?.verifiedEndpoints,
      unverifiedEndpoints: meta?.unverifiedEndpoints,
      openApiSource: meta?.openApiSource,
      pagesCrawled: meta?.pagesCrawled,
      changed,
      diff,
      versionHash,
    };
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible function exports
// ---------------------------------------------------------------------------

const _defaultGenerator = new SkillGenerator();

/**
 * Generate SHA-256 hash for version fingerprinting.
 * Returns first 8 characters of the hash.
 */
export function generateVersionHash(
  skillMd: string,
  scripts: Record<string, string>,
  references: Record<string, string>,
): string {
  return _defaultGenerator.versionHasher.hash(skillMd, scripts, references);
}

/**
 * Extract version info from SKILL.md frontmatter.
 */
export function extractVersionInfo(skillMd: string): { version?: string; versionHash?: string } {
  return _defaultGenerator.versionHasher.extractVersionInfo(skillMd);
}

/**
 * Generate a complete skill package from parsed API data.
 *
 * Creates the skill directory with SKILL.md, auth.json, scripts/api.ts,
 * and test.ts. Credentials are also stored in the encrypted vault if available.
 *
 * IMPORTANT: Merges new endpoints with existing ones - never loses endpoints.
 */
export async function generateSkill(
  data: ApiData,
  outputDir?: string,
  meta?: {
    verifiedEndpoints?: number;
    unverifiedEndpoints?: number;
    openApiSource?: string | null;
    pagesCrawled?: number;
    llmApiKey?: string;
  },
): Promise<SkillResult> {
  return _defaultGenerator.generate(data, outputDir, meta);
}
