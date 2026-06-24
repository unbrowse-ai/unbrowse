// gui-contract-bridge.ts — map a captured GUI element (a kuri a11y-snapshot node) to a /contract-shaped
// ledger entry. POINTER not payload (CLAUDE.md): the contract carries the element's IDENTITY
// (ref/role/name/page-url), never the dumped DOM bytes — the entry is a pointer to the live element.
// Pure + deterministic; the resulting ContractEverything is recorded via the existing persistContract path.
import { sha256Hex } from "./build-attest";
import type { ContractEverything } from "./contract-everything";

/**
 * The interactive-element shape parsed from a kuri a11y snapshot
 * (submodules/kuri/src/snapshot/a11y.zig `A11yNode`: ref/role/name/value/state).
 */
export interface GuiElement {
  ref: string; // agent-actionable ref, e.g. "e0"
  role: string; // a11y role, e.g. "button" | "link" | "textbox"
  name: string; // display name / label
  state?: string; // e.g. "checked=false required"
  value?: string; // input value (for textbox etc.)
}

/**
 * Map one interactive GUI element to a /contract-shaped entry ({id, text, value}), recordable via
 * persistContract. Deterministic: the same element on the same page yields the same content-addressed id.
 */
export function a11yNodeToContract(el: GuiElement, pageUrl: string): ContractEverything {
  const ref = String(el.ref ?? "").trim();
  const role = String(el.role ?? "").trim();
  const name = String(el.name ?? "").trim();
  // content-addressed id over the element's IDENTITY. JSON-encode the field array so a separator char
  // (e.g. a newline) inside a field cannot inject a collision between distinct elements (Day-5 sheep).
  const id = "gui-" + sha256Hex(Buffer.from(JSON.stringify([pageUrl, role, ref, name]))).slice(0, 16);
  // pointer-shaped claim: the WHAT (an interactive element on a page), never the DOM payload
  const text = `${role || "element"} '${name}' @ ${pageUrl} → ${ref || "(no-ref)"}`;
  const value = { kind: "gui-element", ref, role, name, state: String(el.state ?? "").trim(), pageUrl };
  return { id, text, value };
}
