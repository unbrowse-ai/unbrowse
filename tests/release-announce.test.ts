import { describe, expect, test } from "bun:test";
import { collectAnnouncement, writeAnnouncementArtifacts } from "../scripts/release-announce.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("release announce", () => {
  test("prefers release notes and produces x-ready copy", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "unbrowse-release-announce-"));
    try {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
      writeFileSync(path.join(root, ".release-notes.md"), `## What's New

Cleaner npm-first setup. unbrowse setup now handles bootstrap automatically.

Public non-auth retrieval is much more reliable across npm, PyPI, GitLab, and Docker Hub.

## Fixes

- Fixed payload ingestion on resolve and execute.
- Fixed crashes when live capture only discovered unusable endpoints.
`);

      const announcement = collectAnnouncement(root);
      expect(announcement.version).toBe("1.2.3");
      expect(announcement.source).toBe("release-notes");
      expect(announcement.highlights[0]).toContain("Cleaner npm-first setup");
      expect(announcement.fixes[0]).toContain("Fixed payload ingestion");
      expect(announcement.x_post).toContain("Unbrowse v1.2.3 is out.");
      expect(announcement.x_post.length).toBeLessThanOrEqual(280);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to unreleased changelog bullets", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "unbrowse-release-announce-"));
    try {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2.0.0" }));
      writeFileSync(path.join(root, "CHANGELOG.md"), `# Changelog

## Unreleased

- Added release tracking in one place.
- Fixed LinkedIn feed support in the CLI.
- Improved package publish flow.

## [1.9.0] - 2026-01-01
`);

      const announcement = collectAnnouncement(root);
      expect(announcement.source).toBe("changelog");
      expect(announcement.highlights).toEqual([
        "Added release tracking in one place",
        "Fixed LinkedIn feed support in the CLI",
        "Improved package publish flow",
      ]);
      expect(announcement.x_post).toContain("Unbrowse v2.0.0 is out.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes announcement artifacts for release hooks", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "unbrowse-release-announce-"));
    try {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "3.0.0" }));
      writeFileSync(path.join(root, ".release-notes.md"), `## What's New

Release hooks now generate announcement artifacts automatically.
`);

      const announcement = collectAnnouncement(root);
      const written = writeAnnouncementArtifacts(announcement, root);

      const markdown = readFileSync(written.markdown_path, "utf8");
      const json = JSON.parse(readFileSync(written.json_path, "utf8")) as { version: string; x_post: string };

      expect(markdown).toContain("# Release Announcement v3.0.0");
      expect(markdown).toContain("## X Post");
      expect(json.version).toBe("3.0.0");
      expect(json.x_post).toContain("Unbrowse v3.0.0 is out.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
