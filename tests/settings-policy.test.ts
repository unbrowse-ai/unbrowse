import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideCheckpointPublish,
  decideExplicitPublish,
  getCapturePipelineSettings,
  updateCapturePipelineSettings,
} from "../src/settings.js";

const originalConfigDir = process.env.UNBROWSE_CONFIG_DIR;

afterEach(() => {
  if (originalConfigDir == null) delete process.env.UNBROWSE_CONFIG_DIR;
  else process.env.UNBROWSE_CONFIG_DIR = originalConfigDir;
});

describe("capture pipeline settings", () => {
  it("defaults to auto-publish with no domain rules", () => {
    process.env.UNBROWSE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "unbrowse-settings-default-"));

    expect(getCapturePipelineSettings()).toEqual({
      auto_publish_checkpoints: true,
      publish_domain_blacklist: [],
      publish_domain_promptlist: [],
    });
    expect(decideCheckpointPublish("www.linkedin.com")).toEqual({
      publishQueued: true,
      mode: "auto",
      reason: "Background publish is allowed for this checkpoint.",
    });
  });

  it("persists auto-publish toggle and normalized domain rules", () => {
    process.env.UNBROWSE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "unbrowse-settings-update-"));

    const updated = updateCapturePipelineSettings({
      auto_publish_checkpoints: false,
      publish_domain_blacklist: ["https://www.linkedin.com/feed/", "*.x.com", "linkedin.com"],
      publish_domain_promptlist: ["github.com/repo", "WWW.reddit.com"],
    });

    expect(updated).toEqual({
      auto_publish_checkpoints: false,
      publish_domain_blacklist: ["linkedin.com", "x.com"],
      publish_domain_promptlist: ["github.com", "reddit.com"],
    });
    expect(getCapturePipelineSettings()).toEqual(updated);
  });

  it("skips checkpoint auto-publish for blacklist and prompt-list matches", () => {
    process.env.UNBROWSE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "unbrowse-settings-rules-"));
    updateCapturePipelineSettings({
      publish_domain_blacklist: ["linkedin.com"],
      publish_domain_promptlist: ["github.com"],
    });

    expect(decideCheckpointPublish("www.linkedin.com")).toEqual({
      publishQueued: false,
      mode: "blacklisted",
      reason: "Auto-publish skipped because www.linkedin.com matches blacklist entry linkedin.com.",
      matchedDomain: "linkedin.com",
    });

    expect(decideCheckpointPublish("api.github.com")).toEqual({
      publishQueued: false,
      mode: "prompt",
      reason: "Auto-publish paused because api.github.com matches prompt-list entry github.com.",
      matchedDomain: "github.com",
    });
  });

  it("requires confirmation for explicit publish on guarded domains", () => {
    process.env.UNBROWSE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "unbrowse-settings-confirm-"));
    updateCapturePipelineSettings({
      publish_domain_blacklist: ["linkedin.com"],
      publish_domain_promptlist: ["github.com"],
    });

    expect(decideExplicitPublish("linkedin.com", false)).toEqual({
      allowed: false,
      mode: "blacklisted",
      reason: "Explicit publish requires confirmation because linkedin.com matches blacklist entry linkedin.com.",
      matchedDomain: "linkedin.com",
    });

    expect(decideExplicitPublish("github.com", false)).toEqual({
      allowed: false,
      mode: "prompt",
      reason: "Explicit publish requires confirmation because github.com matches prompt-list entry github.com.",
      matchedDomain: "github.com",
    });

    expect(decideExplicitPublish("github.com", true)).toEqual({
      allowed: true,
      mode: "allowed",
      reason: "Explicit publish allowed.",
    });
  });
});
