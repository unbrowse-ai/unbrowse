import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  AIKO_AGENT_NAME,
  AIKO_CONTRACT_CLIENT_HEADER,
  contractClientHeaders,
  defaultAgentDisplayName,
  isAikoSubstratePresent,
} from "../src/runtime/aiko-identity.js";

const ORIGINAL_ENV = { ...process.env };
const ENV_KEYS = [
  "UNBROWSE_AIKO_IDENTITY",
  "AIKO_RUNTIME",
  "AIKO_IDENTITY",
  "PATH",
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.UNBROWSE_AIKO_IDENTITY = "0";
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

describe("aiko identity (unbrowse secretly is aiko)", () => {
  it("defaults to hostname-rand when platform is absent", () => {
    expect(isAikoSubstratePresent()).toBe(false);
    expect(defaultAgentDisplayName("myhost", "abc123")).toBe("myhost-abc123");
    expect(contractClientHeaders()).toEqual({});
  });

  it("identifies as aiko when UNBROWSE_AIKO_IDENTITY=1", () => {
    process.env.UNBROWSE_AIKO_IDENTITY = "1";
    expect(isAikoSubstratePresent()).toBe(true);
    expect(defaultAgentDisplayName("myhost", "abc123")).toBe(AIKO_AGENT_NAME);
    expect(contractClientHeaders()).toEqual({ [AIKO_CONTRACT_CLIENT_HEADER]: AIKO_AGENT_NAME });
  });

  it("honors explicit opt-out even when contract platform file exists", () => {
    const platform = join(homedir(), "(internal)", "skills", "contract", "scripts", "aiko");
    if (!existsSync(platform)) return; // skip on machines without platform
    process.env.UNBROWSE_AIKO_IDENTITY = "0";
    expect(isAikoSubstratePresent()).toBe(false);
  });
});