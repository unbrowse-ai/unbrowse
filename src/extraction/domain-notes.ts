// Per-domain extraction-notes file pattern. LLM-prose markdown stored on disk,
// read back as additional context for future LLM augmentation passes.
//
// HARD CONSTRAINTS (CLAUDE.md anti-patterns):
//  - No per-domain TypeScript registry. Notes are PROMPT material only.
//  - The deterministic ranker (rankEndpoints / extractFromDOM scoring) does
//    NOT read these notes. They are injected into the LLM augmentation step
//    in src/graph/agent-augment.ts only.
//  - This module is pure file-IO + path/sanitization helpers. No content
//    generation, no per-host switches, no behavior conditional on domain
//    other than path placement.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROFILE_NAME = process.env.UNBROWSE_PROFILE ?? "";

function notesBaseDir(): string {
  // Re-evaluated per call so tests using UNBROWSE_DOMAIN_NOTES_DIR /
  // UNBROWSE_PROFILE env overrides take effect without module reload.
  const override = process.env.UNBROWSE_DOMAIN_NOTES_DIR;
  if (override && override.length > 0) return override;
  const profile = process.env.UNBROWSE_PROFILE ?? PROFILE_NAME;
  return profile
    ? join(homedir(), ".unbrowse", "profiles", profile, "domain-notes")
    : join(homedir(), ".unbrowse", "domain-notes");
}

// ~2k tokens — keeps prompt overhead bounded when injected into augment call.
export const MAX_NOTES_BYTES = 8_000;
// Refuse to read files larger than this; treats them as corrupt/abusive.
const READ_GUARD_BYTES = MAX_NOTES_BYTES * 2;

// RFC 1035 hostname charset, max length 253. Strict deny-list approach: if the
// caller-supplied string contains anything outside [a-z0-9.-], we reject.
const HOSTNAME_RE = /^[a-z0-9.-]{1,253}$/;

export interface DomainNote {
  domain: string;
  written_at: string; // ISO timestamp
  body: string;       // LLM-prose markdown
}

export function sanitizeDomain(raw: string): string {
  if (typeof raw !== "string") {
    throw new Error("domain_must_be_string");
  }
  let d = raw.trim().toLowerCase();
  if (d.startsWith("www.")) d = d.slice(4);
  if (!d || d.length > 253) {
    throw new Error("domain_invalid_length");
  }
  // Reject path traversal, control chars, slashes, quotes, etc.
  if (d.includes("..") || d.includes("/") || d.includes("\\")) {
    throw new Error("domain_invalid_characters");
  }
  if (!HOSTNAME_RE.test(d)) {
    throw new Error("domain_invalid_characters");
  }
  // Belt-and-suspenders against leading/trailing dot trickery.
  if (d.startsWith(".") || d.endsWith(".")) {
    throw new Error("domain_invalid_characters");
  }
  return d;
}

export function getDomainNotesPath(domain: string): string {
  const safe = sanitizeDomain(domain);
  const base = notesBaseDir();
  const candidate = join(base, `${safe}.md`);
  // Defense in depth: ensure the resolved path is still inside base. Since we
  // already rejected /, .., and \ in sanitizeDomain this is belt-and-suspenders.
  if (!candidate.startsWith(base + "/") && candidate !== join(base, `${safe}.md`)) {
    throw new Error("domain_path_traversal");
  }
  return candidate;
}

export function readDomainNote(domain: string): DomainNote | null {
  let p: string;
  try {
    p = getDomainNotesPath(domain);
  } catch {
    return null;
  }
  if (!existsSync(p)) return null;
  let size = 0;
  try {
    size = statSync(p).size;
  } catch {
    return null;
  }
  if (size <= 0 || size > READ_GUARD_BYTES) return null;
  let body: string;
  try {
    body = readFileSync(p, "utf-8");
  } catch {
    return null;
  }
  if (!body) return null;
  let writtenAt: string;
  try {
    writtenAt = statSync(p).mtime.toISOString();
  } catch {
    writtenAt = new Date(0).toISOString();
  }
  return {
    domain: sanitizeDomain(domain),
    written_at: writtenAt,
    body,
  };
}

export function writeDomainNote(domain: string, body: string): void {
  if (typeof body !== "string" || body.length === 0) return;
  let p: string;
  try {
    p = getDomainNotesPath(domain);
  } catch {
    return;
  }
  const trimmed = body.length > MAX_NOTES_BYTES ? body.slice(0, MAX_NOTES_BYTES) : body;
  const dir = p.slice(0, p.lastIndexOf("/"));
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  // Atomic write: write to .tmp then rename. If the write fails, clean up the
  // .tmp so we don't leave half-written droppings.
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, trimmed, "utf-8");
    renameSync(tmp, p);
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort
    }
  }
}
