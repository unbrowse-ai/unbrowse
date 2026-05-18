// SKILL.md export — agentskills.io format. Renders a SkillManifest as a
// SKILL.md file with YAML frontmatter + body. Body is unbrowse-runtime-bound:
// every endpoint shows the `unbrowse execute` command, not raw curl. The
// installed skill REQUIRES unbrowse to run; skills.sh becomes pure discovery.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SkillManifest, EndpointDescriptor } from "./types/skill.js";
import { sanitizeDomain } from "./extraction/domain-notes.js";

function escapeYaml(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

function endpointTitle(ep: EndpointDescriptor): string {
  if (ep.description) return ep.description.split(/[.\n]/)[0].slice(0, 100);
  if ((ep as any).semantic?.summary) return (ep as any).semantic.summary.slice(0, 100);
  if (ep.graphql_info?.operation_name) return `GraphQL: ${ep.graphql_info.operation_name}`;
  try {
    const u = new URL(ep.url_template);
    return `${ep.method} ${u.pathname}`;
  } catch { return `${ep.method} ${ep.url_template}`; }
}

function renderEndpointSection(ep: EndpointDescriptor, skill: SkillManifest): string {
  const title = endpointTitle(ep);
  const lines: string[] = [];
  lines.push(`### ${title}`);
  lines.push("");
  lines.push(`- **Method**: \`${ep.method}\``);
  lines.push(`- **URL**: \`${ep.url_template}\``);
  lines.push(`- **Endpoint ID**: \`${ep.endpoint_id}\``);
  if (ep.idempotency) lines.push(`- **Idempotency**: ${ep.idempotency}`);
  if (ep.verification_status) lines.push(`- **Verified**: ${ep.verification_status} (reliability ${(ep.reliability_score ?? 0).toFixed(2)})`);
  if ((ep.response_schema as any)?.sample_field_names?.length) {
    lines.push(`- **Response fields**: ${(ep.response_schema as any).sample_field_names.slice(0, 12).map((f: string) => `\`${f}\``).join(", ")}`);
  }
  if ((ep as any).semantic?.requires?.length) {
    lines.push(`- **Requires**: ${(ep as any).semantic.requires.map((r: any) => `\`${r.name ?? r}\``).join(", ")}`);
  }
  if ((ep as any).semantic?.yields?.length) {
    lines.push(`- **Yields**: ${(ep as any).semantic.yields.map((y: any) => `\`${y.name ?? y}\``).join(", ")}`);
  }
  lines.push("");
  lines.push("**Call it via unbrowse:**");
  lines.push("");
  lines.push("```bash");
  lines.push(`unbrowse execute --skill ${skill.skill_id} --endpoint ${ep.endpoint_id}`);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

export function renderSkillMd(skill: SkillManifest): string {
  const intents = Array.from(new Set([skill.intent_signature, ...(skill.intents ?? [])])).filter(Boolean);
  const endpoints = skill.endpoints ?? [];

  const fm: string[] = [
    "---",
    `name: ${escapeYaml(`unbrowse-${skill.domain}`)}`,
    `description: ${escapeYaml(skill.description || `${skill.domain} API skill (${endpoints.length} endpoints, indexed via unbrowse)`)}`,
    `runtime: unbrowse`,
    `requires: ["unbrowse@>=6.7.0"]`,
    `domain: ${escapeYaml(skill.domain)}`,
    `skill_id: ${escapeYaml(skill.skill_id)}`,
    `intent_signature: ${escapeYaml(skill.intent_signature)}`,
    `intents:`,
    ...intents.map((i) => `  - ${escapeYaml(i)}`),
    `endpoint_count: ${endpoints.length}`,
    `version: ${escapeYaml(skill.version)}`,
    `updated_at: ${escapeYaml(skill.updated_at)}`,
    "---",
    "",
  ];

  const body: string[] = [];
  body.push(`# ${skill.name}`);
  body.push("");
  body.push(skill.description || `Indexed API skill for ${skill.domain}.`);
  body.push("");
  body.push("## Prerequisite");
  body.push("");
  body.push("This skill is executed through the **unbrowse** runtime. Install once:");
  body.push("");
  body.push("```bash");
  body.push("npx unbrowse@latest setup");
  body.push("```");
  body.push("");
  body.push("unbrowse handles auth (browser cookies + JA4 TLS impersonation), caching, and the marketplace publish flywheel for every call. Direct curl will be blocked by anti-bot on most of these endpoints.");
  body.push("");
  body.push("## Quick start");
  body.push("");
  body.push("```bash");
  body.push(`unbrowse resolve "${skill.intent_signature}"`);
  body.push("```");
  body.push("");
  body.push("`resolve` returns a ranked shortlist; the agent picks an endpoint and calls execute.");
  body.push("");
  body.push(`## Endpoints (${endpoints.length})`);
  body.push("");

  for (const ep of endpoints) {
    body.push(renderEndpointSection(ep, skill));
  }

  body.push("## Why this needs unbrowse");
  body.push("");
  body.push("- **Auth**: most of these endpoints require session cookies. `unbrowse execute` pulls them from your real browser (Chrome/Arc/Brave/Edge/Vivaldi/Opera/Dia) and injects them.");
  body.push("- **TLS impersonation**: requests go through libcurl-impersonate with a Chrome 131 JA4 fingerprint. Anti-bot vendors (Cloudflare, PerimeterX, Datadome, Akamai) reject the default Node/Python TLS fingerprints.");
  body.push("- **Cache + flywheel**: every execute hits the marketplace cache first, then back-fills observed routes if the call goes through.");
  body.push("");
  body.push("---");
  body.push(`*Generated from observed routes by unbrowse v${skill.version}. Skill ID: \`${skill.skill_id}\`.*`);
  body.push("");

  return fm.join("\n") + body.join("\n");
}

export function exportSkillMdLocal(skill: SkillManifest): string | null {
  try {
    // SECURITY: skill.domain is publisher-controlled. A malicious manifest
    // with `domain: "../../../.ssh/authorized_keys.d"` would write attacker
    // content under ~/.ssh/. sanitizeDomain rejects path separators, ..,
    // control chars, and anything outside the RFC1035 charset.
    const safeDomain = sanitizeDomain(skill.domain);
    const base = resolve(join(homedir(), ".unbrowse", "skills"));
    const dir = resolve(join(base, safeDomain));
    if (!dir.startsWith(base + "/") && dir !== base) {
      throw new Error("skill_export_path_escape");
    }
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    const content = renderSkillMd(skill);
    writeFileSync(path, content);
    return path;
  } catch (e) {
    console.warn(`[skillmd] export failed: ${(e as Error).message}`);
    return null;
  }
}
