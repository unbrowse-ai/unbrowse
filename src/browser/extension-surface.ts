/**
 * @experimental Optional embedding adapter; not used by the shipped one-shot path.
 * Extension-only browser surface. Tools are exposed only when an injected,
 * live extension transport declares the matching capability. No browser or
 * active-window state is synthesized in this module.
 */

import {
  dispatchBrowserPermission,
  type BrowserParameters,
  type BrowserPermissionDispatcher,
  type MaybePromise,
} from "./cdp-surface.js";

export type ExtensionCapability = "activeTab" | "permissions";
export type ExtensionMethod = "ext_getActiveTab" | "ext_queryPermission";

export interface ExtensionTransport {
  /** Current capabilities of the connected extension. Checked per call. */
  hasCapability(capability: ExtensionCapability): MaybePromise<boolean>;
  /** Invoke the real extension bridge and return its response unchanged. */
  invoke(method: ExtensionMethod, params: BrowserParameters): Promise<unknown>;
}

export interface ExtensionTool {
  name: ExtensionMethod;
  ephemeral?: number;
  invoke: (params?: BrowserParameters) => Promise<unknown>;
}

export interface ExtensionSurfaceOptions {
  /** Required fail-closed gate called before extension transport I/O. */
  permissionDispatcher: BrowserPermissionDispatcher;
}

interface ExtensionRegistration {
  capability: ExtensionCapability;
  ephemeral?: number;
  guard: (params: BrowserParameters) => void;
}

function isPlainRecord(value: unknown): value is BrowserParameters {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const EXTENSION_REGISTRY: Record<ExtensionMethod, ExtensionRegistration> = {
  ext_getActiveTab: {
    capability: "activeTab",
    guard: (_params) => {},
  },
  ext_queryPermission: {
    capability: "permissions",
    ephemeral: 3,
    guard: (params) => {
      if (typeof params.permission !== "string" || params.permission.length === 0) {
        throw new TypeError("extension_invalid_params:ext_queryPermission:permission_required");
      }
    },
  },
};

export const EXTENSION_METHODS = Object.freeze(Object.keys(EXTENSION_REGISTRY) as ExtensionMethod[]);

/**
 * Bind extension tools to a real transport. Capability checks happen at
 * invocation time so capability revocation cannot leak stale or invented state.
 */
export function createExtensionTools(
  transport: ExtensionTransport,
  options: ExtensionSurfaceOptions,
): readonly ExtensionTool[] {
  if (!transport || typeof transport.invoke !== "function" || typeof transport.hasCapability !== "function") {
    throw new TypeError("extension_transport_required");
  }
  if (!options || typeof options.permissionDispatcher !== "function") {
    throw new TypeError("browser_permission_dispatcher_required");
  }

  return Object.freeze(EXTENSION_METHODS.map((method): ExtensionTool => {
    const registration = EXTENSION_REGISTRY[method];
    return Object.freeze({
      name: method,
      ...(registration.ephemeral === undefined ? {} : { ephemeral: registration.ephemeral }),
      async invoke(input: BrowserParameters = {}): Promise<unknown> {
        if (!isPlainRecord(input)) throw new TypeError(`extension_invalid_params:${method}:object_required`);
        registration.guard(input);
        if (!await transport.hasCapability(registration.capability)) {
          throw new Error(`extension_capability_unavailable:${registration.capability}`);
        }
        await dispatchBrowserPermission(options.permissionDispatcher, {
          surface: "extension",
          method,
          params: input,
        });
        return transport.invoke(method, input);
      },
    });
  }));
}
