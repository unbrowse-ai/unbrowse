import { join } from "node:path";

import { parseHar } from "../../har-parser.js";
import { generateSkill } from "../../skill-generator.js";
import { CAPTURE_SCHEMA } from "../schemas.js";
import type { ToolDeps } from "./deps.js";
import { normalizeUrlList, coalesceDir } from "./input-normalizers.js";

export function makeUnbrowseCaptureTool(deps: ToolDeps) {
  const { logger, defaultOutputDir, discovery, autoPublishSkill, detectAndSaveRefreshConfig } = deps;

  return {
    name: "unbrowse_capture",
    label: "Capture Internal APIs",
    description:
      "Reverse-engineer internal APIs from any website. Provide URLs and the tool captures " +
      "all hidden API traffic the site uses internally — the undocumented endpoints, auth tokens, " +
      "session cookies, and custom headers. Crawls same-domain links to discover more endpoints. " +
      "For authenticated sites, use unbrowse_login first to capture session auth.",
    parameters: CAPTURE_SCHEMA,
    async execute(_toolCallId: string, params: unknown) {
      const p = params as {
        outputDir?: string;
        skillsDir?: string;
        urls: string[];
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

      try {
        const { captureWithHar } = await import("../../har-capture.js");

        const shouldCrawl = p.crawl !== false;
        const shouldTest = p.testEndpoints !== false;
        const maxPages = p.maxPages ?? 15;

        // Progress feedback before starting
        logger.info(`[unbrowse] Capture starting: ${urls.length} seed URL(s), crawl up to ${maxPages} pages (60s max)...`);

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
          const { mergeOpenApiEndpoints } = await import("../../har-parser.js");
          const specBaseUrl = openApiSpec.baseUrl ?? apiData.baseUrl;
          apiData = mergeOpenApiEndpoints(apiData, openApiSpec.endpoints, specBaseUrl);
        }

        // Auto-test GET endpoints
        let testSummary: {
          total: number;
          verified: number;
          failed: number;
          skipped: number;
          results: Array<{ method: string; path: string; ok: boolean; hasData: boolean }>;
        } | null = null;
        if (shouldTest && Object.keys(apiData.endpoints).length > 0) {
          try {
            const { testGetEndpoints } = await import("../../endpoint-tester.js");
            testSummary = await testGetEndpoints(
              apiData.baseUrl,
              apiData.endpoints,
              apiData.authHeaders,
              { ...apiData.cookies, ...cookies },
            );

            // Mark endpoints as verified based on test results
            for (const tr of testSummary.results) {
              for (const [, reqs] of Object.entries(apiData.endpoints)) {
                for (const r of reqs as any[]) {
                  if (r.path === tr.path && r.method === tr.method) {
                    r.verified = tr.ok && tr.hasData;
                  }
                }
              }
            }
          } catch (testErr) {
            logger.warn(`[unbrowse] Endpoint testing failed: ${(testErr as Error).message}`);
          }
        }

        const result = await generateSkill(apiData, outDir, {
          verifiedEndpoints: testSummary?.verified,
          unverifiedEndpoints: testSummary?.failed,
          openApiSource: crawlResult?.openApiSource,
          pagesCrawled: crawlResult?.pagesCrawled,
        });
        discovery.markLearned(result.service);

        // Detect and save refresh token config
        detectAndSaveRefreshConfig(har.log?.entries ?? [], join(result.skillDir, "auth.json"), logger);

        // Auto-publish if skill content changed
        let publishedVersion: string | null = null;
        if (result.changed) {
          publishedVersion = await autoPublishSkill(result.service, result.skillDir);
        }

        // Build summary
        const summaryLines = [
          `Captured (${method}): ${requestCount} requests from ${urls.length} page(s)`,
        ];
        if (crawlResult && crawlResult.pagesCrawled > 0) {
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
        }
        summaryLines.push(
          `Auth headers: ${result.authHeaderCount} | Cookies: ${result.cookieCount}`,
          `Installed: ${result.skillDir}`,
        );
        if (publishedVersion) {
          summaryLines.push(`Published: ${publishedVersion} (auto-synced to cloud index)`);
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
            `   The site may be blocking automated crawls. Skill may be incomplete.`,
            `   Try: unbrowse_replay with useStealth=true, or the browse tool for manual exploration.`,
          );
          logger.warn(`[unbrowse] High failure rate (${Math.round(failureRate * 100)}%) — ${failureDetails.join(", ")}`);
        }

        logger.info(
          `[unbrowse] Capture → ${result.service} (${result.endpointCount} endpoints, ${crawlResult?.pagesCrawled ?? 0} crawled, via ${method})`,
        );
        return { content: [{ type: "text", text: summaryLines.join("\n") }] };
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("Target page, context or browser has been closed")) {
          return { content: [{ type: "text", text: "Browser context closed unexpectedly. Try again." }] };
        }
        if (msg.includes("playwright")) {
          return { content: [{ type: "text", text: `Playwright not available: ${msg}. Install with: bun add playwright` }] };
        }
        return { content: [{ type: "text", text: `Capture failed: ${msg}` }] };
      }
    },
  };
}
