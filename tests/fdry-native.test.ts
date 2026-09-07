import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  FDRY_MINT,
  FDRY_VAULT_PDA,
  fdryNativeHeaders,
  isFdryNativeEnabled,
} from "../src/values/fdry-native.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.UNBROWSE_FDRY_NATIVE;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
});

describe("fdry native", () => {
  it("exports canonical mint and vault", () => {
    expect(FDRY_MINT).toBe("2ZiSPGncrkwWa6GBZB4EDtsfq7HEWwkwsPFzEXieXjNL");
    expect(FDRY_VAULT_PDA).toBe(process.env.UNBROWSE_FDRY_VAULT ?? "");
  });

  it("emits native headers by default", () => {
    expect(isFdryNativeEnabled()).toBe(true);
    expect(fdryNativeHeaders()["x-unbrowse-fdry-mint"]).toBe(FDRY_MINT);
    expect(fdryNativeHeaders()["x-unbrowse-fdry-vault"]).toBe(FDRY_VAULT_PDA);
  });

  it("opts out when UNBROWSE_FDRY_NATIVE=0", () => {
    process.env.UNBROWSE_FDRY_NATIVE = "0";
    expect(isFdryNativeEnabled()).toBe(false);
    expect(fdryNativeHeaders()).toEqual({});
  });
});