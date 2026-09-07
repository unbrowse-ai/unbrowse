/**
 * @experimental Optional embedding adapter; not a policy claim for legacy CLI gestures.
 * Provider-safe raw CDP tool surface.
 *
 * This module deliberately has no browser import. Callers bind the surface to
 * the CDP/Kuri connection they own by supplying a transport and (optionally) a
 * session id. This keeps browser lifetime and target selection outside the tool
 * definition.
 */

export type BrowserParameters = Record<string, unknown>;
export type MaybePromise<T> = T | Promise<T>;

export interface CDPTransport {
  /** Send a command on an existing CDP-compatible connection. */
  send(method: string, params: BrowserParameters, sessionId?: string): Promise<unknown>;
}

export interface BrowserPermissionInvocation {
  surface: "cdp" | "extension";
  method: string;
  params: Readonly<BrowserParameters>;
  sessionId?: string;
}

export type BrowserPermissionResult =
  | void
  | boolean
  | { decision: "allow" | "ask" | "deny"; reason?: string };

/**
 * Integration seam for the runtime permission dispatcher. A dispatcher may
 * throw, return false, or return an ask/deny decision to stop an invocation.
 */
export type BrowserPermissionDispatcher = (
  invocation: BrowserPermissionInvocation,
) => MaybePromise<BrowserPermissionResult>;

export interface CDPTool {
  name: "browser_cdp";
  ephemeral: number;
  invoke: (input?: BrowserParameters) => Promise<unknown>;
}

export interface CDPSurfaceOptions {
  /** CDP session is bound here, never accepted from model-controlled input. */
  sessionId?: string | (() => MaybePromise<string | undefined>);
  /** Required fail-closed gate, called after validation and before transport I/O. */
  permissionDispatcher: BrowserPermissionDispatcher;
}

type ParameterGuard = (params: BrowserParameters) => void;

function fail(method: string, detail: string): never {
  throw new TypeError(`browser_cdp_invalid_params:${method}:${detail}`);
}

function stringParam(method: string, params: BrowserParameters, key: string): void {
  if (typeof params[key] !== "string" || (params[key] as string).length === 0) fail(method, `${key}_required`);
}

function numberParam(method: string, params: BrowserParameters, key: string): void {
  if (typeof params[key] !== "number" || !Number.isFinite(params[key])) fail(method, `${key}_number_required`);
}

function optionalBoolean(method: string, params: BrowserParameters, key: string): void {
  if (key in params && typeof params[key] !== "boolean") fail(method, `${key}_must_be_boolean`);
}

function noRequiredParams(_params: BrowserParameters): void {}

const METHOD_GUARDS = {
  "Page.navigate": (p) => stringParam("Page.navigate", p, "url"),
  "Page.reload": noRequiredParams,
  "Page.captureScreenshot": noRequiredParams,
  "Page.printToPDF": noRequiredParams,
  "Runtime.evaluate": (p) => stringParam("Runtime.evaluate", p, "expression"),
  "Runtime.callFunctionOn": (p) => stringParam("Runtime.callFunctionOn", p, "functionDeclaration"),
  "DOM.querySelector": (p) => {
    numberParam("DOM.querySelector", p, "nodeId");
    stringParam("DOM.querySelector", p, "selector");
  },
  "DOM.querySelectorAll": (p) => {
    numberParam("DOM.querySelectorAll", p, "nodeId");
    stringParam("DOM.querySelectorAll", p, "selector");
  },
  "DOM.getDocument": noRequiredParams,
  "DOM.describeNode": noRequiredParams,
  "DOM.focus": noRequiredParams,
  "Input.dispatchMouseEvent": (p) => {
    stringParam("Input.dispatchMouseEvent", p, "type");
    numberParam("Input.dispatchMouseEvent", p, "x");
    numberParam("Input.dispatchMouseEvent", p, "y");
  },
  "Input.dispatchKeyEvent": (p) => stringParam("Input.dispatchKeyEvent", p, "type"),
  "Input.insertText": (p) => stringParam("Input.insertText", p, "text"),
  "Input.dispatchTouchEvent": (p) => {
    stringParam("Input.dispatchTouchEvent", p, "type");
    if (!Array.isArray(p.touchPoints)) fail("Input.dispatchTouchEvent", "touchPoints_array_required");
  },
  "Network.enable": noRequiredParams,
  "Network.setUserAgentOverride": (p) => stringParam("Network.setUserAgentOverride", p, "userAgent"),
  "Network.setExtraHTTPHeaders": (p) => {
    if (!isPlainRecord(p.headers)) fail("Network.setExtraHTTPHeaders", "headers_object_required");
    for (const value of Object.values(p.headers)) {
      if (typeof value !== "string") fail("Network.setExtraHTTPHeaders", "header_values_must_be_strings");
    }
  },
  "Target.createTarget": (p) => stringParam("Target.createTarget", p, "url"),
  "Target.attachToTarget": (p) => {
    stringParam("Target.attachToTarget", p, "targetId");
    optionalBoolean("Target.attachToTarget", p, "flatten");
  },
  "Browser.getVersion": noRequiredParams,
} satisfies Record<string, ParameterGuard>;

