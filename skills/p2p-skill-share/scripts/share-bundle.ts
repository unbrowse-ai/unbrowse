#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { exportBundle, DEFAULT_BUNDLE_DIR, parseRegistryForSlugs } from "../../history-skill-miner/scripts/export-bundle.ts";
import { REGISTRY_PATH } from "../../history-skill-miner/scripts/mine-history.ts";

export type ShareMode = "none" | "quick" | "named";

export type ShareOptions = {
  mode: ShareMode;
  namedTunnel?: string;
  port: number;
  host: string;
  bundleDir: string;
  printOnly: boolean;
};

export type ShareManifest = {
  generated_at: string;
  transport: "cloudflare-relay";
  mode: ShareMode;
  manifest_path: "/.well-known/skills/manifest.json";
  bundle_path: "/";
  skills: { slug: string; skill_path: string }[];
  dependencies_path: string;
};

const DEFAULT_PORT = 4310;
const DEFAULT_HOST = "127.0.0.1";

export function parseArgs(argv: string[]): ShareOptions {
  let mode: ShareMode = "quick";
  let namedTunnel: string | undefined;
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let bundleDir = DEFAULT_BUNDLE_DIR;
  let printOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--mode" && next) {
      if (next === "none" || next === "quick" || next === "named") mode = next;
      index += 1;
      continue;
    }
    if (arg === "--named" && next) {
      namedTunnel = next;
      index += 1;
      continue;
    }
    if (arg === "--port" && next) {
      port = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (arg === "--host" && next) {
      host = next;
      index += 1;
      continue;
    }
    if (arg === "--bundle-dir" && next) {
      bundleDir = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--print-only") {
      printOnly = true;
    }
  }

  return { mode, namedTunnel, port, host, bundleDir, printOnly };
}

export function buildManifest(slugs: string[], mode: ShareMode): ShareManifest {
  return {
    generated_at: new Date().toISOString(),
    transport: "cloudflare-relay",
    mode,
    manifest_path: "/.well-known/skills/manifest.json",
    bundle_path: "/",
    skills: slugs.map((slug) => ({
      slug,
      skill_path: `/skills/${slug}/SKILL.md`,
    })),
    dependencies_path: "/skills/history-skill-miner/references/dependencies.md",
  };
}

export function writeShareManifest(bundleDir: string, manifest: ShareManifest): string {
  const manifestDir = path.join(bundleDir, ".well-known", "skills");
  mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifestPath;
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

export function buildTunnelCommand(options: ShareOptions): string[] {
  if (options.mode === "none") return [];
  if (options.mode === "quick") {
    return ["npx", "wrangler", "tunnel", "quick-start", `http://${options.host}:${options.port}`];
  }
  if (!options.namedTunnel) {
    throw new Error("Named mode requires --named <tunnel-name>.");
  }
  return ["npx", "wrangler", "tunnel", "run", options.namedTunnel];
}

export function renderShareSummary(options: ShareOptions, slugs: string[], manifestPath: string): string {
  const lines = [
    `Bundle dir: ${options.bundleDir}`,
    `Local server: http://${options.host}:${options.port}`,
    `Manifest: ${manifestPath}`,
    `Mode: ${options.mode}`,
    `Skills: ${slugs.join(", ")}`,
  ];

  if (options.mode === "quick") {
    lines.push("Account requirement: none for Quick Tunnel.");
  } else if (options.mode === "named") {
    lines.push("Account requirement: named tunnel owner needs a Cloudflare account.");
  }

  const command = buildTunnelCommand(options);
  if (command.length > 0) lines.push(`Tunnel command: ${command.join(" ")}`);
  return lines.join("\n");
}

export async function startShareServer(options: ShareOptions): Promise<void> {
  exportBundle(options.bundleDir);
  const registry = readFileSync(REGISTRY_PATH, "utf8");
  const slugs = parseRegistryForSlugs(registry);
  const manifest = buildManifest(slugs, options.mode);
  const manifestPath = writeShareManifest(options.bundleDir, manifest);

  console.log(renderShareSummary(options, slugs, manifestPath));

  if (options.printOnly) return;

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch(request) {
      const url = new URL(request.url);
      const pathname = url.pathname === "/" ? "/README.md" : url.pathname;
      const filePath = path.join(options.bundleDir, pathname);
      if (!existsSync(filePath)) return new Response("not found\n", { status: 404 });
      return new Response(Bun.file(filePath), {
        headers: { "content-type": contentTypeFor(filePath) },
      });
    },
  });

  console.log(`Serving bundle on http://${options.host}:${server.port}`);

  const command = buildTunnelCommand(options);
  if (command.length > 0) {
    const [bin, ...args] = command;
    const child = spawn(bin, args, {
      stdio: "inherit",
      cwd: options.bundleDir,
      env: process.env,
    });

    const shutdown = () => {
      server.stop(true);
      child.kill("SIGINT");
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    child.on("exit", () => server.stop(true));
  }

  await new Promise(() => {});
}

if (import.meta.main) {
  await startShareServer(parseArgs(process.argv.slice(2)));
}
