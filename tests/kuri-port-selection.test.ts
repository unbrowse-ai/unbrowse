import { describe, expect, it } from "bun:test";
import { resolveIsolatedKuriPort, resolveKuriPort } from "../src/kuri/client.js";

describe("resolveKuriPort", () => {
  it("keeps the preferred port when it is already healthy", async () => {
    const port = await resolveKuriPort(7700, {
      isHealthyPort: async (candidate) => candidate === 7700,
      isPortOpen: async () => true,
      searchLimit: 3,
    });
    expect(port).toBe(7700);
  });

  it("keeps the preferred port when it is free", async () => {
    const port = await resolveKuriPort(7700, {
      isHealthyPort: async () => false,
      isPortOpen: async (candidate) => candidate !== 7700,
      searchLimit: 3,
    });
    expect(port).toBe(7700);
  });

  it("falls forward when the preferred port is wedged", async () => {
    const port = await resolveKuriPort(7700, {
      isHealthyPort: async (candidate) => candidate === 7702,
      isPortOpen: async (candidate) => candidate === 7700 || candidate === 7701 || candidate === 7702,
      searchLimit: 4,
    });
    expect(port).toBe(7702);
  });

  it("picks the first free candidate when no healthy listener exists", async () => {
    const port = await resolveKuriPort(7700, {
      isHealthyPort: async () => false,
      isPortOpen: async (candidate) => candidate === 7700 || candidate === 7701,
      searchLimit: 4,
    });
    expect(port).toBe(7702);
  });
});

describe("resolveIsolatedKuriPort", () => {
  it("never aliases the rejected foreign broker and picks the first free owned port", async () => {
    const inspected: number[] = [];
    const port = await resolveIsolatedKuriPort(7700, {
      // 7701 may even be a healthy broker; occupied is occupied and therefore
      // never eligible for an isolated owned launch.
      isPortOpen: async (candidate) => {
        inspected.push(candidate);
        return candidate === 7701;
      },
      searchLimit: 3,
    });
    expect(port).toBe(7702);
    expect(inspected).not.toContain(7700);
  });

  it("fails closed when every isolated candidate is occupied", async () => {
    await expect(resolveIsolatedKuriPort(7700, {
      isPortOpen: async () => true,
      searchLimit: 2,
    })).rejects.toThrow("No free isolated Kuri broker port after 7700");
  });
});
