import { join } from "node:path";

import {
  parseHar,
  mergeOpenApiEndpoints,
  enrichApiData,
  generateSkill,
  verifyAndPruneGetEndpoints,
  selectEndpointGroupsForIntent,
  writeCaptureSessionFile,
  inferCorrelationGraphV1,
  captureWithHar,
} from "@getfoundry/unbrowse-core";
import { CAPTURE_SCHEMA } from "../schemas.js";
import type { ToolDeps } from "./deps.js";
import { normalizeUrlList, coalesceDir } from "./input-normalizers.js";
import { buildPublishPromptLines, isPayerPrivateKeyValid } from "./publish-prompts.js";

export function makeUnbrowseCaptureTool(deps: ToolDeps) {
  const { logger, defaultOutputDir, discovery, detectAndSaveRefreshConfig } = deps;

  return {
    name: "unbrowse_capture",
    label: "Capture Internal APIs",
    description:
      "Reverse-engineer internal APIs from any website. Provide URLs and the tool captures " +
      "all hidden API traffic the site uses internally — the undocumented endpoints, auth tokens, " +
      "session cookies, and custom headers. No crawling by default (to avoid random endpoints). " +
      "For authenticated sites, use unbrowse_login first to capture session auth.",
    parameters: CAPTURE_SCHEMA,
    async execute(_toolCallId: string, params: unknown) {
      const p = params as {
        outputDir?: string;
        skillsDir?: string;
        urls: string[];
        intent?: string;
        maxEndpoints?: number;
        waitMs?: number;
        crawl?: boolean;
        maxPages?: number;
        testEndpoints?: boolean;
        headless?: boolean;
      };

      // Normalize urls: accept string or array
      const urls = normalizeUrlList((p as any).urls);
      if (urls.length === 0) {
        return { content: [{ type: "text", text: "Provide at least one URL to capture." }] };
      }
      const outDir = coalesceDir({ outputDir: (p as any).outputDir, skillsDir: (p as any).skillsDir, fallback: defaultOutputDir });
      const hasCreatorWallet = Boolean(deps.walletState?.creatorWallet);
      const hasPayerKey = Boolean(deps.walletState?.solanaPrivateKey);
      const payerKeyValid = hasPayerKey
        ? await isPayerPrivateKeyValid(deps.walletState?.solanaPrivateKey)
        : false;

      try {
        const shouldCrawl = p.crawl === true;
        const shouldTest = p.testEndpoints !== false;
        const maxPages = p.maxPages ?? 15;
        const intent = typeof p.intent === "string" ? p.intent.trim() : "";
        const maxEndpoints = Number.isFinite(p.maxEndpoints) && (p.maxEndpoints as number) > 0
          ? Math.min(200, Math.max(1, Math.trunc(p.maxEndpoints as number)))
          : 25;

        // Progress feedback before starting
        logger.info(
          `[unbrowse] Capture starting: ${urls.length} seed URL(s)` +
          `${shouldCrawl ? `, crawl up to ${maxPages} pages (60s max)` : ""}` +
          `${intent ? `, intent="${intent.slice(0, 120)}"${intent.length > 120 ? "..." : ""}` : ""}` +
          `...`,
        );

        const { har, cookies, requestCount, method, crawlResult } = await captureWithHar(urls, {
          waitMs: p.waitMs,
          headless: p.headless ?? false, // Default visible so user can interact if needed
          crawl: shouldCrawl,
          crawlOptions: {
            maxPages,
            discoverOpenApi: true,
          },
        });

        // Analyze HTTP status codes for rate limit/blocking detection
        const entries = har.log?.entries ?? [];
        let blocked403 = 0;
        let rateLimited429 = 0;
        let serverErrors5xx = 0;
        for (const entry of entries) {
          const status = entry.response?.status ?? 0;
          if (status === 403) blocked403++;
          else if (status === 429) rateLimited429++;
          else if (status >= 500 && status < 600) serverErrors5xx++;
        }
        const totalRequests = entries.length;
        const failedRequests = blocked403 + rateLimited429 + serverErrors5xx;
        const failureRate = totalRequests > 0 ? failedRequests / totalRequests : 0;

        if (requestCount === 0) {
          return { content: [{ type: "text", text: "No API requests captured. The pages may not make API calls, or try waiting longer (waitMs)." }] };
        }

        let apiData = parseHar(har, urls[0]);
        for (const [name, value] of Object.entries(cookies)) {
          if (!apiData.cookies[name]) apiData.cookies[name] = value;
        }

        // Merge OpenAPI spec endpoints if found
        const openApiSpec = crawlResult?.openApiSpec ?? null;
        if (openApiSpec) {
          const specBaseUrl = openApiSpec.baseUrl ?? apiData.baseUrl;
          apiData = mergeOpenApiEndpoints(apiData, openApiSpec.endpoints, specBaseUrl);
        }

        const extractedEndpointCount = Object.keys(apiData.endpoints ?? {}).length;
        if (extractedEndpointCount === 0) {
          const lines = [
            `Captured (${method}): ${requestCount} requests from ${urls.length} page(s)`,
            "Reverse-engineering failed: no internal API endpoints were extracted from this traffic.",
            "Not published: skills without usable endpoints are not sent to the marketplace.",
            "Try: capture authenticated flows first (unbrowse_login), then run unbrowse_capture again with longer waitMs or more targeted pages.",
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // Auto-test GET endpoints and prune failing tested GETs.
        let testSummary: {
          total: number;
          verified: number;
          failed: number;
          skipped: number;
          pruned: number;
          results: Array<{ method: string; path: string; ok: boolean; hasData: boolean }>;
        } | null = null;
        if (shouldTest && Object.keys(apiData.endpoints).length > 0) {
          try {
            testSummary = await verifyAndPruneGetEndpoints(apiData, cookies);
          } catch (testErr) {
            logger.warn(`[unbrowse] Endpoint testing failed: ${(testErr as Error).message}`);
          }
        }

        // Build endpoint groups (normalized paths + generated method names).
        apiData = enrichApiData(apiData);

        // Optional pruning: keep only endpoints relevant to the user's intent.
        if (intent && apiData.endpointGroups && apiData.endpointGroups.length > 0) {
          const before = apiData.endpointGroups.length;
          apiData.endpointGroups = selectEndpointGroupsForIntent(apiData.endpointGroups, intent, { limit: maxEndpoints });
          const after = apiData.endpointGroups.length;
          logger.info(`[unbrowse] Intent pruning: ${before} -> ${after} endpoint(s) (limit=${maxEndpoints})`);
        }

        const result = await generateSkill(apiData, outDir, {
          verifiedEndpoints: testSummary?.verified,
          unverifiedEndpoints: testSummary ? Math.max(0, testSummary.total - testSummary.verified) : undefined,
          openApiSource: crawlResult?.openApiSource,
          pagesCrawled: crawlResult?.pagesCrawled,
        });
        discovery.markLearned(result.service);

        // Persist full capture exchanges (with bodies) locally for replay-v2 correlation + chaining.
        try {
          const { mkdirSync, writeFileSync } = await import("node:fs");
          const { session } = writeCaptureSessionFile(result.skillDir, har.log?.entries ?? [], { seedUrl: urls[0] });
          const graph = inferCorrelationGraphV1(session.exchanges);
          const refsDir = join(result.skillDir, "references");
          mkdirSync(refsDir, { recursive: true });
          writeFileSync(join(refsDir, "CORRELATIONS.json"), JSON.stringify(graph, null, 2), "utf-8");
          const sequences = graph.chains.map((chain, i) => ({
            name: `chain_${i + 1}`,
            steps: chain.map((idx) => graph.requests.find((r) => r.index === idx)),
          }));
          writeFileSync(join(refsDir, "SEQUENCES.json"), JSON.stringify(sequences, null, 2), "utf-8");
        } catch {
          // Non-critical: skill still generated successfully
        }

        // Detect and save refresh token config
        detectAndSaveRefreshConfig(har.log?.entries ?? [], join(result.skillDir, "auth.json"), logger);

        // Build summary
        const summaryLines = [
          `Captured (${method}): ${requestCount} requests from ${urls.length} page(s)`,
        ];
        if (shouldCrawl && crawlResult && crawlResult.pagesCrawled > 0) {
          summaryLines.push(`Crawled: ${crawlResult.pagesCrawled} additional pages`);
        }
        if (openApiSpec) {
          summaryLines.push(`OpenAPI: ${crawlResult?.openApiSource} (${openApiSpec.endpoints.length} endpoints)`);
        }
        summaryLines.push(
          `Skill: ${result.service}`,
          `Auth: ${result.authMethod}`,
          `Endpoints: ${result.endpointCount}`,
        );
        if (result.diff) {
          summaryLines.push(`Changes: ${result.diff}`);
        }
        if (testSummary) {
          summaryLines.push(`Verified: ${testSummary.verified}/${testSummary.total} GET endpoints`);
          if (testSummary.pruned > 0) {
            summaryLines.push(`Pruned: ${testSummary.pruned} failing GET endpoint(s) before publish`);
          }
        }
        summaryLines.push(
          `Auth headers: ${result.authHeaderCount} | Cookies: ${result.cookieCount}`,
          `Installed: ${result.skillDir}`,
        );
        if (result.changed) {
          summaryLines.push(...buildPublishPromptLines({
            service: result.service,
            skillsDir: outDir,
            hasCreatorWallet,
            hasPayerKey,
            payerKeyValid,
          }));
        }

        // Rate limit / bot detection warnings
        if (failureRate > 0.1 && failedRequests > 2) {
          const failureDetails: string[] = [];
          if (blocked403 > 0) failureDetails.push(`${blocked403} blocked (403)`);
          if (rateLimited429 > 0) failureDetails.push(`${rateLimited429} rate-limited (429)`);
          if (serverErrors5xx > 0) failureDetails.push(`${serverErrors5xx} server errors (5xx)`);
          summaryLines.push(
            "",
            `⚠️  High failure rate: ${failureDetails.join(", ")} out of ${totalRequests} requests`,
            `   The site may be blocking automated browsing/crawling. Skill may be incomplete.`,
            `   Try: unbrowse_replay with useStealth=true, or the browse tool for manual exploration.`,
          );
          logger.warn(`[unbrowse] High failure rate (${Math.round(failureRate * 100)}%) — ${failureDetails.join(", ")}`);
        }

        logger.info(
          `[unbrowse] Capture → ${result.service} (${result.endpointCount} endpoints${shouldCrawl ? `, ${crawlResult?.pagesCrawled ?? 0} crawled` : ""}, via ${method})`,
        );
        return { content: [{ type: "text", text: summaryLines.join("\n") }] };
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("Target page, context or browser has been closed")) {
          return { content: [{ type: "text", text: "Browser context closed unexpectedly. Try again." }] };
        }
        if (msg.includes("playwright-core")) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Browser runtime unavailable: ${msg}\n` +
                  `Start native browser first: openclaw browser start --browser-profile openclaw`,
              },
            ],
          };
        }
        return { content: [{ type: "text", text: `Capture failed: ${msg}` }] };
      }
    },
  };
}
