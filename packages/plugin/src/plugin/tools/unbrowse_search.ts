import type { ToolDeps } from "./deps.js";
import { SEARCH_SCHEMA, join, extractEndpoints } from "./shared.js";

export function makeUnbrowseSearchTool(deps: ToolDeps) {
  const { logger, defaultOutputDir, indexClient, discovery } = deps;

  return {
name: "unbrowse_search",
label: "Find Internal APIs",
description:
  "Search for internal API skills that others have reverse-engineered. " +
  "Find endpoints for sites you need to access without doing the capture yourself. " +
  "Searching is free. Downloading a skill may cost USDC depending on its price. " +
  "You'll still need your own login credentials — the skill just tells you which endpoints exist.",
parameters: SEARCH_SCHEMA,
async execute(_toolCallId: string, params: unknown) {
  const p = params as { query?: string; install?: string };
  const creatorWallet = deps.walletState?.creatorWallet;
  const solanaPrivateKey = deps.walletState?.solanaPrivateKey;

  function assertSafeFilename(kind: string, filename: string): void {
    // Prevent path traversal when writing marketplace content to disk.
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      throw new Error(`Refusing to write ${kind} with unsafe filename: ${filename}`);
    }
  }

  // ── Install mode ──
  if (p.install) {
    try {
      const pkg = await indexClient.download(p.install);

      // Save locally using agentskills.io directory structure
      const skillDir = join(defaultOutputDir, pkg.name);
      const scriptsDir = join(skillDir, "scripts");
      const referencesDir = join(skillDir, "references");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(scriptsDir, { recursive: true });
      mkdirSync(referencesDir, { recursive: true });

      // Write SKILL.md
      writeFileSync(join(skillDir, "SKILL.md"), pkg.skillMd, "utf-8");

      // Write scripts (api.ts and others)
      if (pkg.scripts) {
        for (const [filename, content] of Object.entries(pkg.scripts)) {
          assertSafeFilename("script", filename);
          writeFileSync(join(scriptsDir, filename), String(content), "utf-8");
        }
      }

      // Write references
      if (pkg.references) {
        for (const [filename, content] of Object.entries(pkg.references)) {
          assertSafeFilename("reference", filename);
          writeFileSync(join(referencesDir, filename), String(content), "utf-8");
        }
      }

      // Create placeholder auth.json — user adds their own credentials
      writeFileSync(join(skillDir, "auth.json"), JSON.stringify({
        service: pkg.name,
        baseUrl: pkg.domain ? `https://${pkg.domain}` : "",
        authMethod: pkg.authType || "Unknown",
        timestamp: new Date().toISOString(),
        notes: ["Downloaded from skill marketplace — add your own auth credentials"],
        headers: {},
        cookies: {},
      }, null, 2), "utf-8");

      discovery.markLearned(pkg.name);

      const versionMatch = pkg.skillMd.match(/versionHash:\s*"?([a-f0-9]+)"?/i);
      const versionHash = versionMatch?.[1];

      // Count endpoints from SKILL.md
      const endpointCount = extractEndpoints(pkg.skillMd).length;

      const summary = [
        `Skill installed: ${pkg.name}`,
        `Location: ${skillDir}`,
        `Endpoints: ${endpointCount}`,
        `Auth: ${pkg.authType || "Unknown"}`,
        pkg.category ? `Category: ${pkg.category}` : null,
        versionHash ? `Version: ${versionHash}` : null,
        ``,
        `Add your auth credentials to auth.json or use unbrowse_auth to extract from browser.`,
      ].filter(Boolean).join("\n");

      logger.info(`[unbrowse] Installed from marketplace: ${pkg.name}`);
      return { content: [{ type: "text", text: summary }] };
    } catch (err) {
      const msg = (err as Error).message;
      // If payment failed due to missing key or insufficient funds, prompt to fund wallet
      if (msg.includes("private key") || msg.includes("x402") || msg.includes("payment")) {
        let walletHint: string;
        if (creatorWallet && solanaPrivateKey) {
          walletHint = [
            "",
            `Your wallet: ${creatorWallet}`,
            "Send USDC (Solana SPL) to this address to fund skill downloads.",
          ].join("\n");
        } else if (creatorWallet) {
          walletHint = [
            "",
            `Your wallet: ${creatorWallet}`,
            "No spending key configured. Options:",
            '  1. Generate a new keypair: unbrowse_wallet action="create"',
            '  2. Import existing key: unbrowse_wallet action="set_payer" privateKey="<base58-key>"',
          ].join("\n");
        } else {
          walletHint = [
            "",
            "No wallet configured. Options:",
            '  1. Create a new wallet: unbrowse_wallet action="create"',
            '  2. Use existing wallet: unbrowse_wallet action="set_creator" wallet="<address>"',
            '                          unbrowse_wallet action="set_payer" privateKey="<key>"',
          ].join("\n");
        }
        return { content: [{ type: "text", text: `Install failed: ${msg}${walletHint}` }] };
      }
      return { content: [{ type: "text", text: `Install failed: ${msg}` }] };
    }
  }

  // ── Search mode ──
  if (!p.query) {
    return { content: [{ type: "text", text: "Provide a query to search, or install=<id> to download a skill." }] };
  }

  try {
    const results = await indexClient.search(p.query, { limit: 10 });

    if (results.skills.length === 0) {
      return { content: [{ type: "text", text: `No skills found for "${p.query}". Try different keywords.` }] };
    }

    const lines = [
      `Skill Marketplace (${results.total} results for "${p.query}"):`,
      "",
    ];

    for (const skill of results.skills) {
      const meta: string[] = [];
      if (skill.category) meta.push(skill.category);
      if (skill.authType) meta.push(skill.authType);
      if (skill.domain) meta.push(skill.domain);
      const metaStr = meta.length > 0 ? ` [${meta.join(", ")}]` : "";

      lines.push(
        `  ${skill.name}${metaStr}`,
        `    ${skill.description?.slice(0, 100) || "No description"}`,
        `    ID: ${skill.skillId} | Downloads: ${skill.downloadCount}`,
      );
    }

    lines.push("", `Use unbrowse_search with install="<skillId>" to download and install.`);

    if (creatorWallet) {
      lines.push(`\nYour wallet: ${creatorWallet}`);
      if (!solanaPrivateKey) {
        lines.push("Send USDC (Solana SPL) to this address to fund skill downloads.");
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Search failed: ${(err as Error).message}` }] };
  }
},
};
}
