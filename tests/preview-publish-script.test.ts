import { describe, expect, it } from "bun:test";
import { DEFAULT_BACKEND_URL } from "../src/version.js";

const previewPublish = await import("../scripts/publish-preview-cli.mjs");

describe("preview publish script", () => {
  it("formats preview versions with a stable UTC timestamp suffix", () => {
    const version = previewPublish.formatPreviewVersion("2.12.4", new Date("2026-04-04T09:08:07Z"));
    expect(version).toBe("2.12.4-preview.20260404090807");
  });

  it("prefers explicit preview backend overrides before env fallbacks", () => {
    expect(previewPublish.resolvePreviewBackendUrl({
      PREVIEW_API_URL: "https://preview.example",
      EXPERIMENTS_API_URL: "https://experiments.example",
      UNBROWSE_PREVIEW_BACKEND_URL: "https://override.example",
    })).toBe("https://override.example");

    expect(previewPublish.resolvePreviewBackendUrl({
      PREVIEW_API_URL: "https://preview.example",
      EXPERIMENTS_API_URL: "https://experiments.example",
    })).toBe("https://experiments.example");

    expect(previewPublish.resolvePreviewBackendUrl({}, "https://explicit.example")).toBe("https://explicit.example");
  });

  it("keeps stable builds on the canonical backend by default", () => {
    expect(DEFAULT_BACKEND_URL).toBe("https://beta-api.unbrowse.ai");
  });
});
