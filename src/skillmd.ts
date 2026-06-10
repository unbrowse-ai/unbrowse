// SKILL.md export — agentskills.io format. Renders a SkillManifest as a
// SKILL.md file with YAML frontmatter + body. Body is unbrowse-runtime-bound:
// every endpoint shows the `unbrowse execute` command, not raw curl. The
// installed skill REQUIRES unbrowse to run; skills.sh becomes pure discovery.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SkillManifest, EndpointDescriptor } from "./types/skill.js";
import type { Hole } from "./capture/hole-template.js";
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

/** Extract response field names from a captured response_schema. Handles the
 * JSON-Schema shape actually stored (object → properties, array → items.properties)
 * plus a legacy sample_field_names fallback. Returns [] when none are known. */
function responseFields(rs: any): string[] {
  if (!rs || typeof rs !== "object") return [];
  if (Array.isArray(rs.sample_field_names) && rs.sample_field_names.length) return rs.sample_field_names;
  const node = rs.type === "array" && rs.items && typeof rs.items === "object" ? rs.items : rs;
  if (node.properties && typeof node.properties === "object") return Object.keys(node.properties);
  return [];
}

/** Render one call parameter as `name` (source[, required]) — source from the
 * captured semantic shape so an agent knows where the value goes. */
function renderParam(r: any): string {
  const name = r?.key ?? r?.name ?? r;
  const srcMap: Record<string, string> = {
    path_params: "path", path: "path",
    query_params: "query", query: "query",
    body_params: "body", body: "body",
    header: "header", headers: "header",
  };
  const src = typeof r?.source === "string" ? (srcMap[r.source] ?? r.source) : undefined;
  const annots = [src, r?.required === true ? "required" : undefined].filter(Boolean);
  return annots.length ? `\`${name}\` (${annots.join(", ")})` : `\`${name}\``;
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
  const respFields = responseFields(ep.response_schema);
  if (respFields.length) {
    lines.push(`- **Response fields**: ${respFields.slice(0, 12).map((f) => `\`${f}\``).join(", ")}`);
  }
  if ((ep as any).semantic?.requires?.length) {
    // These are call PARAMETERS (path/query/body) the agent supplies — distinct
    // from the Credentials section (filled locally). Label the source so an agent
    // reading the skill knows where each value goes.
    lines.push(`- **Parameters**: ${(ep as any).semantic.requires.map((r: any) => renderParam(r)).join(", ")}`);
  }
  if ((ep as any).semantic?.yields?.length) {
    lines.push(`- **Returns**: ${(ep as any).semantic.yields.map((y: any) => `\`${y?.key ?? y?.name ?? y}\``).join(", ")}`);
  }
  lines.push("");
  lines.push("**Call it via unbrowse:**");
  lines.push("");
  lines.push("```bash");
  // Show a --params template when the endpoint takes parameters, so a consuming
  // agent knows HOW to supply the values it was just told about (above).
  const reqs = (ep as any).semantic?.requires;
  let cmd = `unbrowse execute --skill ${skill.skill_id} --endpoint ${ep.endpoint_id}`;
  if (Array.isArray(reqs) && reqs.length) {
    const tmpl = reqs
      .map((r: any) => r?.key ?? r?.name)
      .filter((k: any) => typeof k === "string" && k)
      .map((k: string) => `"${k}":"<${k}>"`)
      .join(",");
    if (tmpl) cmd += ` --params '{${tmpl}}'`;
  }
  lines.push(cmd);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

const SECRET_HEADER = /^(authorization|cookie|x-api-key|api-?key|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|csrf-token|authentication|bearer|token)$/i;

export interface CredentialHole { name: string; location: string; fill: string; }

/**
 * Derive the credential HOLES a skill needs from its endpoints' auth surface.
 * Credentials are never embedded in a published skill — they are holes the
 * unbrowse runtime fills at call time, surfaced from the caller's private key
 * via zero-knowledge (the hole-template / wallet-bind pattern): prove you hold
 * the credential without the skill or marketplace ever seeing it. This lists
 * WHICH holes a caller must be able to fill, not the values.
 */
export function credentialHoles(skill: SkillManifest): CredentialHole[] {
  const holes = new Map<string, CredentialHole>();
  const add = (name: string, location: string) => {
    if (!name) return;
    const key = `${location}:${name}`.toLowerCase();
    if (!holes.has(key)) holes.set(key, { name, location, fill: "zk:private-key" });
  };
  for (const ep of skill.endpoints ?? []) {
    for (const k of Object.keys(ep.headers_template ?? {})) {
      if (SECRET_HEADER.test(k)) add(k, "header");
    }
    for (const t of (ep.auth_tokens ?? [])) {
      const nm = (t as { name?: string; header?: string; key?: string; param?: string }).name
        ?? (t as { header?: string }).header
        ?? (t as { key?: string }).key
        ?? (t as { param?: string }).param;
      if (typeof nm === "string") add(nm, "header");
    }
    if (ep.csrf_plan?.param_name) add(ep.csrf_plan.param_name, "header");
  }
  if (skill.auth_profile_ref) add("session", "cookie");
  return [...holes.values()];
}

/**
 * Bridge a declared credential hole into a runtime hole-template Hole, so the
 * format's "ZK-filled holes" connect to the real bind/prove/verify round-trip
 * (zk-bound-hole.ts). Credentials are secrets filled from the wallet-backed
 * vault (the private key); a cookie credential rides the `cookie` header.
 */
export function credentialHoleToRuntimeHole(h: CredentialHole): Hole {
  const headerName = h.location === "cookie" ? "cookie" : h.name;
  return { location: { in: "header", name: headerName }, name: h.name, kind: "secret", fill: "vault" };
}

/**
 * A single endpoint exposed as a TOOL WITH HOLES — the PII-censored shape the
 * server recommends and the CLIENT populates. The url_template + the typed slots
 * the client fills itself: query/path params from its own prompt (kind:id,
 * fill:llm), auth headers / cookies from its local vault (kind:secret, fill:vault).
 * Carries NO values and NO credentials: the server provides the capability, the
 * client provides the data. This is the node atom (callable interface) sealed
 * (schemas only, never credentials).
 */
export interface HoledTool {
  endpoint_id: string;
  method: string;
  url_template: string;
  /** every slot the client must fill — query/path params (llm) + auth (vault). */
  holes: Hole[];
}

/** Derive the secret credential holes for ONE endpoint (mirrors credentialHoles,
 *  scoped to a single endpoint + the skill-level auth profile). */
function endpointSecretHoles(skill: SkillManifest, ep: EndpointDescriptor): Hole[] {
  const seen = new Set<string>();
  const holes: Hole[] = [];
  const addHeader = (name: string) => {
    const key = `header:${name.toLowerCase()}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    holes.push({ location: { in: "header", name }, name, kind: "secret", fill: "vault" });
  };
  for (const k of Object.keys(ep.headers_template ?? {})) {
    if (SECRET_HEADER.test(k)) addHeader(k);
  }
  for (const t of (ep.auth_tokens ?? [])) {
    const nm = (t as { name?: string; header?: string; key?: string; param?: string }).name
      ?? (t as { header?: string }).header
      ?? (t as { key?: string }).key
      ?? (t as { param?: string }).param;
    if (typeof nm === "string") addHeader(nm);
  }
  if (ep.csrf_plan?.param_name) addHeader(ep.csrf_plan.param_name);
  if (skill.auth_profile_ref && !seen.has("header:cookie")) {
    holes.push({ location: { in: "header", name: "cookie" }, name: "session", kind: "secret", fill: "vault" });
  }
  return holes;
}

/** Parse the public (caller-filled, llm) holes out of a URL template: every
 *  {placeholder} in a query value or a path segment. These hold no secret — the
 *  client's agent fills them from the prompt. */
function endpointPublicHoles(urlTemplate: string): Hole[] {
  const holes: Hole[] = [];
  // Query params of the form key={key} (or key={anything}).
  const qIdx = urlTemplate.indexOf("?");
  if (qIdx >= 0) {
    const query = urlTemplate.slice(qIdx + 1);
    for (const pair of query.split("&")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const key = pair.slice(0, eq);
      const val = pair.slice(eq + 1);
      if (/^\{[^}]+\}$/.test(val) && key) {
        holes.push({ location: { in: "query", name: key }, name: key, kind: "id", fill: "llm" });
      }
    }
  }
  // Path segments of the form {name}.
  const pathPart = qIdx >= 0 ? urlTemplate.slice(0, qIdx) : urlTemplate;
  let m: RegExpExecArray | null;
  const segRe = /\{([^}]+)\}/g;
  while ((m = segRe.exec(pathPart)) !== null) {
    const name = m[1];
    if (name && !holes.some((h) => h.name === name)) {
      holes.push({ location: { in: "path", index: -1 }, name, kind: "id", fill: "llm" });
    }
  }
  return holes;
}

export function endpointToHoledTool(skill: SkillManifest, ep: EndpointDescriptor): HoledTool {
  const urlTemplate = ep.url_template ?? (ep as { url?: string }).url ?? "";
  return {
    endpoint_id: ep.endpoint_id,
    method: String(ep.method ?? "GET"),
    url_template: urlTemplate,
    holes: [...endpointPublicHoles(urlTemplate), ...endpointSecretHoles(skill, ep)],
  };
}

/** agentskills.io `metadata.contributors` frontmatter lines — one entry per
 *  agent who added delta, with their marginal contribution + payout share.
 *  Empty (no metadata block) for single-author skills. */
function renderContributorMetadata(skill: SkillManifest): string[] {
  const contributors = (skill as { contributors?: Array<{ agent_id: string; wallet_address?: string; endpoints_contributed: number; cumulative_delta: number; share: number }> }).contributors;
  if (!contributors || contributors.length === 0) return [];
  const lines = ["metadata:", "  contributors:"];
  for (const c of contributors) {
    lines.push(`    - agent_id: ${escapeYaml(c.agent_id)}`);
    if (c.wallet_address) lines.push(`      wallet_address: ${escapeYaml(c.wallet_address)}`);
    lines.push(`      endpoints_contributed: ${c.endpoints_contributed}`);
    lines.push(`      cumulative_delta: ${c.cumulative_delta}`);
    lines.push(`      share: ${c.share}`);
  }
  return lines;
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
    `origin: ${escapeYaml(`unbrowse-ai/${sanitizeDomain(skill.domain)}`)}`,
    // Skills are NOT exposed (published as a standalone `npx skills add` repo)
    // by default — exposure is an explicit owner act, distinct from marketplace
    // visibility. Reflect the manifest's real state; never hardcode true.
    `exposed: ${(skill as { exposed?: boolean }).exposed === true ? "true" : "false"}`,
    ...(skill.owner_wallet_address ? [`x402_reward: ${escapeYaml(skill.owner_wallet_address)}`] : []),
    `version: ${escapeYaml(skill.version)}`,
    `updated_at: ${escapeYaml(skill.updated_at)}`,
    // agentskills.io `metadata` block — multi-contributor delta attribution.
    // Every agent who added delta to this skill is surfaced with their marginal
    // contribution + payout share, so the public SKILL.md never reads as if a
    // multi-contributor skill had a single author.
    ...renderContributorMetadata(skill),
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
  body.push("## Install");
  body.push("");
  body.push("```bash");
  body.push(`npx skills add unbrowse-ai/${sanitizeDomain(skill.domain)}`);
  body.push("```");
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

  const holes = credentialHoles(skill);
  body.push("## Credentials");
  body.push("");
  if (holes.length === 0) {
    body.push("No credentials required — this skill calls public endpoints.");
  } else {
    body.push("Credentials are **never embedded** in this skill. They are placeholders the unbrowse runtime fills at call time from your own local keychain (browser cookies and paired secrets on your machine). The secret stays local — it is never written into the skill, sent to the marketplace, or seen by the publisher. Only the placeholder shape is published.");
    body.push("");
    for (const h of holes) body.push(`- \`${h.name}\` (${h.location}) — filled locally at call time`);
  }
  body.push("");
  if (skill.owner_wallet_address) {
    body.push("## Rewards (x402)");
    body.push("");
    body.push(`Each execution settles an x402 micropayment to the publisher's wallet \`${skill.owner_wallet_address}\` — the reward reaches the private key that published this route.`);
    body.push("");
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

export interface SkillPackageValidation { ok: boolean; issues: string[] }

/**
 * Terms that must never reach a PUBLIC artifact (mirrors the relevant lists in
 * `scripts/leak-guard.sh`: SENSITIVE_KEYWORDS_ZK — unreleased privacy/auth IP,
 * blocked until the whitepaper ships — and SENSITIVE_KEYWORDS_VOCAB — the
 * internal working vocabulary). A published `unbrowse-ai/<site>` package is a
 * public GitHub repo, so the publish gate refuses any package containing one.
 * The mechanism (local credential filling) is unchanged; only the public
 * wording is plain.
 */
const FORBIDDEN_PUBLIC_TERMS: RegExp[] = [
  /zero[ -]?knowledge/i,
  /\bzk[ -]?proof/i,
  /zk-?hash/i,
  /nullifier/i,
  /covenant/i,
  /superpattern/i,
  /jesus[ -]?pattern/i,
  /\bjesus\b/i,
  /firmament/i,
  /grain[ -]of[ -]wheat/i,
];

/** Return the forbidden public terms present in `text` (empty = clean). */
export function forbiddenPublicTerms(text: string): string[] {
  return FORBIDDEN_PUBLIC_TERMS.filter((re) => re.test(text)).map((re) => re.source);
}

/**
 * Validate that a rendered SKILL.md is a well-formed, installable agentskills
 * package: parseable YAML frontmatter with the dispatch-critical fields, a body
 * carrying the install pointer + the credentials section, and NO moat /
 * unreleased-IP leak (it is destined for a public repo). This is the
 * publish-time gate — a malformed OR leaky package must never ship to
 * unbrowse-ai/<site>. The scaling evidence for "many sites work easily" is this
 * returning ok across the captured corpus.
 */
export function validateSkillPackage(md: string): SkillPackageValidation {
  const issues: string[] = [];
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    return { ok: false, issues: ["no YAML frontmatter block"] };
  }
  const fm = fmMatch[1];
  const has = (key: string) => new RegExp(`^${key}:\\s*\\S`, "m").test(fm);
  for (const key of ["name", "description", "origin", "domain", "skill_id", "intent_signature", "endpoint_count"]) {
    if (!has(key)) issues.push(`frontmatter missing '${key}'`);
  }
  const originMatch = fm.match(/^origin:\s*"?(unbrowse-ai\/[^"\n]+)"?/m);
  if (!originMatch) issues.push("origin is not 'unbrowse-ai/<domain>'");
  if (originMatch) {
    const domain = originMatch[1].slice("unbrowse-ai/".length);
    if (!md.includes(`npx skills add unbrowse-ai/${domain}`)) {
      issues.push("body missing the `npx skills add` install line for this origin");
    }
  }
  if (!md.includes("## Credentials")) issues.push("body missing the Credentials section");
  // x402 is optional (public skills have no owner wallet), but if a reward is
  // declared it must name a non-empty wallet.
  const reward = fm.match(/^x402_reward:\s*"?([^"\n]*)"?/m);
  if (reward && !reward[1].trim()) issues.push("x402_reward declared but empty");
  // Moat / unreleased-IP gate: the package goes to a public repo.
  for (const term of forbiddenPublicTerms(md)) {
    issues.push(`forbidden public term (moat/unreleased-IP leak): /${term}/`);
  }
  return { ok: issues.length === 0, issues };
}

export function exportSkillMdLocal(skill: SkillManifest): string | null {
  // v7 stateless gate (Day-5 worker E): under UNBROWSE_STATELESS=1 the
  // local ~/.unbrowse/skills/ dir is READ-ONLY. The marketplace is the
  // source of truth; skipping the SKILL.md export is a no-op (the export
  // is informational, never load-bearing). Precedence: STATELESS wins
  // over OFFLINE when both are set (Heb 7:18-19 — the newer covenant).
  if (process.env.UNBROWSE_STATELESS === "1") return null;
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
