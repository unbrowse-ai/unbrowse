#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "../src/runtime/paths.js";

type SectionMap = Record<string, string[]>;

export type ReleaseAnnouncement = {
  version: string;
  source: "release-notes" | "changelog";
  highlights: string[];
  fixes: string[];
  x_post: string;
};

export type ReleaseAnnouncementArtifacts = {
  markdown_path: string;
  json_path: string;
};

function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMarkdownSections(markdown: string): SectionMap {
  const sections: SectionMap = {};
  let current = "root";
  sections[current] = [];

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      current = stripMarkdown(heading[1]).toLowerCase();
      sections[current] ??= [];
      continue;
    }
    sections[current] ??= [];
    sections[current].push(line);
  }

  return sections;
}

function collectParagraphishItems(lines: string[]): string[] {
  const items: string[] = [];
  let buf: string[] = [];

  const flush = () => {
    const text = stripMarkdown(buf.join(" ").trim());
    if (text) items.push(text);
    buf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flush();
      const bullet = stripMarkdown(trimmed.replace(/^[-*]\s+/, ""));
      if (bullet) items.push(bullet);
      continue;
    }
    buf.push(trimmed);
  }
  flush();

  return items;
}

function firstSentence(text: string): string {
  const clean = stripMarkdown(text);
  const match = clean.match(/^(.{1,180}?[.!?])(\s|$)/);
  return (match ? match[1] : clean).trim();
}

function compactLine(text: string, max = 140): string {
  const clean = firstSentence(text).replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean.replace(/[.]+$/, "");
  return clean.slice(0, Math.max(0, max - 1)).trim().replace(/[.,;:!?-]+$/, "") + "…";
}

function parseReleaseNotes(markdown: string): { highlights: string[]; fixes: string[] } {
  const sections = parseMarkdownSections(markdown);
  const highlights = [
    ...collectParagraphishItems(sections["what's new"] ?? []),
    ...collectParagraphishItems(sections["whats new"] ?? []),
    ...collectParagraphishItems(sections["performance"] ?? []),
    ...collectParagraphishItems(sections["other"] ?? []),
  ].map((item) => compactLine(item));

  const fixes = collectParagraphishItems(sections["fixes"] ?? []).map((item) => compactLine(item));

  return {
    highlights: [...new Set(highlights)].filter(Boolean),
    fixes: [...new Set(fixes)].filter(Boolean),
  };
}

function parseUnreleasedChangelog(markdown: string): { highlights: string[]; fixes: string[] } {
  const unreleasedMatch = markdown.match(/^## Unreleased\s*([\s\S]*?)(?=^##\s|\Z)/m);
  const unreleased = unreleasedMatch?.[1] ?? "";
  const lines = unreleased.split(/\r?\n/);
  const items = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => compactLine(line.slice(2)));

  return {
    highlights: items.slice(0, 4),
    fixes: items.filter((item) => /^fix(ed)?\b/i.test(item)).slice(0, 3),
  };
}

function buildXPost(version: string, highlights: string[], fixes: string[]): string {
  const prefix = `Unbrowse v${version} is out.`;
  const cta = `npm i -g unbrowse`;

  for (let highlightCount = Math.min(3, highlights.length); highlightCount >= 1; highlightCount--) {
    const chosenHighlights = highlights.slice(0, highlightCount).map((item) => `• ${compactLine(item, 72)}`);
    const maybeFix = fixes[0] ? [`• ${compactLine(`Fix: ${fixes[0]}`, 72)}`] : [];

    for (let fixCount = maybeFix.length; fixCount >= 0; fixCount--) {
      const body = [prefix, "", ...chosenHighlights, ...maybeFix.slice(0, fixCount), "", cta].join("\n").trim();
      if (body.length <= 280) return body;
    }
  }

  return `${prefix}\n\n${cta}`;
}

export function collectAnnouncement(root = path.resolve(import.meta.dir, "..")): ReleaseAnnouncement {
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version as string;
  const notesPath = path.join(root, ".release-notes.md");

  let source: ReleaseAnnouncement["source"] = "release-notes";
  let parsed: { highlights: string[]; fixes: string[] };

  if (existsSync(notesPath)) {
    parsed = parseReleaseNotes(readFileSync(notesPath, "utf8"));
  } else {
    source = "changelog";
    parsed = parseUnreleasedChangelog(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"));
  }

  const highlights = parsed.highlights.slice(0, 4);
  const fixes = parsed.fixes.slice(0, 3);

  return {
    version,
    source,
    highlights,
    fixes,
    x_post: buildXPost(version, highlights, fixes),
  };
}

function renderAnnouncementMarkdown(announcement: ReleaseAnnouncement): string {
  const lines = [
    `# Release Announcement v${announcement.version}`,
    "",
    `Source: ${announcement.source}`,
    "",
    "## Highlights",
    "",
    ...announcement.highlights.map((item) => `- ${item}`),
  ];

  if (announcement.fixes.length > 0) {
    lines.push("");
    lines.push("## Fixes");
    lines.push("");
    lines.push(...announcement.fixes.map((item) => `- ${item}`));
  }

  lines.push("");
  lines.push("## X Post");
  lines.push("");
  lines.push("```text");
  lines.push(announcement.x_post);
  lines.push("```");

  return lines.join("\n") + "\n";
}

export function writeAnnouncementArtifacts(
  announcement: ReleaseAnnouncement,
  root = path.resolve(import.meta.dir, ".."),
): ReleaseAnnouncementArtifacts {
  const markdownPath = path.join(root, ".release-announcement.md");
  const jsonPath = path.join(root, ".release-announcement.json");

  writeFileSync(markdownPath, renderAnnouncementMarkdown(announcement));
  writeFileSync(jsonPath, JSON.stringify(announcement, null, 2) + "\n");

  return {
    markdown_path: markdownPath,
    json_path: jsonPath,
  };
}

function printAnnouncement(announcement: ReleaseAnnouncement): void {
  const lines = [
    "release announce",
    `- version: ${announcement.version}`,
    `- source: ${announcement.source}`,
    "- highlights:",
    ...announcement.highlights.map((item) => `  - ${item}`),
  ];

  if (announcement.fixes.length > 0) {
    lines.push("- fixes:");
    lines.push(...announcement.fixes.map((item) => `  - ${item}`));
  }

  lines.push("- x post:");
  lines.push(announcement.x_post);
  process.stdout.write(lines.join("\n") + "\n");
}

function main(): void {
  const announcement = collectAnnouncement();
  if (process.argv.includes("--write")) {
    const written = writeAnnouncementArtifacts(announcement);
    process.stdout.write(
      JSON.stringify({ ...announcement, ...written }, null, 2) + "\n",
    );
    return;
  }
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(announcement, null, 2) + "\n");
    return;
  }
  printAnnouncement(announcement);
}

if (isMainModule(import.meta.url)) {
  main();
}