export type CDPMethod = keyof typeof METHOD_GUARDS;
export const CDP_METHODS = Object.freeze(Object.keys(METHOD_GUARDS) as CDPMethod[]);

function isPlainRecord(value: unknown): value is BrowserParameters {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readCommand(input: BrowserParameters | undefined): {
  method: CDPMethod;
  params: BrowserParameters;
} {
  if (!isPlainRecord(input)) throw new TypeError("browser_cdp_input_must_be_an_object");
  const method = input.method;
  if (typeof method !== "string" || !Object.hasOwn(METHOD_GUARDS, method)) {
    throw new TypeError("browser_cdp_method_not_allowed");
  }
  const params = input.params === undefined ? {} : input.params;
  if (!isPlainRecord(params)) throw new TypeError(`browser_cdp_invalid_params:${method}:object_required`);
  return { method: method as CDPMethod, params };
}

async function resolveSession(options: CDPSurfaceOptions): Promise<string | undefined> {
  const value = typeof options.sessionId === "function" ? await options.sessionId() : options.sessionId;
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    throw new TypeError("browser_cdp_invalid_session_binding");
  }
  return value;
}

export async function dispatchBrowserPermission(
  dispatcher: BrowserPermissionDispatcher | undefined,
  invocation: BrowserPermissionInvocation,
): Promise<void> {
  if (!dispatcher) throw new Error("browser_permission_dispatcher_required");
  const result = await dispatcher(invocation);
  const allowed = result === undefined || result === true || (typeof result === "object" && result.decision === "allow");
  if (!allowed) {
    const reason = typeof result === "object" && result.reason ? `:${result.reason}` : "";
    throw new Error(`browser_permission_not_allowed${reason}`);
  }
}

/** Create the single provider-safe raw-CDP dispatcher bound to a live transport. */
export function createCDPTools(transport: CDPTransport, options: CDPSurfaceOptions): readonly CDPTool[] {
  if (!transport || typeof transport.send !== "function") throw new TypeError("browser_cdp_transport_required");
  if (!options || typeof options.permissionDispatcher !== "function") throw new TypeError("browser_permission_dispatcher_required");

  const tool: CDPTool = Object.freeze({
    name: "browser_cdp",
    ephemeral: 3,
    async invoke(input: BrowserParameters = {}): Promise<unknown> {
      const { method, params } = readCommand(input);
      METHOD_GUARDS[method](params);
      const sessionId = await resolveSession(options);
      await dispatchBrowserPermission(options.permissionDispatcher, {
        surface: "cdp",
        method,
        params,
        ...(sessionId === undefined ? {} : { sessionId }),
      });
      return transport.send(method, params, sessionId);
    },
  });
  return Object.freeze([tool]);
}
