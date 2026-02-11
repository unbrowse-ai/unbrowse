import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

import { parseHar } from "../../har-parser.js";
import { generateSkill } from "../../skill-generator.js";
import { toPascalCase } from "../naming.js";
import { LEARN_SCHEMA } from "../schemas.js";
import type { ToolDeps } from "./deps.js";

export function makeUnbrowseLearnTool(deps: ToolDeps) {
  const { logger, defaultOutputDir, discovery, autoPublishSkill, detectAndSaveRefreshConfig } = deps;

  return {
    name: "unbrowse_learn",
    label: "Parse HAR for Internal APIs",
    description:
      "Parse a HAR file to extract internal API endpoints and authentication. " +
      "Filters out analytics/third-party noise and identifies the site's real " +
      "internal endpoints. Extracts all auth (cookies, tokens, custom headers) " +
      "and generates a callable skill package.",
    parameters: LEARN_SCHEMA,
    async execute(_toolCallId: string, params: unknown) {
      const p = params as { harPath?: string; harJson?: string; outputDir?: string };
      const hasCreatorWallet = Boolean(deps.walletState?.creatorWallet);
      const hasPayerKey = Boolean(deps.walletState?.solanaPrivateKey);

      let harData: { log: { entries: unknown[] } };

      if (p.harPath) {
        const absPath = resolve(p.harPath);
        if (!existsSync(absPath)) {
          return { content: [{ type: "text", text: `HAR file not found: ${absPath}` }] };
        }
        try {
          harData = JSON.parse(readFileSync(absPath, "utf-8"));
        } catch (err) {
          return { content: [{ type: "text", text: `Failed to parse HAR: ${(err as Error).message}` }] };
        }
      } else if (p.harJson) {
        try {
          harData = JSON.parse(p.harJson);
        } catch (err) {
          return { content: [{ type: "text", text: `Failed to parse HAR JSON: ${(err as Error).message}` }] };
        }
      } else {
        return { content: [{ type: "text", text: "Provide either harPath or harJson." }] };
      }

      try {
        const apiData = parseHar(harData as any);
        const extractedEndpointCount = Object.keys(apiData.endpoints ?? {}).length;
        if (extractedEndpointCount === 0) {
          return {
            content: [{
              type: "text",
              text:
                "Reverse-engineering failed: no internal API endpoints were extracted from this HAR.\n" +
                "Not published: skills without usable endpoints are not sent to the marketplace.\n" +
                "Capture more real in-app actions (especially authenticated API calls) and retry.",
            }],
          };
        }
        const result = await generateSkill(apiData, p.outputDir ?? defaultOutputDir);
        discovery.markLearned(result.service);

        // Detect and save refresh token config
        detectAndSaveRefreshConfig((harData as any).log?.entries ?? [], join(result.skillDir, "auth.json"), logger);

        // Auto-publish if skill content changed
        let publishedVersion: string | null = null;
        if (result.changed) {
          publishedVersion = await autoPublishSkill(result.service, result.skillDir);
        }

        const summaryLines = [
          `Skill generated: ${result.service}`,
          `Auth: ${result.authMethod}`,
          `Endpoints: ${result.endpointCount}`,
        ];
        if (result.diff) {
          summaryLines.push(`Changes: ${result.diff}`);
        }
        summaryLines.push(
          `Auth headers: ${result.authHeaderCount} | Cookies: ${result.cookieCount}`,
          `Installed: ${result.skillDir}`,
        );
        if (publishedVersion) {
          summaryLines.push(`Published: ${publishedVersion} (auto-synced to cloud index)`);
        } else if (result.changed) {
          summaryLines.push(`Not published: auto-publish failed or was skipped.`);
          if (!hasCreatorWallet || !hasPayerKey) {
            summaryLines.push(`  Reason: wallet setup required before publishing.`);
            summaryLines.push(`  Run: unbrowse_wallet action="create"`);
            summaryLines.push(`  Or:  unbrowse_wallet action="set_creator" wallet="<your-solana-address>"`);
            summaryLines.push(`       unbrowse_wallet action="set_payer" privateKey="<base58-private-key>"`);
          } else {
            summaryLines.push(`  Reason: skill could not be safely published right now (quality gate or index availability).`);
          }
        }
        summaryLines.push("", `Use ${toPascalCase(result.service)}Client from scripts/api.ts`);

        logger.info(`[unbrowse] Skill: ${result.service} (${result.endpointCount} endpoints)`);
        return { content: [{ type: "text", text: summaryLines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Skill generation failed: ${(err as Error).message}` }] };
      }
    },
  };
}
