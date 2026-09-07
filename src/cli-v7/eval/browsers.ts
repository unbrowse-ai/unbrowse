/**
 * `unbrowse eval browsers` — list installed local browsers as selectable options
 * and persist path memory for cookie import.
 *
 * Metadata only: name, family, profile root path, last-active, whether
 * cookies/history/bookmarks DBs exist. Never cookie values or history URLs.
 *
 * Path memory: ~/.unbrowse/browser-paths.json
 *   --set name=/path/to/user-data   remember a browser root
 *   --prefer name                   prefer that browser for auto cookie import
 *   --profile leaf                  optional with --set (Default, Profile 1, …)
 *
 * 1:1 mapping (kind-map.ts row "eval browsers"):
 *   CLI subcommand  : eval browsers
 *   MCP tool        : unbrowse_eval_browsers
 *   Op kind         : eval:browsers
 *   Verb            : eval (read-only for list; path memory write is explicit)
 */
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
import {
  listInstalledBrowsers,
  pickMostRecentBrowser,
} from "../../auth/browser-preferences.js";
import { shouldImportBrowserCookies } from "../../auth/index.js";
import {
  browserPathConfigFile,
  loadBrowserPathConfig,
  setBrowserPath,
  setPreferredBrowser,
} from "../../auth/browser-path-config.js";

function flagString(flags: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = flags[n];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].trim()) return v[0].trim();
  }
  return undefined;
}

export async function handler(
  parsed: ParsedV7Args,
  opts: OutputOptions,
): Promise<void> {
  const meta = lookupKindMap("eval", "browsers")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval browsers",
      {
        summary:
          "List installed local browsers and remember path configs for cookie import. Metadata only — no cookie values.",
        usage:
          "unbrowse eval browsers [--json] [--set name=/path] [--prefer name] [--profile Default]",
        flags: [
          { name: "--json", description: "JSON envelope (default for agents)." },
          {
            name: "--set",
            description: "Remember a browser path: name=/absolute/user-data-dir (e.g. chromium=~/.config/chromium).",
            value_expected: true,
          },
          {
            name: "--prefer",
            description: "Prefer this browser name for auto cookie import (stored in browser-paths.json).",
            value_expected: true,
          },
          {
            name: "--profile",
            description: "Optional profile leaf with --set (Default, Profile 1, …).",
            value_expected: true,
          },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
    return;
  }

  try {
    const setRaw = flagString(parsed.flags as Record<string, unknown>, "set");
    const prefer = flagString(parsed.flags as Record<string, unknown>, "prefer");
    const profile = flagString(parsed.flags as Record<string, unknown>, "profile");

    if (setRaw) {
      const eq = setRaw.indexOf("=");
      if (eq <= 0) {
        emitErr(
          EX_USAGE,
          "usage: --set name=/path/to/user-data-dir",
          { subcommand: "eval browsers", op_kind: meta.op_kind },
          opts,
        );
        return;
      }
      const name = setRaw.slice(0, eq).trim();
      let dir = setRaw.slice(eq + 1).trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "");
      if (!name || !dir) {
        emitErr(
          EX_USAGE,
          "usage: --set name=/path/to/user-data-dir",
          { subcommand: "eval browsers", op_kind: meta.op_kind },
          opts,
        );
        return;
      }
      setBrowserPath(name, dir, { profile, prefer: Boolean(prefer) || prefer === name });
    }
    if (prefer && !setRaw) {
      setPreferredBrowser(prefer);
    } else if (prefer && setRaw) {
      setPreferredBrowser(prefer);
    }

    const memory = loadBrowserPathConfig();
    const browsers = listInstalledBrowsers();
    const pick = pickMostRecentBrowser();
    const importEnabled = shouldImportBrowserCookies();

    if (!opts.json) {
      process.stdout.write(
        `cookie_import=${importEnabled ? "on" : "off"} (UNBROWSE_IMPORT_BROWSER_COOKIES / UNBROWSE_COOKIE_IMPORT)\n`,
      );
      process.stdout.write(`memory_file=${browserPathConfigFile()}\n`);
      process.stdout.write(`prefer=${memory.prefer ?? "auto"}\n`);
      for (const [k, v] of Object.entries(memory.browsers)) {
        process.stdout.write(`memory\t${k}\t${v.userDataDir}${v.profile ? ` profile=${v.profile}` : ""}\n`);
      }
      process.stdout.write(
        `most_recent_chromium=${pick ? `${pick.name} ${pick.userDataDir}` : "none"}\n`,
      );
      for (const b of browsers) {
        const flags = [
          b.has_cookies_db ? "cookies" : null,
          b.has_history_db ? "history" : null,
          b.has_bookmarks ? "bookmarks" : null,
        ]
          .filter(Boolean)
          .join(",");
        process.stdout.write(
          `${b.name}\t${b.family}\t${b.last_active ?? "-"}\t[${flags}]\t${b.userDataDir}\n`,
        );
      }
      return;
    }

    emit({
      ok: true,
      subcommand: "eval browsers",
      op_kind: meta.op_kind,
      cookie_import_enabled: importEnabled,
      memory_file: browserPathConfigFile(),
      prefer: memory.prefer ?? null,
      configured: memory.browsers,
      most_recent_chromium: pick
        ? { name: pick.name, userDataDir: pick.userDataDir, lastActiveMs: pick.lastActiveMs }
        : null,
      count: browsers.length,
      // Paths only — never cookie values / history URLs.
      browsers: browsers.map((b) => ({
        name: b.name,
        family: b.family,
        userDataDir: b.userDataDir,
        last_active: b.last_active,
        has_cookies_db: b.has_cookies_db,
        has_history_db: b.has_history_db,
        has_bookmarks: b.has_bookmarks,
      })),
      priority_policy: "cookie ≫ bookmark ≫ history (see eval auth-inventory scores)",
      _contract: {
        terminal: false,
        settled: ["interpret"],
        frontier: "verify",
        engine: "fallback",
      },
    });
  } catch (err) {
    emitErr(
      EX_GENERIC,
      err instanceof Error ? err.message : String(err),
      { subcommand: "eval browsers", op_kind: meta.op_kind },
      opts,
    );
  }
}
