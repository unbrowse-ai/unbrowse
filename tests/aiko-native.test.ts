import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  AIKO_TOKEN_HEADER,
  aikoNativeHeaders,
  isAikoTokenNative,
  loadAikoTokenMint,
} from "../src/runtime/aiko-native.js";

const ORIGINAL_ENV = { ...process.env };
const ENV_KEYS = [
  "UNBROWSE_AIKO_IDENTITY",
  "UNBROWSE_AIKO_NATIVE",
  "AIKO_MINT",
  "AIKO_RUNTIME",
] as const;

const TEST_MINT = "9SAEMejUHuRRczb3xdtp5cQdWvx7mfmyjgoQTjgtfocp";
const TOKEN_PATH = join(homedir(), ".aiko", "token.json");
let hadToken = false;
let priorToken: string | null = null;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.UNBROWSE_AIKO_IDENTITY = "1";
  hadToken = existsSync(TOKEN_PATH);
  priorToken = hadToken ? readFileSync(TOKEN_PATH, "utf8") : null;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
  if (hadToken && priorToken !== null) {
    writeFileSync(TOKEN_PATH, priorToken, { mode: 0o600 });
  } else if (existsSync(TOKEN_PATH)) {
    rmSync(TOKEN_PATH, { force: true });
  }
});

describe("aiko token native", () => {
  it("inactive without mint", () => {
    if (existsSync(TOKEN_PATH)) rmSync(TOKEN_PATH, { force: true });
    expect(loadAikoTokenMint()).toBeNull();
    expect(isAikoTokenNative()).toBe(false);
    expect(aikoNativeHeaders()).toEqual({});
  });

  it("binds when AIKO_MINT env is set on aiko substrate", () => {
    process.env.AIKO_MINT = TEST_MINT;
    expect(loadAikoTokenMint()).toBe(TEST_MINT);
    expect(isAikoTokenNative()).toBe(true);
    expect(aikoNativeHeaders()).toEqual({
      "x-unbrowse-aiko-native": "1",
      [AIKO_TOKEN_HEADER]: TEST_MINT,
    });
  });

  it("reads mint from ~/.aiko/token.json", () => {
    mkdirSync(join(homedir(), ".aiko"), { recursive: true });
    writeFileSync(
      TOKEN_PATH,
      JSON.stringify({ mint: TEST_MINT, symbol: "AIKO" }),
      { mode: 0o600 },
    );
    expect(loadAikoTokenMint()).toBe(TEST_MINT);
    expect(isAikoTokenNative()).toBe(true);
  });
});