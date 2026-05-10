// Workers-side SKILL.md renderer. Mirror of src/skillmd.ts but with no Node
// filesystem deps (Workers don't have fs). Keep field-for-field identical so
// `unbrowse.ai/<domain>` and the locally-exported SKILL.md don't drift.

import type { SkillManifest, EndpointDescriptor } from "../types.js";

function escapeYaml(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

function endpointTitle(ep: EndpointDescriptor): string {
  if (ep.description) return ep.description.split(/[.\n]/)[0].slice(0, 100);
  const sem = (ep as unknown as { semantic?: { summary?: string } }).semantic;
  if (sem?.summary) return sem.summary.slice(0, 100);
  if (ep.graphql_info?.operation_name) return `GraphQL: ${ep.graphql_info.operation_name}`;
  try { const u = new URL(ep.url_template); return `${ep.method} ${u.pathname}`; }
  catch { return `${ep.method} ${ep.url_template}`; }
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
  const schema = ep.response_schema as unknown as { sample_field_names?: string[] } | undefined;
  if (schema?.sample_field_names?.length) {
    lines.push(`- **Response fields**: ${schema.sample_field_names.slice(0, 12).map((f) => `\`${f}\``).join(", ")}`);
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
  const intents = Array.from(new Set([skill.intent_signature, ...((skill.intents ?? []) as string[])])).filter(Boolean);
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
  ];

  // Surface who published the skill so consumers can see who claimed the
  // domain. owner_agent_id is server-set on first non-admin publish; older
  // skills fall back to indexer_id (the attribution field). Domain
  // verification status, when present, is also surfaced — false / missing
  // means the publisher hasn't completed the .well-known probe.
  const publisherId = skill.owner_agent_id ?? skill.indexer_id;
  if (publisherId) {
    fm.push(`publisher_agent_id: ${escapeYaml(publisherId)}`);
  }
  if (typeof skill.domain_verified === "boolean") {
    fm.push(`domain_verified: ${skill.domain_verified}`);
    if (skill.domain_verified_at) {
      fm.push(`domain_verified_at: ${escapeYaml(skill.domain_verified_at)}`);
    }
  }
  fm.push("---");
  fm.push("");

  const body: string[] = [];
  body.push(`# ${skill.name}`);
  body.push("");
  body.push(skill.description || `Indexed API skill for ${skill.domain}.`);
  body.push("");

  // Publisher + verification provenance, rendered as a block agents and humans
  // can read at a glance. We surface the publisher's agent_id (truncated for
  // readability) and the domain-verification status; no proof status here —
  // that lives in the per-endpoint section per the SKILL.md trust boundary.
  if (publisherId || typeof skill.domain_verified === "boolean") {
    body.push("## Provenance");
    body.push("");
    if (publisherId) {
      const short = publisherId.length > 16 ? `${publisherId.slice(0, 12)}…` : publisherId;
      body.push(`- **Publisher**: \`${short}\``);
    }
    if (typeof skill.domain_verified === "boolean") {
      const verifyLabel = skill.domain_verified ? "✓ verified" : "not verified";
      const when = skill.domain_verified && skill.domain_verified_at
        ? ` (${skill.domain_verified_at.slice(0, 10)})`
        : "";
      body.push(`- **Domain control**: ${verifyLabel}${when} — \`/.well-known/unbrowse-verify-*\` HTTP probe`);
    }
    body.push("");
  }

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
  for (const ep of endpoints) body.push(renderEndpointSection(ep, skill));

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

export function renderEmptyDomainMarkdown(domain: string): string {
  return [
    "---",
    `name: "unbrowse-${domain}"`,
    `description: "${domain} has not been indexed yet. Use unbrowse to seed it."`,
    `runtime: unbrowse`,
    `requires: ["unbrowse@>=6.7.0"]`,
    `domain: "${domain}"`,
    `endpoint_count: 0`,
    "---",
    "",
    `# ${domain} — not indexed yet`,
    "",
    `Unbrowse hasn't indexed any API endpoints for **${domain}** yet. To seed it, install unbrowse and fetch any page on the domain once — every call is observed, filtered, and published as a SKILL.md.`,
    "",
    "## Install + seed in one step",
    "",
    "```bash",
    "npx unbrowse@latest setup",
    `unbrowse fetch https://${domain}`,
    "```",
    "",
    `Re-load this URL afterwards and you'll get the SKILL.md for ${domain}.`,
    "",
    "## How indexing works",
    "",
    "When you `unbrowse fetch` a page, the runtime:",
    "1. Pulls your browser cookies for that domain (if logged in)",
    "2. Replays the page in a sandboxed JS environment with Chrome 131 JA4 TLS impersonation",
    "3. Records every API call the page's own JS makes (no scraping — these are the site's own endpoints)",
    "4. Filters noise and publishes verified endpoints to the unbrowse marketplace",
    "",
    "Every domain you fetch grows the shared index. Other agents calling unbrowse get instant cached responses for endpoints you've already discovered.",
    "",
    "---",
    "*This response is dynamic. Once unbrowse indexes routes for this domain, `unbrowse.ai/" + domain + "` returns the full SKILL.md.*",
    "",
  ].join("\n");
}
