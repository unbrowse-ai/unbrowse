/**
 * Skill Generator — Generate SKILL.md, auth.json, api.ts, and test files.
 *
 * Ported from meta_learner_simple.py generate_skill_md(), generate_auth_py(),
 * generate_test_py(), generate_skill(). Outputs TypeScript instead of Python.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import type { ApiData, AuthInfo, SkillResult } from "./types.js";
import { generateAuthInfo } from "./auth-extractor.js";
import { generateSkillDescription } from "./description-generator.js";

/** PascalCase from kebab-case. */
function toPascalCase(s: string): string {
  return s.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/** Get a human-readable endpoint description. */
function endpointDesc(path: string, method: string): string {
  if (method === "GET") {
    return path.match(/\/\{|\/:/) ? "Get resource" : "List resources";
  }
  if (method === "POST") return "Create resource";
  if (method === "PUT" || method === "PATCH") return "Update resource";
  if (method === "DELETE") return "Delete resource";
  return "Endpoint";
}

/** Generate auth.json content. */
function generateAuthJson(service: string, data: ApiData): string {
  const auth = generateAuthInfo(service, data);
  return JSON.stringify(auth, null, 2);
}

/** Generate SKILL.md content following agentskills.io specification. */
async function generateSkillMd(service: string, data: ApiData): Promise<string> {
  const className = toPascalCase(service);
  const title = service.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const endpointCount = Object.keys(data.endpoints).length;

  const endpointLines: string[] = [];
  for (const [, reqs] of Object.entries(data.endpoints)) {
    const req = reqs[0];
    const desc = endpointDesc(req.path, req.method);
    const badge = req.verified === true ? " ✓"
               : req.fromSpec ? " [from-spec]"
               : "";
    endpointLines.push(`- \`${req.method} ${req.path}\` — ${desc}${badge}`);
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

  // Generate description using LLM (falls back to template if unavailable)
  const { description } = await generateSkillDescription(service, data);

  // agentskills.io compliant YAML frontmatter
  return `---
name: ${service}
description: >-
  ${description}
metadata:
  author: unbrowse
  version: "1.0"
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

This skill provides access to ${title}'s internal API — the hidden endpoints that power their web/mobile app.
These are NOT official public APIs. They were captured by observing network traffic while using the site.

**Important:**
- Auth tokens in \`auth.json\` may expire — re-capture if you get 401 errors
- Internal APIs can change without notice — endpoints may break
- Rate limits are unknown — be conservative with request frequency

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
    // Auth expired — need to re-capture
    console.error("Auth expired, re-run unbrowse_login");
  } else {
    console.error("API error:", err.message);
  }
}
\`\`\`
`;
}

/** Generate TypeScript API client. */
function generateApiTs(service: string, data: ApiData): string {
  const className = toPascalCase(service);
  const primaryAuthHeader = Object.keys(data.authHeaders)[0] ?? "Authorization";

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

export class ${className}Client {
  readonly baseUrl: string;
  private authToken?: string;
  private cookies: Record<string, string>;
  private extraHeaders: Record<string, string>;
  private timeout: number;

  constructor(opts: {
    baseUrl?: string;
    authToken?: string;
    cookies?: Record<string, string>;
    extraHeaders?: Record<string, string>;
    timeout?: number;
  } = {}) {
    this.baseUrl = opts.baseUrl ?? ${JSON.stringify(data.baseUrl)};
    this.authToken = opts.authToken;
    this.cookies = opts.cookies ?? {};
    this.extraHeaders = opts.extraHeaders ?? {};
    this.timeout = opts.timeout ?? 30_000;
  }

  /** Load auth from auth.json file. */
  static async fromAuthFile(authPath: string): Promise<${className}Client> {
    if (!existsSync(authPath)) {
      throw new Error(\`Auth file not found: \${authPath}\`);
    }
    const data = JSON.parse(readFileSync(authPath, "utf-8"));
    return new ${className}Client({
      authToken: data.headers?.[${JSON.stringify(primaryAuthHeader)}],
      cookies: data.cookies ?? {},
      extraHeaders: data.headers ?? {},
    });
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

  async get(endpoint: string, opts?: RequestOptions): Promise<unknown> {
    const url = new URL(endpoint, this.baseUrl);
    if (opts?.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        url.searchParams.set(k, v);
      }
    }
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers: { ...this.buildHeaders(), ...opts?.headers },
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) throw new Error(\`GET \${endpoint} failed: \${resp.status} \${resp.statusText}\`);
    return resp.json();
  }

  async post(endpoint: string, opts?: RequestOptions): Promise<unknown> {
    const resp = await fetch(new URL(endpoint, this.baseUrl).toString(), {
      method: "POST",
      headers: { ...this.buildHeaders(), ...opts?.headers },
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) throw new Error(\`POST \${endpoint} failed: \${resp.status} \${resp.statusText}\`);
    return resp.json();
  }

  async put(endpoint: string, opts?: RequestOptions): Promise<unknown> {
    const resp = await fetch(new URL(endpoint, this.baseUrl).toString(), {
      method: "PUT",
      headers: { ...this.buildHeaders(), ...opts?.headers },
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) throw new Error(\`PUT \${endpoint} failed: \${resp.status} \${resp.statusText}\`);
    return resp.json();
  }

  async delete(endpoint: string, opts?: RequestOptions): Promise<unknown> {
    const resp = await fetch(new URL(endpoint, this.baseUrl).toString(), {
      method: "DELETE",
      headers: { ...this.buildHeaders(), ...opts?.headers },
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!resp.ok) throw new Error(\`DELETE \${endpoint} failed: \${resp.status} \${resp.statusText}\`);
    return resp.json();
  }
}

// Auth method: ${data.authMethod}
`;
}

/** Generate REFERENCE.md with detailed endpoint documentation. */
function generateReferenceMd(service: string, data: ApiData): string {
  const title = service.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const sections: string[] = [];
  for (const [, reqs] of Object.entries(data.endpoints)) {
    const req = reqs[0];
    const statusBadge = req.verified === true ? "✓ Verified"
                      : req.fromSpec ? "From OpenAPI"
                      : "Observed";

    let section = `### ${req.method} ${req.path}\n\n`;
    section += `**Status:** ${statusBadge}\n`;
    section += `**HTTP Status:** ${req.status}\n\n`;

    // Add usage example
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
function generateTestTs(service: string, data: ApiData): string {
  const className = toPascalCase(service);

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

/**
 * Parse existing SKILL.md to extract endpoint keys (METHOD /path).
 */
function parseExistingEndpoints(skillMd: string): Set<string> {
  const endpoints = new Set<string>();
  const regex = /^- `(GET|POST|PUT|DELETE|PATCH)\s+([^`]+)`/gm;
  let match;
  while ((match = regex.exec(skillMd)) !== null) {
    endpoints.add(`${match[1]} ${match[2]}`);
  }
  return endpoints;
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
  },
): Promise<SkillResult> {
  const service = data.service;
  const resolvedOutputDir = outputDir ? resolve(outputDir) : join(homedir(), ".openclaw", "skills");

  // Prevent nested directories like skills/bags-fm/bags-fm when outputDir
  // already ends with the service name (e.g. user passed outputDir="/...skills/bags-fm")
  const outputBasename = basename(resolvedOutputDir);
  const skillDir = outputBasename === service ? resolvedOutputDir : join(resolvedOutputDir, service);

  // agentskills.io standard directories
  const scriptsDir = join(skillDir, "scripts");      // Executable code
  const referencesDir = join(skillDir, "references"); // Additional documentation

  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(referencesDir, { recursive: true });

  // Load existing skill to merge endpoints (never lose previously discovered endpoints)
  const skillMdPath = join(skillDir, "SKILL.md");
  let existingEndpoints = new Set<string>();
  let oldEndpointCount = 0;

  if (existsSync(skillMdPath)) {
    const oldSkillMd = readFileSync(skillMdPath, "utf-8");
    existingEndpoints = parseExistingEndpoints(oldSkillMd);
    oldEndpointCount = existingEndpoints.size;

    // Merge: add existing endpoints that aren't in the new data
    for (const epKey of existingEndpoints) {
      const [method, ...pathParts] = epKey.split(" ");
      const path = pathParts.join(" "); // Handle paths with spaces
      if (!data.endpoints[epKey]) {
        // Add back the existing endpoint that wasn't captured this session
        data.endpoints[epKey] = [{
          method,
          path,
          url: data.baseUrl + path,
          domain: new URL(data.baseUrl).hostname,
          status: 200, // Assume it worked before
          fromSpec: false,
          verified: undefined, // Mark as unverified since it's from history
        }];
      }
    }
  }

  // Generate content with merged endpoints
  const authJson = generateAuthJson(service, data);
  const skillMd = await generateSkillMd(service, data);
  const apiTs = generateApiTs(service, data);
  const testTs = generateTestTs(service, data);
  const referenceMd = generateReferenceMd(service, data);

  // Diff: count how many NEW endpoints were added
  const newEndpointCount = Object.keys(data.endpoints).length;
  let changed = true;
  let diff: string | null = null;

  if (oldEndpointCount > 0) {
    if (newEndpointCount === oldEndpointCount) {
      // Check if content actually changed
      const oldSkillMd = readFileSync(skillMdPath, "utf-8");
      changed = oldSkillMd !== skillMd;
    }
    const added = newEndpointCount - oldEndpointCount;
    if (added > 0) {
      diff = `+${added} new endpoint(s) (${oldEndpointCount} → ${newEndpointCount})`;
    } else if (changed) {
      diff = `Updated (${newEndpointCount} endpoints)`;
    }
  }

  // Write files — only overwrite SKILL.md + api.ts + test.ts if content changed
  if (changed) {
    writeFileSync(skillMdPath, skillMd, "utf-8");
    writeFileSync(join(scriptsDir, "api.ts"), apiTs, "utf-8");
    writeFileSync(join(skillDir, "test.ts"), testTs, "utf-8");
    writeFileSync(join(referencesDir, "REFERENCE.md"), referenceMd, "utf-8");
  }
  // auth.json always overwritten — may contain fresh tokens
  writeFileSync(join(skillDir, "auth.json"), authJson, "utf-8");

  // Store credentials in encrypted vault (best-effort — vault may not be set up)
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
  };
}
