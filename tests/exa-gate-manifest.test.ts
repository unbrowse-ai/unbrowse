import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");
const VALIDATOR = "bench/exa/validate_gate_manifest.py";
const MANIFEST = "bench/exa/gate_manifest.json";

function runValidator(cwd = ROOT): { status: number | null; output: string } {
  const r = spawnSync("python3", [VALIDATOR], {
    cwd,
    encoding: "utf8",
  });
  return { status: r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

function copyFixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "exa-gate-manifest-"));
  mkdirSync(join(dir, "bench/exa"), { recursive: true });
  mkdirSync(join(dir, "bench/browsecomp"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });

  copyFileSync(join(ROOT, VALIDATOR), join(dir, VALIDATOR));
  copyFileSync(join(ROOT, MANIFEST), join(dir, MANIFEST));
  copyFileSync(join(ROOT, "bench/exa/TARGETS.md"), join(dir, "bench/exa/TARGETS.md"));

  const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
  for (const entry of manifest.entries) {
    const path = join(dir, entry.path);
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, "#!/usr/bin/env bash\nexit 0\n");
  }
  return dir;
}

function mutateManifest(dir: string, mutate: (manifest: any) => void): void {
  const path = join(dir, MANIFEST);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  mutate(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

describe("Exa/BrowseComp gate manifest", () => {
  it("passes on the real manifest and classifies the old noisy gate as non-release", () => {
    const r = runValidator();
    expect(r.status).toBe(0);
    expect(r.output).toContain("GATE-MANIFEST PASS");

    const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8")) as {
      entries: Array<{ id: string; evidence_class: string; release_eligible: boolean; minimum_n: number | null; replacement?: string }>;
    };
    const fast = manifest.entries.find((entry) => entry.id === "browsecomp-fast-historical");
    expect(fast).toMatchObject({
      evidence_class: "historical-fast",
      release_eligible: false,
      minimum_n: null,
      replacement: "bench/browsecomp/beat-exa-robust-gate.sh",
    });
  });

  it("fails closed if a historical-fast gate is marked release-eligible", () => {
    const dir = copyFixtureRoot();
    try {
      const path = join(dir, MANIFEST);
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.entries[0].release_eligible = true;
      writeFileSync(path, JSON.stringify(manifest, null, 2));

      const r = runValidator(dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain("historical-fast gates cannot be release_eligible");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed if a release-eligible BrowseComp gate lacks a robust N floor", () => {
    const dir = copyFixtureRoot();
    try {
      mutateManifest(dir, (manifest) => {
        const robust = manifest.entries.find((entry: { id: string }) => entry.id === "browsecomp-robust-historical");
        robust.minimum_n = 10;
      });

      const r = runValidator(dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain("release-eligible BrowseComp gate needs minimum_n >= 25");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when a manifest entry points at a missing gate script", () => {
    const dir = copyFixtureRoot();
    try {
      mutateManifest(dir, (manifest) => {
        manifest.entries[1].path = "bench/browsecomp/does-not-exist.sh";
      });

      const r = runValidator(dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain("path does not exist: bench/browsecomp/does-not-exist.sh");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when duplicate ids collapse two corroborations into one name", () => {
    const dir = copyFixtureRoot();
    try {
      mutateManifest(dir, (manifest) => {
        manifest.entries[1].id = manifest.entries[0].id;
      });

      const r = runValidator(dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain("duplicate id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on adversarial evidence-class injection", () => {
    const dir = copyFixtureRoot();
    try {
      mutateManifest(dir, (manifest) => {
        manifest.entries[0].evidence_class = "robust-historical; release=true";
      });

      const r = runValidator(dir);
      expect(r.status).toBe(1);
      expect(r.output).toContain("invalid evidence_class robust-historical; release=true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
