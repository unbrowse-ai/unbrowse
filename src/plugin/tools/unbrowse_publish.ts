import type { ToolDeps } from "./deps.js";
import type { PublishPayload } from "./shared.js";
import {
  existsSync,
  readFileSync,
  readdirSync,
  join,
  PUBLISH_SCHEMA,
  extractEndpoints,
  extractPublishableAuth,
  sanitizeApiTemplate,
} from "./shared.js";

export function makeUnbrowsePublishTool(deps: ToolDeps) {
  const {
    logger,
    defaultOutputDir,
    autoDiscoverEnabled,
    autoPublishSkill,
    indexClient,
    indexOpts,
  } = deps;

  return {
name: "unbrowse_publish",
label: "Share Internal API",
description:
  "Share a captured internal API skill to the marketplace. Publishes the endpoint structure, " +
  "auth method, and documentation — credentials stay local (others need their own login). " +
  "Useful when you've reverse-engineered an internal API that others might want to use. " +
  "Set price='0' for free or price='1.50' for $1.50 USDC (you earn 70%).",
parameters: PUBLISH_SCHEMA,
async execute(_toolCallId: string, params: unknown) {
  const p = params as { service: string; skillsDir?: string };
  const creatorWallet = deps.walletState?.creatorWallet;
  const solanaPrivateKey = deps.walletState?.solanaPrivateKey;

  if (!creatorWallet || !solanaPrivateKey) {
    const walletHint = (() => {
      if (!creatorWallet && !solanaPrivateKey) {
        return [
          '  1. Create a new wallet: unbrowse_wallet action="create"',
          '  2. Use existing wallet:',
          '     - Set earning address: unbrowse_wallet action="set_creator" wallet="<your-solana-address>"',
          '     - Set signing key:     unbrowse_wallet action="set_payer" privateKey="<base58-private-key>"',
        ].join("\n");
      }
      if (!creatorWallet) {
        return [
          '  1. Set earning address: unbrowse_wallet action="set_creator" wallet="<your-solana-address>"',
          '  2. Or generate a new keypair: unbrowse_wallet action="create"',
        ].join("\n");
      }
      // creatorWallet exists but no private key to sign
      return [
        `  Your wallet: ${creatorWallet}`,
        '  Add a signing key to publish:',
        '    - Generate a new keypair: unbrowse_wallet action="create"',
        '    - Or import existing key: unbrowse_wallet action="set_payer" privateKey="<base58-private-key>"',
      ].join("\n");
    })();

    return {
      content: [{
        type: "text",
        text: [
          "Wallet not fully configured for publishing skills.",
          "",
          "Publishing requires both:",
          "  - A creator wallet address (earning destination)",
          "  - A Solana private key to sign the publish request",
          "",
          "Options:",
          walletHint,
          "",
          "Once configured, try publishing again.",
        ].join("\n"),
      }],
    };
  }

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
        if (file.endsWith(".md")) {
          references[file] = readFileSync(join(referencesDir, file), "utf-8");
        }
      }
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
      serviceName: p.service,
      domain: domain || undefined,
      creatorWallet,
      priceUsdc: (p as any).price ?? "0", // Default to free
    };

    // Backend may return different success shapes:
    // - { success: true, skill: { skillId, ... }, ... } for create/update
    // - { success: true, merged: true, skillId, message, ... } for collaborative merges
    const result: any = await indexClient.publish(payload);
    const skillId: string | undefined = result?.skill?.skillId ?? result?.skillId;
    if (!skillId) {
      throw new Error("Publish succeeded but response did not include a skillId");
    }
    const merged = Boolean(result?.merged);

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
      `Creator wallet: ${creatorWallet}`,
      merged && result?.message ? `Merge: ${String(result.message)}` : null,
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
