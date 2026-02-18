import { executeInBrowser } from "../capture/index.js";
import { getCredential } from "../vault/index.js";
import type { EndpointDescriptor, ExecutionTrace, SkillManifest } from "../types/index.js";
import { nanoid } from "nanoid";

export interface ExecutionResult {
  trace: ExecutionTrace;
  result: unknown;
}

export async function executeSkill(
  skill: SkillManifest,
  params: Record<string, unknown> = {}
): Promise<ExecutionResult> {
  const endpoint = skill.endpoints.find((e) => e.idempotency === "safe") ?? skill.endpoints[0];
  return executeEndpoint(skill, endpoint, params);
}

export async function executeEndpoint(
  skill: SkillManifest,
  endpoint: EndpointDescriptor,
  params: Record<string, unknown> = {}
): Promise<ExecutionResult> {
  const startedAt = new Date().toISOString();
  const authHeaders: Record<string, string> = {};
  const cookies: Array<{ name: string; value: string; domain: string }> = [];

  if (skill.auth_profile_ref) {
    const stored = await getCredential(skill.auth_profile_ref);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as {
          headers?: Record<string, string>;
          cookies?: typeof cookies;
        };
        Object.assign(authHeaders, parsed.headers ?? {});
        cookies.push(...(parsed.cookies ?? []));
      } catch {
        // malformed stored cred — skip
      }
    }
  }

  const url = interpolate(endpoint.url_template, params);
  const body = endpoint.body ? interpolateObj(endpoint.body, params) : undefined;

  const { status, data, trace_id } = await executeInBrowser(
    url,
    endpoint.method,
    endpoint.headers_template ?? {},
    body,
    authHeaders,
    cookies
  );

  const trace: ExecutionTrace = {
    trace_id,
    skill_id: skill.skill_id,
    endpoint_id: endpoint.endpoint_id,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    success: status >= 200 && status < 300,
    status_code: status,
  };

  if (!trace.success) {
    trace.error = `HTTP ${status}`;
  } else {
    trace.result = data;
  }

  return { trace, result: data };
}

function interpolate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    params[k] != null ? String(params[k]) : `{${k}}`
  );
}

function interpolateObj(
  obj: Record<string, unknown>,
  params: Record<string, unknown>
): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(obj).replace(/"(\{(\w+)\})"/g, (_, _full, k) =>
      params[k] != null ? JSON.stringify(params[k]) : `"{${k}}"`
    )
  ) as Record<string, unknown>;
}
