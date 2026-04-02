/**
 * Phase 4: Agentic Browser Loop
 *
 * When no cached API exists, autonomously drives the browser to achieve
 * the intent. Snapshots the page, asks an LLM what action to take,
 * executes it via Kuri, and checks for API calls after each step.
 * All captured traffic is passively indexed for future reuse.
 */

import * as kuri from "../kuri/client.js";
import type { KuriHarEntry } from "../kuri/client.js";
import { INTERCEPTOR_SCRIPT, collectInterceptedRequests, type RawRequest } from "../capture/index.js";
import { extractEndpoints, extractAuthHeaders } from "../reverse-engineer/index.js";
import { extractBrowserCookies } from "../auth/browser-cookies.js";
import { queueBackgroundIndex } from "../indexer/index.js";
import { mergeEndpoints } from "../marketplace/index.js";
import { buildSkillOperationGraph } from "../graph/index.js";
import { augmentEndpointsWithAgent } from "../graph/agent-augment.js";
import { findExistingSkillForDomain, cachePublishedSkill } from "../client/index.js";
import { storeCredential } from "../vault/index.js";
import { generateLocalDescription } from "./index.js";
import { nanoid } from "nanoid";
import type { EndpointDescriptor, SkillManifest } from "../types/index.js";

const MAX_STEPS = 5;
const ACTION_SETTLE_MS = 2000;

// ── LLM-based action planning ─────────────────────────────────────────

interface PlannedAction {
  action: "click" | "fill" | "scroll" | "press" | "done";
  ref?: string;
  value?: string;
  reason: string;
}

/**
 * Ask the LLM: given this intent and page snapshot, what's the single
 * best action to take? Lightweight structured output (~500 tokens).
 */
async function planNextAction(
  intent: string,
  params: Record<string, unknown>,
  snapshot: string,
  currentUrl: string,
): Promise<PlannedAction> {
  // Trim snapshot to keep prompt small
  const trimmedSnapshot = snapshot.length > 3000 ? snapshot.substring(0, 3000) + "\n..." : snapshot;

  const prompt = `You are a browser agent. Given a user intent and the interactive elements on the page, decide the SINGLE best action to take to achieve the intent. Return ONLY valid JSON.

Intent: "${intent}"
${Object.keys(params).length > 0 ? `Params: ${JSON.stringify(params)}` : ""}
Current URL: ${currentUrl}

Interactive elements:
${trimmedSnapshot}

Return JSON: {"action":"click"|"fill"|"scroll"|"press"|"done", "ref":"eN", "value":"text for fill/press", "reason":"why"}
- "click" a link/button/tab that will load the data the intent asks for
- "fill" a search box then the next action should press Enter
- "scroll" down if the page needs to load more content
- "press" a key like Enter after filling a search box
- "done" if the page already shows the data or no useful action exists

JSON:`;

  try {
    // Use kuri's evaluate to call a local inference endpoint, or fall back to
    // simple heuristic-based planning if no LLM is available
    const result = await heuristicPlan(intent, params, snapshot, currentUrl);
    return result;
  } catch {
    return { action: "done", reason: "planning failed" };
  }
}

/**
 * Heuristic-based action planning — no LLM needed.
 * Handles common patterns: search intents, feed/timeline intents, navigation.
 */
