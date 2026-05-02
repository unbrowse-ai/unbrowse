// Tests for the per-domain extraction-notes file pattern.
// All tests use UNBROWSE_DOMAIN_NOTES_DIR to redirect into a tmpdir.
// No mocks — real filesystem, real functions.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, chmodSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

let savedEnvNotesDir: string | undefined;
let savedEnvProfile: string | undefined;
let tmpRoot: string;

function freshTmp(): string {
  return mkdtempSync(join(tmpdir(), "unbrowse-notes-test-"));
}

beforeEach(() => {
  savedEnvNotesDir = process.env.UNBROWSE_DOMAIN_NOTES_DIR;
  savedEnvProfile = process.env.UNBROWSE_PROFILE;
  delete process.env.UNBROWSE_PROFILE;
  tmpRoot = freshTmp();
  process.env.UNBROWSE_DOMAIN_NOTES_DIR = tmpRoot;
});

afterEach(() => {
  if (savedEnvNotesDir === undefined) delete process.env.UNBROWSE_DOMAIN_NOTES_DIR;
  else process.env.UNBROWSE_DOMAIN_NOTES_DIR = savedEnvNotesDir;
  if (savedEnvProfile === undefined) delete process.env.UNBROWSE_PROFILE;
  else process.env.UNBROWSE_PROFILE = savedEnvProfile;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

describe("getDomainNotesPath sanitization", () => {
  it("accepts valid hostnames, lowercases, strips leading www.", async () => {
    const { getDomainNotesPath } = await import("../src/extraction/domain-notes.ts");
    expect(getDomainNotesPath("Example.COM")).toBe(join(tmpRoot, "example.com.md"));
    expect(getDomainNotesPath("www.example.com")).toBe(join(tmpRoot, "example.com.md"));
    expect(getDomainNotesPath("api.sub.example.com")).toBe(join(tmpRoot, "api.sub.example.com.md"));
  });

  it("rejects path traversal and slashes", async () => {
    const { getDomainNotesPath } = await import("../src/extraction/domain-notes.ts");
    expect(() => getDomainNotesPath("../../etc/passwd")).toThrow();
    expect(() => getDomainNotesPath("foo/bar")).toThrow();
    expect(() => getDomainNotesPath("foo\\bar")).toThrow();
    expect(() => getDomainNotesPath("foo..bar")).toThrow();
  });

  it("rejects control characters, quotes, and other invalid charset", async () => {
    const { getDomainNotesPath } = await import("../src/extraction/domain-notes.ts");
    expect(() => getDomainNotesPath("foo\x00bar")).toThrow();
    expect(() => getDomainNotesPath("foo\nbar")).toThrow();
    expect(() => getDomainNotesPath('foo"bar')).toThrow();
    expect(() => getDomainNotesPath("foo bar")).toThrow();
    expect(() => getDomainNotesPath("foo:8080")).toThrow();
    expect(() => getDomainNotesPath("")).toThrow();
    expect(() => getDomainNotesPath(".example.com")).toThrow();
    expect(() => getDomainNotesPath("example.com.")).toThrow();
  });

  it("path traversal attempts stay inside NOTES_BASE", async () => {
    const { getDomainNotesPath } = await import("../src/extraction/domain-notes.ts");
    // All these throw, but if any survived they MUST be inside tmpRoot.
    for (const evil of ["../etc/passwd", "../../foo", "/absolute/path", "..\\..\\windows"]) {
      try {
        const p = getDomainNotesPath(evil);
        expect(p.startsWith(tmpRoot)).toBe(true);
      } catch {
        // expected
      }
    }
  });
});

describe("readDomainNote", () => {
  it("returns null on miss", async () => {
    const { readDomainNote } = await import("../src/extraction/domain-notes.ts");
    expect(readDomainNote("nonexistent.example")).toBeNull();
  });

  it("returns null on file larger than 16KB (abuse guard)", async () => {
    const { readDomainNote, getDomainNotesPath } = await import("../src/extraction/domain-notes.ts");
    const p = getDomainNotesPath("abusive.example");
    require("node:fs").mkdirSync(tmpRoot, { recursive: true });
    writeFileSync(p, "X".repeat(20_000));
    expect(readDomainNote("abusive.example")).toBeNull();
  });
});

describe("writeDomainNote", () => {
  it("truncates body at MAX_NOTES_BYTES", async () => {
    const { writeDomainNote, readDomainNote, MAX_NOTES_BYTES, getDomainNotesPath } = await import("../src/extraction/domain-notes.ts");
    const huge = "A".repeat(MAX_NOTES_BYTES + 5_000);
    writeDomainNote("big.example", huge);
    const p = getDomainNotesPath("big.example");
    const onDisk = readFileSync(p, "utf-8");
    expect(onDisk.length).toBe(MAX_NOTES_BYTES);
    const note = readDomainNote("big.example");
    expect(note).not.toBeNull();
    expect(note!.body.length).toBe(MAX_NOTES_BYTES);
  });

  it("is atomic — no .tmp file remains after a failed write", async () => {
    // Force failure by making the target dir unwritable AFTER it exists.
    const { writeDomainNote, getDomainNotesPath } = await import("../src/extraction/domain-notes.ts");
    require("node:fs").mkdirSync(tmpRoot, { recursive: true });
    // First successful write to ensure the dir exists.
    writeDomainNote("first.example", "ok");
    // Then chmod 0o500 to block writes.
    chmodSync(tmpRoot, 0o500);
    try {
      writeDomainNote("second.example", "this will fail");
    } finally {
      chmodSync(tmpRoot, 0o700);
    }
    const target = getDomainNotesPath("second.example");
    expect(existsSync(target)).toBe(false);
    // No .tmp.* dropped at the target path.
    const stragglers = readdirSync(tmpRoot).filter((n) => n.startsWith("second.example.md.tmp"));
    expect(stragglers).toEqual([]);
  });

  it("round-trips body verbatim within size bound", async () => {
    const { writeDomainNote, readDomainNote } = await import("../src/extraction/domain-notes.ts");
    const body = "## Notes for example.com\n\n- list endpoints under /api/posts\n- auth: cookie session_id\n";
    writeDomainNote("example.com", body);
    const note = readDomainNote("example.com");
    expect(note).not.toBeNull();
    expect(note!.body).toBe(body);
    expect(note!.domain).toBe("example.com");
    expect(typeof note!.written_at).toBe("string");
  });

  it("overwrite cleanly leaves no leftover content from longer prior body", async () => {
    const { writeDomainNote, readDomainNote, getDomainNotesPath } = await import("../src/extraction/domain-notes.ts");
    const long = "x".repeat(5000);
    const short = "y".repeat(50);
    writeDomainNote("over.example", long);
    expect(readDomainNote("over.example")!.body.length).toBe(5000);
    writeDomainNote("over.example", short);
    const p = getDomainNotesPath("over.example");
    expect(readFileSync(p, "utf-8")).toBe(short);
    expect(readDomainNote("over.example")!.body).toBe(short);
  });

  it("concurrent writes leave one of the two complete bodies, never garbled", async () => {
    const { writeDomainNote, readDomainNote } = await import("../src/extraction/domain-notes.ts");
    const a = "AAAA".repeat(100);
    const b = "BBBB".repeat(100);
    await Promise.all([
      Promise.resolve().then(() => writeDomainNote("race.example", a)),
      Promise.resolve().then(() => writeDomainNote("race.example", b)),
    ]);
    const final = readDomainNote("race.example")!.body;
    expect([a, b]).toContain(final);
  });

  it("empty body input → no file written, readDomainNote returns null", async () => {
    const { writeDomainNote, readDomainNote, getDomainNotesPath } = await import("../src/extraction/domain-notes.ts");
    writeDomainNote("empty.example", "");
    const p = getDomainNotesPath("empty.example");
    expect(existsSync(p)).toBe(false);
    expect(readDomainNote("empty.example")).toBeNull();
  });
});

describe("profile routing (no UNBROWSE_DOMAIN_NOTES_DIR override)", () => {
  it("UNBROWSE_PROFILE=staging routes to ~/.unbrowse/profiles/staging/domain-notes/<domain>.md", async () => {
    delete process.env.UNBROWSE_DOMAIN_NOTES_DIR;
    process.env.UNBROWSE_PROFILE = "staging";
    const { getDomainNotesPath } = await import("../src/extraction/domain-notes.ts");
    const expected = join(homedir(), ".unbrowse", "profiles", "staging", "domain-notes", "example.com.md");
    expect(getDomainNotesPath("example.com")).toBe(expected);
  });

  it("default (no profile, no override) routes to ~/.unbrowse/domain-notes/<domain>.md", async () => {
    delete process.env.UNBROWSE_DOMAIN_NOTES_DIR;
    delete process.env.UNBROWSE_PROFILE;
    const { getDomainNotesPath } = await import("../src/extraction/domain-notes.ts");
    const expected = join(homedir(), ".unbrowse", "domain-notes", "example.com.md");
    expect(getDomainNotesPath("example.com")).toBe(expected);
  });
});
