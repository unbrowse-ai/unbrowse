import { createHash } from "node:crypto";
import type { PermissionContext, PermissionEffect } from "../runtime/permission-gate.js";
import type { RestrictionPolicy } from "../runtime/restrict.js";
import type {
  BrowserParameters,
  BrowserPermissionDispatcher,
  BrowserPermissionInvocation,
  BrowserPermissionResult,
} from "./cdp-surface.js";

export interface BrowserPermissionPolicyOptions {
  permission: PermissionContext;
  workspaceTrusted: boolean;
  approvalToken?: string | ((invocation: BrowserPermissionInvocation) => string | undefined);
  restrictions?: RestrictionPolicy;
}

const READ_METHODS = new Set([
  "Browser.getVersion",
  "Page.navigate",
  "Page.reload",
  "Page.captureScreenshot",
  "Page.printToPDF",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.getDocument",
  "DOM.describeNode",
  "Network.enable",
  "ext_getActiveTab",
  "ext_queryPermission",
]);

const AUTH_METHODS = new Set(["Network.setExtraHTTPHeaders", "Network.setUserAgentOverride"]);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]));
}

export function browserInvocationFingerprint(invocation: BrowserPermissionInvocation): string {
  // Values are hashed into the operation identity and never copied to an audit/result envelope.
  return createHash("sha256").update(JSON.stringify(stableValue({
    surface: invocation.surface,
    method: invocation.method,
    params: invocation.params,
    sessionId: invocation.sessionId,
  }))).digest("hex");
}

export function classifyBrowserEffect(invocation: BrowserPermissionInvocation): PermissionEffect {
  if (READ_METHODS.has(invocation.method)) return "read";
  if (AUTH_METHODS.has(invocation.method)) return "authentication";
  return "mutation";
}

function unsafeNavigation(invocation: BrowserPermissionInvocation): string | undefined {
  if (invocation.method !== "Page.navigate" && invocation.method !== "Target.createTarget") return undefined;
  const raw = invocation.params.url;
  if (typeof raw !== "string") return "navigation_url_required";
  if (raw === "about:blank") return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "navigation_protocol_denied";
    if (url.username || url.password) return "navigation_embedded_credentials_denied";
  } catch {
    return "navigation_url_invalid";
  }
  return undefined;
}

/** Compose baseline safety, the stateful permission gate, and eval-derived narrowing. */
export function createBrowserPermissionDispatcher(
  options: BrowserPermissionPolicyOptions,
): BrowserPermissionDispatcher {
  if (!options?.permission) throw new TypeError("browser_permission_context_required");
  return async (invocation): Promise<BrowserPermissionResult> => {
    const baselineDenial = unsafeNavigation(invocation);
    if (baselineDenial) return { decision: "deny", reason: baselineDenial };
    if (options.restrictions) {
      const narrowed = options.restrictions.decide(invocation.method, true);
      if ("reason" in narrowed) return { decision: "deny", reason: narrowed.reason };
    }
    const approvalToken = typeof options.approvalToken === "function"
      ? options.approvalToken(invocation)
      : options.approvalToken;
    const decision = options.permission.evaluate({
      operation_fingerprint: browserInvocationFingerprint(invocation),
      effect: classifyBrowserEffect(invocation),
      workspace_trusted: options.workspaceTrusted,
      ...(approvalToken ? { approval_token: approvalToken } : {}),
    });
    return decision;
  };
}
