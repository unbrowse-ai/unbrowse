#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const ROOT = process.cwd();
const RUNTIME_ENV_PATH = join(ROOT, ".env.runtime");
const DEFAULT_ENV_PATH = join(ROOT, ".env");

type Preset = {
  UNBROWSE_PROFILE: string;
  UNBROWSE_URL: string;
  UNBROWSE_BACKEND_URL?: string;
  UNBROWSE_LOCAL_ONLY: string;
  UNBROWSE_FORCE_CAPTURE: string;
  UNBROWSE_TRACE_DEBUG?: string;
};

const PRESERVED_KEYS = ["NEBIUS_API_KEY"] as const;

const PRESETS: Record<string, Preset> = {
  prod: {
    UNBROWSE_PROFILE: "prod",
    UNBROWSE_URL: "http://127.0.0.1:6969",
    UNBROWSE_BACKEND_URL: "https://beta-api.unbrowse.ai",
    UNBROWSE_LOCAL_ONLY: "0",
    UNBROWSE_FORCE_CAPTURE: "0",
    UNBROWSE_TRACE_DEBUG: "0",
  },
  testing: {
    UNBROWSE_PROFILE: "testing",
    UNBROWSE_URL: "http://127.0.0.1:6969",
    UNBROWSE_LOCAL_ONLY: "1",
    UNBROWSE_FORCE_CAPTURE: "1",
    UNBROWSE_TRACE_DEBUG: "1",
  },
};

function cleanProfileName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function profileDir(name: string): string {
  const clean = cleanProfileName(name);
  return clean ? join(homedir(), ".unbrowse", "profiles", clean) : join(homedir(), ".unbrowse");
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    out[match[1]!] = match[2] ?? "";
  }
  return out;
}

function preservedSecrets(): Record<string, string> {
  const runtime = parseEnvFile(RUNTIME_ENV_PATH);
  const fallback = parseEnvFile(DEFAULT_ENV_PATH);
  const out: Record<string, string> = {};
  for (const key of PRESERVED_KEYS) {
    const value = process.env[key] || runtime[key] || fallback[key];
    if (value) out[key] = value;
  }
  return out;
}

function writePreset(name: string): void {
  const preset = PRESETS[name];
  if (!preset) {
    console.error(`unknown preset: ${name}`);
    process.exit(1);
  }
  const lines = [
    `UNBROWSE_PROFILE=${preset.UNBROWSE_PROFILE}`,
    `UNBROWSE_URL=${preset.UNBROWSE_URL}`,
    `UNBROWSE_LOCAL_ONLY=${preset.UNBROWSE_LOCAL_ONLY}`,
    `UNBROWSE_FORCE_CAPTURE=${preset.UNBROWSE_FORCE_CAPTURE}`,
    `UNBROWSE_TRACE_DEBUG=${preset.UNBROWSE_TRACE_DEBUG ?? "0"}`,
    ...(preset.UNBROWSE_BACKEND_URL ? [`UNBROWSE_BACKEND_URL=${preset.UNBROWSE_BACKEND_URL}`] : []),
    ...Object.entries(preservedSecrets()).map(([key, value]) => `${key}=${value}`),
  ];
  writeFileSync(RUNTIME_ENV_PATH, `${lines.join("\n")}\n`, "utf-8");
  console.log(`preset=${name}`);
  console.log(`env=${RUNTIME_ENV_PATH}`);
  console.log(`profile_dir=${profileDir(preset.UNBROWSE_PROFILE)}`);
}

function activeProfileName(): string {
  if (!existsSync(RUNTIME_ENV_PATH)) return "default";
  const raw = readFileSync(RUNTIME_ENV_PATH, "utf-8");
  return raw.match(/^UNBROWSE_PROFILE=(.+)$/m)?.[1]?.trim() || "default";
}

async function clearProfile(name?: string): Promise<void> {
  const resolved = name && PRESETS[name] ? PRESETS[name]!.UNBROWSE_PROFILE : (name || activeProfileName());
  const dir = profileDir(resolved);
  if (!existsSync(dir)) {
    console.log(`nothing_to_clear profile=${resolved}`);
    return;
  }
  const proc = Bun.spawn(["trash", dir], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(stderr || `trash failed for ${dir}`);
  }
  console.log(`cleared profile=${resolved}`);
}

function showPreset(): void {
  if (!existsSync(RUNTIME_ENV_PATH)) {
    console.log("no preset configured");
    return;
  }
  process.stdout.write(readFileSync(RUNTIME_ENV_PATH, "utf-8"));
}

const [command = "show", arg] = process.argv.slice(2);

if (command === "use") {
  writePreset(arg ?? "prod");
} else if (command === "clear") {
  await clearProfile(arg);
} else if (command === "show") {
  showPreset();
} else {
  console.error("usage: bun scripts/profile.ts <show|use|clear> [prod|testing|profile]");
  process.exit(1);
}
