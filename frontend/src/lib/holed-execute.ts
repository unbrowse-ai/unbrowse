/**
 * holed-execute — the verb atom, wired into the live hero loop.
 *
 * The "tool with holes" model says the LLM never writes a URL: it resolves a
 * skill (get_route), then supplies {endpoint_id, values} for that skill's
 * endpoint. The loop builds the executable URL HERE — from the manifest's own
 * template (endpointToHoledTool) filled with the public hole values
 * (fillHoledTool). Secret/vault holes stay open for the browser at fetch time.
 *
 * This is strictly safer than executing an LLM-written URL: the model cannot
 * propose an off-skill host or path at all — the template is fixed by the
 * manifest, and an unknown endpoint_id is refused.
 *
 * Backward-compatible: when the LLM gives a raw {url} (the cold path, or an
 * older schema), resolveHoledExecute returns kind:"url" and the loop keeps its
 * existing seal + SSRF guard. No regression.
 */
import { endpointToHoledTool, fillHoledTool } from "./holed-tool-fill";
import type { SkillManifestLite } from "./recommend-guard";

export type HoledExecuteResult =
  | { kind: "holed"; ok: true; url: string; method: string; endpoint_id: string }
  | { kind: "holed"; ok: false; reason: string }
  | { kind: "url"; url: string };

interface ExecuteArgs {
  endpoint_id?: string;
  values?: Record<string, string>;
  url?: string;
}

/** Resolve a loop execute step. If the LLM supplied an endpoint_id, build the
 *  URL from the resolved skill's template (the holed-tool path); otherwise fall
 *  through to the raw-url path for the caller's existing seal to handle. */
export function resolveHoledExecute(
  args: ExecuteArgs,
  seenManifests: SkillManifestLite[],
): HoledExecuteResult {
  const endpointId = typeof args.endpoint_id === "string" ? args.endpoint_id.trim() : "";
  if (!endpointId) {
    return { kind: "url", url: String(args.url ?? "") };
  }

  // Find the endpoint the LLM named among the skills it actually resolved this
  // loop. An endpoint_id no resolved skill owns is a hallucination — refuse it.
  let ep: NonNullable<SkillManifestLite["endpoints"]>[number] | undefined;
  for (const m of seenManifests) {
    ep = (m.endpoints ?? []).find((e) => e.endpoint_id === endpointId);
    if (ep) break;
  }
  if (!ep) {
    return { kind: "holed", ok: false, reason: `no resolved skill owns endpoint "${endpointId}"` };
  }

  const tool = endpointToHoledTool({
    endpoint_id: ep.endpoint_id,
    method: ep.method,
    url: ep.url,
    url_template: ep.url_template,
  });
  const filled = fillHoledTool(tool, args.values ?? {});
  if (!filled.ok) {
    return { kind: "holed", ok: false, reason: filled.reason };
  }
  return { kind: "holed", ok: true, url: filled.url, method: filled.method, endpoint_id: endpointId };
}
