import { describe, expect, test } from "bun:test";
import { createPermissionContext } from "../src/runtime/permission-gate.js";
import { createRestrictionPolicy } from "../src/runtime/restrict.js";
import { browserInvocationFingerprint, createBrowserPermissionDispatcher } from "../src/browser/permission-dispatcher.js";
import {
  CDP_METHODS,
  createCDPTools,
  type BrowserPermissionInvocation,
  type CDPTransport,
} from "../src/browser/cdp-surface.js";
import {
  createExtensionTools,
  type ExtensionCapability,
  type ExtensionMethod,
  type ExtensionTransport,
} from "../src/browser/extension-surface.js";

class RecordingCDP implements CDPTransport {
  calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  async send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    this.calls.push({ method, params, sessionId });
    return { result: { navigated: true } };
  }
}

class RecordingExtension implements ExtensionTransport {
  calls: Array<{ method: ExtensionMethod; params: Record<string, unknown> }> = [];
  capabilities = new Set<ExtensionCapability>();
  hasCapability(capability: ExtensionCapability): boolean {
    return this.capabilities.has(capability);
  }
  async invoke(method: ExtensionMethod, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    return method === "ext_getActiveTab" ? { id: 17, active: true } : { granted: true };
  }
}

const allowAllForTest = () => ({ decision: "allow" as const });

describe("browser-surface", () => {
  test("uses one provider-safe dispatcher and returns the CDP transport response", async () => {
    const transport = new RecordingCDP();
    const tools = createCDPTools(transport, { sessionId: "session-7", permissionDispatcher: allowAllForTest });

    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("browser_cdp");
    expect(tools[0]!.ephemeral).toBe(3);
    const result = await tools[0]!.invoke({
      method: "Page.navigate",
      params: { url: "https://example.com" },
      // Model input cannot replace the factory-bound session.
      sessionId: "attacker-session",
    });

    expect(result).toEqual({ result: { navigated: true } });
    expect(transport.calls).toEqual([{
      method: "Page.navigate",
      params: { url: "https://example.com" },
      sessionId: "session-7",
    }]);
  });

  test("rejects unregistered methods and malformed method parameters before I/O", async () => {
    const transport = new RecordingCDP();
    const tool = createCDPTools(transport, { permissionDispatcher: allowAllForTest })[0]!;

    expect(CDP_METHODS).toContain("Runtime.evaluate");
    await expect(tool.invoke({ method: "Page.close", params: {} })).rejects.toThrow("method_not_allowed");
    await expect(tool.invoke({ method: "Page.navigate", params: {} })).rejects.toThrow("url_required");
    await expect(tool.invoke({ method: "DOM.querySelector", params: { nodeId: 1 } })).rejects.toThrow("selector_required");
    expect(transport.calls).toHaveLength(0);
  });

  test("refuses to construct browser tools without a permission dispatcher", () => {
    expect(() => createCDPTools(new RecordingCDP(), undefined as never)).toThrow("browser_permission_dispatcher_required");
    expect(() => createExtensionTools(new RecordingExtension(), undefined as never)).toThrow("browser_permission_dispatcher_required");
  });

  test("runs the permission dispatcher for every CDP invocation", async () => {
    const transport = new RecordingCDP();
    const checked: BrowserPermissionInvocation[] = [];
    const tool = createCDPTools(transport, {
      sessionId: async () => "bound-session",
      permissionDispatcher(invocation) {
        checked.push(invocation);
        return { decision: "deny", reason: "test_policy" };
      },
    })[0]!;

    await expect(tool.invoke({ method: "Browser.getVersion", params: {} })).rejects.toThrow("test_policy");
    expect(checked).toEqual([{
      surface: "cdp",
      method: "Browser.getVersion",
      params: {},
      sessionId: "bound-session",
    }]);
    expect(transport.calls).toHaveLength(0);
  });

  test("uses live extension transport state and never synthesizes an active tab", async () => {
    const transport = new RecordingExtension();
    const tool = createExtensionTools(transport, { permissionDispatcher: allowAllForTest }).find((candidate) => candidate.name === "ext_getActiveTab")!;

    await expect(tool.invoke()).rejects.toThrow("extension_capability_unavailable:activeTab");
    expect(transport.calls).toHaveLength(0);

    transport.capabilities.add("activeTab");
    const result = await tool.invoke();
    expect(result).toEqual({ id: 17, active: true });
    expect(transport.calls).toEqual([{ method: "ext_getActiveTab", params: {} }]);
  });

  test("guards extension parameters, capabilities, and permissions on each call", async () => {
    const transport = new RecordingExtension();
    transport.capabilities.add("permissions");
    let checks = 0;
    const permissionTool = createExtensionTools(transport, {
      permissionDispatcher() {
        checks += 1;
        return checks === 1;
      },
    }).find((candidate) => candidate.name === "ext_queryPermission")!;

    await expect(permissionTool.invoke({})).rejects.toThrow("permission_required");
    expect(checks).toBe(0);
    expect(await permissionTool.invoke({ permission: "tabs" })).toEqual({ granted: true });
    await expect(permissionTool.invoke({ permission: "history" })).rejects.toThrow("browser_permission_not_allowed");
    expect(checks).toBe(2);
    expect(transport.calls).toEqual([{
      method: "ext_queryPermission",
      params: { permission: "tabs" },
    }]);

    transport.capabilities.delete("permissions");
    await expect(permissionTool.invoke({ permission: "tabs" })).rejects.toThrow("extension_capability_unavailable");
    expect(checks).toBe(2);
  });
  test("composes baseline safety, permission decisions, and evidence restrictions", async () => {
    const transport = new RecordingCDP();
    const permission = createPermissionContext(() => 1_000);
    const permissionDispatcher = createBrowserPermissionDispatcher({
      permission,
      workspaceTrusted: true,
      restrictions: createRestrictionPolicy({ deny: ["Browser.getVersion"] }, CDP_METHODS),
    });
    const tool = createCDPTools(transport, { permissionDispatcher })[0]!;

    await expect(tool.invoke({ method: "Browser.getVersion", params: {} })).rejects.toThrow("evidence_restriction");
    await expect(tool.invoke({ method: "Runtime.evaluate", params: { expression: "document.cookie" } })).rejects.toThrow("mutation_approval_required");
    await expect(tool.invoke({ method: "Page.navigate", params: { url: "file:///etc/passwd" } })).rejects.toThrow("navigation_protocol_denied");
    expect(transport.calls).toHaveLength(0);
  });

  test("applies evidence denial before asking for or consuming mutation approval", async () => {
    const permission = createPermissionContext(() => 1_000);
    const invocation = { surface: "cdp" as const, method: "Runtime.evaluate", params: { expression: "1" } };
    const grant = permission.issueApproval({
      operation_fingerprint: browserInvocationFingerprint(invocation),
      effect: "mutation",
    });
    const dispatcher = createBrowserPermissionDispatcher({
      permission,
      workspaceTrusted: true,
      approvalToken: grant.token,
      restrictions: createRestrictionPolicy({ deny: ["Runtime.evaluate"] }, CDP_METHODS),
    });
    expect(await dispatcher(invocation)).toEqual({ decision: "deny", reason: "evidence_restriction" });
    expect(permission.evaluate({
      operation_fingerprint: browserInvocationFingerprint(invocation),
      effect: "mutation",
      workspace_trusted: true,
      approval_token: grant.token,
    }).decision).toBe("allow");
  });

});
