/**
 * `unbrowse eval settings` — current local config + capture-pipeline settings.
 *
 * 1:1 mapping (kind-map.ts row "eval settings"):
 *   CLI subcommand  : eval settings
 *   MCP tool        : unbrowse_settings
 *   Covenant kind   : observe_settings
 *   Verb            : eval
 *
 * Read or mutate `~/.unbrowse/settings.json`. The settings file carries
 * NON-SENSITIVE config flags only (default_proxy host, headless toggle,
 * auth_capture_mode). Secrets ALWAYS go through value-pointers (op://,
 * keychain://, bw://, arg://) — never inlined here.
 *
 * SECRET-REJECTION INVARIANT (load-bearing — see CLAUDE.md "no stubs /
 * no cleartext"): `--set key=value` REJECTS any value that
 *   (a) starts with a value-pointer prefix (op://, keychain://, bw://, arg://) —
 *       the rejection nudges the caller toward declaring a value-source via
 *       `unbrowse build value-source` instead of pinning the pointer here, AND
 *   (b) targets a key not on the ALLOWED_SET whitelist.
 * Anything matching common secret-shape regexes (Bearer, JWT, sk_*) is
 * also rejected as a defense-in-depth measure.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedV7Args } from "../args.js";
import {
  EX_GENERIC,
  EX_USAGE,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";

/**
 * Allow-list of writeable keys. Adding a new key requires (1) a row
 * here AND (2) confirming the value type is non-sensitive — never
 * accept a secret-shape value as a top-level setting.
 */
export const ALLOWED_SET = new Set<string>([
  "default_proxy",
  "headless",
  "auth_capture_mode",
]);

const POINTER_PREFIXES = ["op://", "keychain://", "bw://", "arg://"] as const;
// Common secret-token shapes — never accepted as a settings value.
const SECRET_REGEXES: ReadonlyArray<RegExp> = [
  /^Bearer\s+[A-Za-z0-9._\-]{8,}$/i,
  /^eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/,
  /^sk_[A-Za-z0-9]{16,}$/,
];

export interface SettingsFile {
  default_proxy?: string;
  headless?: boolean;
  auth_capture_mode?: string;
  [k: string]: unknown;
}

function settingsPath(): string {
  return join(homedir(), ".unbrowse", "settings.json");
}

export async function readSettings(): Promise<SettingsFile> {
  try {
    const raw = await readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SettingsFile;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeSettings(settings: SettingsFile): Promise<void> {
  const path = settingsPath();
  await mkdir(join(homedir(), ".unbrowse"), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Reason a `--set key=value` was rejected, exported for tests.
 * `null` means accepted.
 */
export function rejectionReason(key: string, rawValue: string): string | null {
  if (!ALLOWED_SET.has(key)) {
    return "key_not_allowed";
  }
  for (const prefix of POINTER_PREFIXES) {
    if (rawValue.startsWith(prefix)) return "value_is_pointer";
  }
  for (const re of SECRET_REGEXES) {
    if (re.test(rawValue)) return "value_looks_like_secret";
  }
  return null;
}

/**
 * Coerce a raw string into the typed shape expected for that setting.
 * Only narrow, conservative coercions; anything we can't coerce safely
 * is stored as the raw string.
 */
export function coerceValue(key: string, raw: string): unknown {
  if (key === "headless") {
    const lower = raw.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return raw;
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "settings")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval settings",
      {
        summary: meta.summary,
        usage: "unbrowse eval settings [--set key=value] [--unset key]",
        flags: [
          { name: "--set", description: "Set `key=value` (only allowed keys; never a secret).", value_expected: true },
          { name: "--unset", description: "Remove a key.", value_expected: true },
          { name: "--include-env", description: "Include resolved env-var names (not values)." },
        ],
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const setFlag = typeof parsed.flags.set === "string" ? parsed.flags.set : undefined;
  const unsetFlag = typeof parsed.flags.unset === "string" ? parsed.flags.unset : undefined;
  const includeEnv = parsed.flags["include-env"] === true;

  try {
    let settings = await readSettings();

    if (setFlag) {
      const eq = setFlag.indexOf("=");
      if (eq < 0) {
        emit(
          {
            ok: false,
            subcommand: "eval settings",
            covenant_kind: meta.covenant_kind,
            error: "bad_set_syntax",
            hint: "Use --set key=value (e.g. --set headless=false).",
          },
          opts,
        );
        process.exit(EX_USAGE);
      }
      const key = setFlag.slice(0, eq);
      const rawValue = setFlag.slice(eq + 1);
      const reason = rejectionReason(key, rawValue);
      if (reason) {
        emit(
          {
            ok: false,
            subcommand: "eval settings",
            covenant_kind: meta.covenant_kind,
            error: reason,
            key,
            hint:
              reason === "key_not_allowed"
                ? `Only these keys are settable: ${[...ALLOWED_SET].join(", ")}.`
                : "Secrets belong in a value-source; declare one via `unbrowse build value-source` and reference it as a pointer at use-time. Do NOT pin secrets in settings.json — use pointer.",
            allowed_keys: [...ALLOWED_SET],
          },
          opts,
        );
        process.exit(EX_USAGE);
      }
      settings = { ...settings, [key]: coerceValue(key, rawValue) };
      await writeSettings(settings);
    }

    if (unsetFlag) {
      if (!ALLOWED_SET.has(unsetFlag)) {
        emit(
          {
            ok: false,
            subcommand: "eval settings",
            covenant_kind: meta.covenant_kind,
            error: "key_not_allowed",
            key: unsetFlag,
            allowed_keys: [...ALLOWED_SET],
          },
          opts,
        );
        process.exit(EX_USAGE);
      }
      const next: SettingsFile = { ...settings };
      delete next[unsetFlag];
      settings = next;
      await writeSettings(settings);
    }

    // Resolved env-var NAMES (never values).
    const env_names: string[] = [];
    if (includeEnv) {
      for (const k of Object.keys(process.env)) {
        if (k.startsWith("UNBROWSE_") || k === "KURI_HEADLESS" || k === "HEADLESS") {
          env_names.push(k);
        }
      }
      env_names.sort();
    }

    emit(
      {
        ok: true,
        subcommand: "eval settings",
        covenant_kind: meta.covenant_kind,
        path: settingsPath(),
        allowed_keys: [...ALLOWED_SET],
        settings,
        env_names: includeEnv ? env_names : undefined,
      },
      opts,
    );
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