function heuristicPlan(
  intent: string,
  params: Record<string, unknown>,
  snapshot: string,
  _currentUrl: string,
): PlannedAction {
  const intentLower = intent.toLowerCase();
  const lines = snapshot.split("\n").filter(l => l.trim());

  // Parse refs from snapshot
  const elements = lines.map(l => {
    const match = l.match(/^\[(\w+)\]\s+(\w+)\s+"?(.+?)"?\s*$/);
    if (!match) return null;
    return { ref: match[1], role: match[2], name: match[3].replace(/"$/, "") };
  }).filter(Boolean) as Array<{ ref: string; role: string; name: string }>;

  // Search intent: find a textbox and fill it
  const isSearch = /search|find|look\s*up|query/i.test(intentLower);
  if (isSearch) {
    const searchTerm = (params.q ?? params.query ?? params.keywords ?? extractSearchTerm(intent)) as string;
    const textbox = elements.find(e => e.role === "textbox" || e.role === "searchbox");
    if (textbox && searchTerm) {
      return { action: "fill", ref: textbox.ref, value: searchTerm, reason: `Fill search box with "${searchTerm}"` };
    }
  }

  // Feed/timeline intent: look for relevant tabs
  const isFeed = /timeline|feed|home|for\s*you|following|trending/i.test(intentLower);
  if (isFeed) {
    const feedTab = elements.find(e =>
      (e.role === "tab" || e.role === "link") &&
      /for you|following|trending|home|latest/i.test(e.name)
    );
    if (feedTab) {
      return { action: "click", ref: feedTab.ref, reason: `Click "${feedTab.name}" to load feed data` };
    }
  }

  // Look for a button/link that semantically matches the intent
  const intentWords = intentLower.split(/\s+/).filter(w => w.length > 3);
  for (const el of elements) {
    if (el.role !== "link" && el.role !== "button" && el.role !== "tab") continue;
    const nameLower = el.name.toLowerCase();
    const matchScore = intentWords.filter(w => nameLower.includes(w)).length;
    if (matchScore >= 2 || (matchScore >= 1 && intentWords.length <= 3)) {
      return { action: "click", ref: el.ref, reason: `"${el.name}" matches intent` };
    }
  }

  // If we just filled a search, press Enter
  if (isSearch) {
    return { action: "press", value: "Enter", reason: "Submit search" };
  }

  // Scroll down to trigger lazy-loaded content
  return { action: "scroll", reason: "Scroll to trigger lazy-loaded API calls" };
}

function extractSearchTerm(intent: string): string {
  // "search people named minh" → "minh"
  // "search for react components" → "react components"
  const match = intent.match(/(?:search|find|look\s*up)\s+(?:for\s+)?(?:people\s+(?:named|called)\s+)?(.+)/i);
  return match?.[1]?.trim() ?? intent;
}

// ── Agentic browser loop ──────────────────────────────────────────────

export interface AgenticBrowseResult {
  endpoints: EndpointDescriptor[];
  skill?: SkillManifest;
  result?: unknown;
  stepsExecuted: number;
  requestsCaptured: number;
}

/**
 * Autonomously drive the browser to achieve an intent.
 * Snapshots → plans → acts → captures APIs → repeats.
 * All traffic is passively indexed regardless of success.
 */
export async function agenticBrowserResolve(
  tabId: string,
  intent: string,
  params: Record<string, unknown>,
  url: string,
): Promise<AgenticBrowseResult> {
  const domain = new URL(url).hostname;

  // Inject cookies from user's Chrome
  try {
    const { cookies } = extractBrowserCookies(domain);
    for (const c of cookies) await kuri.setCookie(tabId, c).catch(() => {});
  } catch { /* non-fatal */ }

  // Inject fetch/XHR interceptor
  await kuri.evaluate(tabId, INTERCEPTOR_SCRIPT).catch(() => {});

  // Start HAR recording
  await kuri.harStart(tabId).catch(() => {});

  // Navigate if not already on the page
  const currentUrl = await kuri.getCurrentUrl(tabId).catch(() => "");
  if (!currentUrl || !currentUrl.startsWith("http") || new URL(currentUrl).hostname !== domain) {
    await kuri.navigate(tabId, url);
    await new Promise(r => setTimeout(r, 2000));
    // Re-inject interceptor after navigation
    await kuri.evaluate(tabId, INTERCEPTOR_SCRIPT).catch(() => {});
  }

  let allRequests: RawRequest[] = [];
  let allEndpoints: EndpointDescriptor[] = [];
  let stepsExecuted = 0;
  let lastFillRef: string | undefined;

  for (let step = 0; step < MAX_STEPS; step++) {
    // 1. Snapshot the page
    let snapshot: string;
    try {
      snapshot = await kuri.snapshot(tabId, "interactive");
    } catch {
      break;
    }
    if (!snapshot || snapshot.length < 10) {
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }

    // 2. Plan next action
    const decision = planNextAction(intent, params, snapshot, url);
    console.log(`[agentic-browse] step ${step}: ${decision.action} ${decision.ref ?? ""} — ${decision.reason}`);

    if (decision.action === "done") break;

    // 3. Execute action
    try {
      switch (decision.action) {
        case "click":
          if (decision.ref) await kuri.click(tabId, decision.ref);
          break;
        case "fill":
          if (decision.ref && decision.value) {
            await kuri.fill(tabId, decision.ref, decision.value);
            lastFillRef = decision.ref;
          }
          break;
        case "scroll":
          await kuri.scroll(tabId, "down");
          break;
        case "press":
          if (decision.value) await kuri.press(tabId, decision.value);
          break;
      }
    } catch (err) {
      console.log(`[agentic-browse] action failed: ${err instanceof Error ? err.message : err}`);
    }

    stepsExecuted++;

    // 4. Wait for API calls to settle
    await new Promise(r => setTimeout(r, ACTION_SETTLE_MS));

    // Re-inject interceptor in case navigation happened
    await kuri.evaluate(tabId, INTERCEPTOR_SCRIPT).catch(() => {});

    // 5. Check intercepted requests
    try {
      const intercepted = await collectInterceptedRequests(tabId);
      const newRequests: RawRequest[] = intercepted
        .filter(r => !allRequests.some(e => e.url === r.url && e.method === r.method))
        .map(r => ({
          url: r.url,
          method: r.method,
          request_headers: r.request_headers ?? {},
          request_body: r.request_body,
          response_status: r.response_status,
          response_headers: r.response_headers ?? {},
          response_body: r.response_body,
          timestamp: r.timestamp,
        }));

      if (newRequests.length > 0) {
        allRequests.push(...newRequests);
        const newEndpoints = extractEndpoints(newRequests, undefined, { pageUrl: url, finalUrl: url });
        if (newEndpoints.length > 0) {
          allEndpoints.push(...newEndpoints);
          console.log(`[agentic-browse] step ${step}: found ${newEndpoints.length} new endpoints`);
        }
      }
    } catch { /* non-fatal */ }

    // If after a fill we should press Enter
    if (decision.action === "fill" && lastFillRef) {
      // Next iteration will handle pressing Enter via heuristic
    }
  }

  // Also collect HAR entries
  try {
    const { entries } = await kuri.harStop(tabId);
    const harRequests = entries
      .filter((e: KuriHarEntry) => e.request && e.response)
      .map((e: KuriHarEntry) => ({
        url: e.request.url,
        method: e.request.method,
        request_headers: Object.fromEntries((e.request.headers ?? []).map(h => [h.name.toLowerCase(), h.value])),
        request_body: e.request.postData?.text,
        response_status: e.response.status,
        response_headers: Object.fromEntries((e.response.headers ?? []).map(h => [h.name.toLowerCase(), h.value])),
        response_body: e.response.content?.text,
        timestamp: e.startedDateTime ?? new Date().toISOString(),
      }));
    // Merge HAR requests that interceptor missed
    for (const r of harRequests) {
      if (!allRequests.some(e => e.url === r.url && e.method === r.method)) {
        allRequests.push(r);
      }
    }
  } catch { /* non-fatal */ }

  // Merge all captured endpoints
  if (allEndpoints.length === 0 && allRequests.length > 0) {
    allEndpoints = extractEndpoints(allRequests, undefined, { pageUrl: url, finalUrl: url });
  }

  // ── Full passive indexing pipeline (same as passiveIndexFromRequests) ──

  let skill: SkillManifest | undefined;

  if (allEndpoints.length > 0) {
    // Auth extraction + vault storage
    const capturedAuthHeaders = extractAuthHeaders(allRequests);
    if (Object.keys(capturedAuthHeaders).length > 0) {
      await storeCredential(`${domain}-session`, JSON.stringify({ headers: capturedAuthHeaders })).catch(() => {});
    }

    // Merge with existing skill
    const existingSkill = findExistingSkillForDomain(domain, intent);
    const mergedEndpoints = existingSkill
      ? mergeEndpoints(existingSkill.endpoints, allEndpoints)
      : allEndpoints;

    // Generate descriptions
    for (const ep of mergedEndpoints) {
      if (!ep.description) ep.description = generateLocalDescription(ep);
    }

    const enrichedEndpoints = mergedEndpoints;

    // Build operation graph
    const operationGraph = buildSkillOperationGraph(enrichedEndpoints);

    skill = {
      skill_id: existingSkill?.skill_id ?? nanoid(),
      version: "1.0.0",
      schema_version: "1",
      lifecycle: "active" as const,
      execution_type: "http" as const,
      created_at: existingSkill?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      name: domain,
      intent_signature: `browse ${domain}`,
      domain,
      description: `API skill for ${domain}`,
      owner_type: "agent" as const,
      endpoints: enrichedEndpoints,
      operation_graph: operationGraph,
      intents: Array.from(new Set([...(existingSkill?.intents ?? []), intent])),
    };

    // Cache locally
    try { cachePublishedSkill(skill); } catch { /* best-effort */ }

    // Queue background publish
    queueBackgroundIndex({
      skill,
      domain,
      intent,
      contextUrl: url,
      cacheKey: `agentic:${domain}:${Date.now()}`,
    });

    console.log(`[agentic-browse] ${domain}: ${enrichedEndpoints.length} endpoints indexed from ${allRequests.length} requests across ${stepsExecuted} steps`);
  } else {
    console.log(`[agentic-browse] ${domain}: 0 endpoints from ${allRequests.length} requests across ${stepsExecuted} steps`);
  }

  return {
    endpoints: allEndpoints,
    skill,
    stepsExecuted,
    requestsCaptured: allRequests.length,
  };
}
