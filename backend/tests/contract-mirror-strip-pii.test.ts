import { describe, it, expect } from "bun:test";
import { handleMirror, handleStatus, type MirrorRequest, type ContractEventRow } from "../src/routes/contract.js";

/** Minimal in-memory ledger matching the ContractLedger contract.
 *  Used in lieu of postgresLedger for unit-level isolation. */
function mem(): {
  rows: ContractEventRow[];
  append: (r: ContractEventRow) => Promise<ContractEventRow>;
  get: (id: string) => Promise<ContractEventRow[] | null>;
  listAll: () => Promise<ContractEventRow[]>;
  listChildren: (parentId: string) => Promise<ContractEventRow[]>;
} {
  const rows: ContractEventRow[] = [];
  return {
    rows,
    async append(r) {
      const stamped = { ...r, ts: r.ts || new Date().toISOString() };
      rows.push(stamped);
      return stamped;
    },
    async get(id) {
      const hit = rows.filter((r) => r.id === id);
      return hit.length ? hit : null;
    },
    async listAll() {
      return rows.slice();
    },
    async listChildren(parentId) {
      return rows.filter((r) => r.parent_id === parentId);
    },
  };
}

describe("contract mirror — strip_pii=true depersonalizes + routes to global ledger", () => {
  it("strips identity fields and writes the sanitized row to the global ledger, not the private one", async () => {
    const privateLedger = mem();
    const globalLedger = mem();

    const row: ContractEventRow = {
      event: "declared",
      id: "test-strip-pii-1",
      plan: "investor outreach to lewis@getfoundry.app went well",
      action: "agent-judges",
      pointer_type: "cli",
      ts: "2026-05-25T00:00:00.000Z",
      agent: "lewis@getfoundry.app",
      audience: ["private"],
      parent_id: "parent-organ-id",
      learning: "Contact lewis@getfoundry.app; he prefers terse replies.",
    } as ContractEventRow;

    const req: MirrorRequest = { row, strip_pii: true };
    const result = await handleMirror(req, privateLedger, { globalLedger });

    expect(result.mirrored).toBe(true);

    // Private ledger MUST be untouched.
    expect(privateLedger.rows.length).toBe(0);

    // Global ledger holds exactly one row, sanitized.
    expect(globalLedger.rows.length).toBe(1);
    const stored = globalLedger.rows[0];

    // Identity fields stripped.
    expect((stored as Record<string, unknown>).agent).toBeUndefined();
    expect((stored as Record<string, unknown>).audience).toBeUndefined();
    expect((stored as Record<string, unknown>).parent_id).toBeUndefined();

    // Truth-claim fields preserved.
    expect(stored.id).toBe("test-strip-pii-1");
    expect(stored.event).toBe("declared");
    expect(stored.action).toBe("agent-judges");

    // Text fields sanitized (email redacted).
    const sanitizedPlan = (stored as Record<string, unknown>).plan as string;
    const sanitizedLearning = (stored as Record<string, unknown>).learning as string;
    expect(sanitizedPlan).not.toContain("lewis@getfoundry.app");
    expect(sanitizedLearning).not.toContain("lewis@getfoundry.app");
  });

  it("default mirror (strip_pii falsey) writes to the caller's private ledger and keeps identity fields", async () => {
    const privateLedger = mem();
    const globalLedger = mem();

    const row: ContractEventRow = {
      event: "declared",
      id: "test-strip-pii-2",
      plan: "ordinary private claim",
      action: "agent-judges",
      pointer_type: "cli",
      ts: "2026-05-25T00:00:00.000Z",
      agent: "lewis@getfoundry.app",
      audience: ["private"],
    } as ContractEventRow;

    const req: MirrorRequest = { row, strip_pii: false };
    await handleMirror(req, privateLedger, { globalLedger });

    expect(privateLedger.rows.length).toBe(1);
    expect(globalLedger.rows.length).toBe(0);
    const stored = privateLedger.rows[0] as Record<string, unknown>;
    expect(stored.agent).toBe("lewis@getfoundry.app");
    expect((stored.audience as string[]).includes("private")).toBe(true);
  });

  it("status read against the global ledger surfaces the depersonalized row", async () => {
    const privateLedger = mem();
    const globalLedger = mem();
    const row: ContractEventRow = {
      event: "declared",
      id: "test-strip-pii-3",
      plan: "send email to alice@example.com",
      action: "agent-judges",
      pointer_type: "cli",
      ts: "2026-05-25T00:00:00.000Z",
      agent: "alice@example.com",
    } as ContractEventRow;

    await handleMirror({ row, strip_pii: true }, privateLedger, { globalLedger });
    const status = await handleStatus("test-strip-pii-3", globalLedger);
    expect(status.id).toBe("test-strip-pii-3");
    expect(status.rows.length).toBe(1);
    expect((status.rows[0] as Record<string, unknown>).agent).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("alice@example.com");
  });

  it("strip_pii=true without a globalLedger configured throws a clean error (config gap surfaced honestly)", async () => {
    const privateLedger = mem();
    const row: ContractEventRow = {
      event: "declared",
      id: "test-strip-pii-4",
      plan: "noop",
      action: "agent-judges",
      pointer_type: "cli",
      ts: "2026-05-25T00:00:00.000Z",
    } as ContractEventRow;

    await expect(
      handleMirror({ row, strip_pii: true }, privateLedger, {})
    ).rejects.toThrow(/global ledger/);
  });
});
