import type { ToolDeps } from "./deps.js";
import type { PublishPayload } from "./shared.js";
import type { HeaderProfileFile } from "./shared.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  join,
  PUBLISH_SCHEMA,
  extractEndpoints,
  extractPublishableAuth,
  sanitizeApiTemplate,
  sanitizeHeaderProfile,
} from "./shared.js";
import { writeMarketplaceMeta, writeSkillPackageToDir } from "../../skill-package-writer.js";

function toCookieHeader(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const pairs = Object.entries(raw as Record<string, unknown>)
    .filter(([k, v]) => k.trim().length > 0 && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v)}`);
  if (pairs.length === 0) return undefined;
  return pairs.join("; ");
}

function toHeaderMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(k || "").trim();
    if (!name) continue;
    if (v === undefined || v === null) continue;
    headers[name] = String(v);
  }
  return headers;
}

export function makeUnbrowsePublishTool(deps: ToolDeps) {
  const {
    logger,
    defaultOutputDir,
    autoDiscoverEnabled,
    autoPublishSkill,
    indexClient,
    indexOpts,
    publishValidationWithAuth,
  } = deps;

  return {
name: "unbrowse_publish",
label: "Share Internal API",
description:
  "Share a captured internal API skill to the marketplace. Publishes the endpoint structure, " +
  "auth method, and documentation — credentials stay local (others need their own login). " +
  "This tool should be run from a delegated publishing subagent (not the main agent thread). " +
  "Useful when you've reverse-engineered an internal API that others might want to use. " +
  "Set price='0' for free or price='1.50' for $1.50 USDC (you earn 70%).",
parameters: PUBLISH_SCHEMA,
async execute(_toolCallId: string, params: unknown) {
  const p = params as { service: string; skillsDir?: string };
  const creatorWallet = deps.walletState?.creatorWallet;
  // Wallet is optional for publish; set it if you want attribution/payout routing.

  const skillsDir = p.skillsDir ?? defaultOutputDir;
  const skillDir = join(skillsDir, p.service);
  const skillMdPath = join(skillDir, "SKILL.md");
  const authJsonPath = join(skillDir, "auth.json");
  const apiTsPath = join(skillDir, "scripts", "api.ts");

  if (!existsSync(skillMdPath)) {
    return { content: [{ type: "text", text: `Skill not found: ${skillDir}. Generate it first with unbrowse_learn or unbrowse_capture.` }] };
  }

  try {
    const skillMd = readFileSync(skillMdPath, "utf-8");
    const endpoints = extractEndpoints(skillMd);

    let baseUrl = "";
    let authMethodType = "Unknown";

    if (existsSync(authJsonPath)) {
      const authStr = readFileSync(authJsonPath, "utf-8");
      const pub = extractPublishableAuth(authStr);
      baseUrl = pub.baseUrl;
      authMethodType = pub.authMethodType;
    }

    // Optional: include local auth headers/cookies to help backend quality gate
    // verify authenticated endpoints during publish. Never written to marketplace skill files.
    let validationAuth: PublishPayload["validationAuth"] | undefined;
    if (publishValidationWithAuth && existsSync(authJsonPath)) {
      try {
        const auth = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
        const headers = toHeaderMap(auth.headers);
        const cookies = toCookieHeader(auth.cookies);
        if (Object.keys(headers).length > 0 || cookies) {
          validationAuth = {
            headers: Object.keys(headers).length > 0 ? headers : undefined,
            cookies,
          };
        }
      } catch (err) {
        logger.warn(`[unbrowse] Failed to load auth.json for publish validation auth: ${(err as Error).message}`);
      }
    }

    // Collect scripts (api.ts and any other .ts files in scripts/)
    const scripts: Record<string, string> = {};
    if (existsSync(apiTsPath)) {
      scripts["api.ts"] = sanitizeApiTemplate(readFileSync(apiTsPath, "utf-8"));
    }

    // Collect references (any .md files in references/)
    const references: Record<string, string> = {};
    const referencesDir = join(skillDir, "references");
    if (existsSync(referencesDir)) {
      for (const file of readdirSync(referencesDir)) {
        if (file.endsWith(".md") || file.endsWith(".json")) {
          references[file] = readFileSync(join(referencesDir, file), "utf-8");
        }
      }
    }

    // Load and sanitize header profile (strip auth values, keep template shape)
    const headersJsonPath = join(skillDir, "headers.json");
    let headerProfile: HeaderProfileFile | undefined;
    if (existsSync(headersJsonPath)) {
      try {
        const raw: HeaderProfileFile = JSON.parse(readFileSync(headersJsonPath, "utf-8"));
        headerProfile = sanitizeHeaderProfile(raw);
      } catch { /* invalid headers.json — skip */ }
    }

    // Extract description from SKILL.md frontmatter or generate one
    let description = "";
    const descMatch = skillMd.match(/^description:\s*>-?\s*\n([\s\S]*?)(?=\n\w|---)/m);
    if (descMatch) {
      description = descMatch[1].replace(/\n\s+/g, " ").trim();
    } else {
      // Build a meaningful fallback description
      const endpointNames = endpoints.slice(0, 3).map((e: { method: string; path: string }) => e.path);
      const capText = endpointNames.length > 0 ? ` Endpoints: ${endpointNames.join(", ")}.` : "";
      description = `${p.service} skill for OpenClaw.${capText}`;
    }

    // Extract domain from baseUrl
    let domain = "";
    if (baseUrl) {
      try {
        domain = new URL(baseUrl).hostname;
      } catch { /* skip */ }
    }

    // Extract version hash from SKILL.md frontmatter
    const versionHashMatch = skillMd.match(/versionHash:\s*"?([a-f0-9]+)"?/i);
    const versionHash = versionHashMatch?.[1];

    // Build payload following agentskills.io format
    const payload: PublishPayload = {
      name: p.service,
      description,
      skillMd,
      authType: authMethodType !== "Unknown" ? authMethodType : undefined,
      scripts: Object.keys(scripts).length > 0 ? scripts : undefined,
      references: Object.keys(references).length > 0 ? references : undefined,
      headerProfile,
      serviceName: p.service,
      domain: domain || undefined,
      creatorWallet: creatorWallet || undefined,
      priceUsdc: (p as any).price ?? "0", // Default to free
      validationAuth,
    };

    // Backend may return different success shapes:
    // - { success: true, skill: { skillId, ... }, ... } for create/update
    // - { success: true, merged: true, skillId, skill: { skillMd, scripts, ... }, ... } for collaborative merges
    const result: any = await indexClient.publish(payload);
    const skillId: string | undefined = result?.skill?.skillId ?? result?.skillId;
    if (!skillId) {
      throw new Error("Publish succeeded but response did not include a skillId");
    }
    const merged = Boolean(result?.merged);

    // Server returns canonical skill content (merge/update/create). Sync it locally.
    const updatedLocally = writeSkillPackageToDir(skillDir, result?.skill);
    if (updatedLocally) {
      logger.info(`[unbrowse] Published skill written to ${skillDir}`);
    }
    writeMarketplaceMeta(skillDir, { skillId, indexUrl: indexOpts.indexUrl, name: p.service });

    const priceDisplay = (p as any).price && parseFloat((p as any).price) > 0
      ? `$${parseFloat((p as any).price).toFixed(2)} USDC`
      : "Free";
    const summary = [
      merged ? `Skill merged into existing marketplace entry` : `Skill published to cloud marketplace`,
      `Name: ${p.service}`,
      `ID: ${skillId}`,
      versionHash ? `Version: ${versionHash}` : null,
      `Price: ${priceDisplay}`,
      `Endpoints: ${endpoints.length}`,
      creatorWallet ? `Creator wallet: ${creatorWallet}` : `Creator wallet: (none set)`,
      merged && result?.message ? `Merge: ${String(result.message)}` : null,
      merged && result?.contribution ? `Contribution: +${result.contribution.endpointsAdded} endpoints, novelty ${(result.contribution.noveltyScore * 100).toFixed(0)}%` : null,
      updatedLocally ? `Local skill updated with canonical version from backend` : null,
      validationAuth ? `Validation auth: sent (opt-in)` : null,
      ``,
      `Others can find and download this skill via unbrowse_search.`,
      priceDisplay !== "Free" ? `You earn 70% ($${(parseFloat((p as any).price) * 0.7).toFixed(2)}) for each download.` : "",
    ].filter(Boolean).join("\n");

    logger.info(`[unbrowse] Published: ${p.service} → ${skillId}${merged ? " (merged)" : ""}`);
    return { content: [{ type: "text", text: summary }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Publish failed: ${(err as Error).message}` }] };
  }
},
};
}
