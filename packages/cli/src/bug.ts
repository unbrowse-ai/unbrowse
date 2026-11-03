// The CLI's last unexpected failure, kept so `unbrowse bug` can turn it into a ready report (and an agent into a fix
// PR, skills/unbrowse-contribute). Everything written or printed goes through `redact` first: no token, key, cookie
// or password ever lands in the file or the report.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REPO = "unbrowse-ai/unbrowse";
const SECRET_NAME = /(key|token|secret|passw|cookie|auth|session|credential|otp|totp)/i;

/** Masks credentials in free text: Unbrowse keys, bearer headers, common provider keys, `name=value` secrets. */
export function redact(text: string): string {
  return text
    .replace(/\bub_(live|test)_[A-Za-z0-9_-]+/g, "ub_$1_<redacted>")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>")
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, "$1_<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "<redacted-jwt>")
    .replace(/(["']?)([A-Za-z0-9_-]*(?:key|token|secret|passw(?:or)?d?|cookie)[A-Za-z0-9_-]*)\1(\s*[:=]\s*)(["']?)[^\s"',;&}]+\4/gi, "$1$2$1$3$4<redacted>$4");
}

/** The command line with secret-looking flag values and `--set name=value` secrets masked. */
export function redactArgv(argv: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const flag = /^--([^=]+)(=.*)?$/.exec(a);
    if (flag && SECRET_NAME.test(flag[1]!)) {
      if (flag[2] !== undefined) out.push(`--${flag[1]}=<redacted>`);
      else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) out.push(a, "<redacted>"), i++;
      else out.push(a);
      continue;
    }
    if (a === "--set" && i + 1 < argv.length) {
      const [name, ...rest] = argv[i + 1]!.split("=");
      out.push(a, SECRET_NAME.test(name!) && rest.length ? `${name}=<redacted>` : argv[i + 1]!);
      i++;
      continue;
    }
    out.push(a);
  }
  return redact(out.map((a) => (/^[\w@%+=:,./<>-]+$/.test(a) ? a : JSON.stringify(a))).join(" "));
}

export type Failure = { at: string; version: string; command: string; status: number | null; message: string; stack?: string; details?: string };

/**
 * Is this failure Unbrowse's to fix? A 5xx from the server, or a programming error in the CLI or SDK (TypeError,
 * ReferenceError, RangeError: code that broke, not an answer). A plain Error is a message the code meant to give
 * (sign-in denied, a code expired), 4xx are about the request, and network failures are the connection.
 */
export function isBug(e: { status?: number; name?: string }, network: boolean): boolean {
  if (network) return false;
  if (typeof e.status === "number") return e.status >= 500;
  return e.name === "TypeError" || e.name === "ReferenceError" || e.name === "RangeError";
}

const file = (dir: string) => join(dir, "last-error.json");

export function record(dir: string, f: Failure): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safe: Failure = { ...f, command: redact(f.command), message: redact(f.message), ...(f.stack ? { stack: redact(f.stack) } : {}), ...(f.details ? { details: redact(f.details).slice(0, 2000) } : {}) };
    writeFileSync(file(dir), `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* a report is best effort: never fail the command over it */
  }
}

export function last(dir: string): Failure | undefined {
  try {
    return existsSync(file(dir)) ? (JSON.parse(readFileSync(file(dir), "utf8")) as Failure) : undefined;
  } catch {
    return undefined;
  }
}

/** The line the CLI prints after an unexpected failure, so whoever reads stderr (often an agent) knows what to do. */
export function hint(version: string): string {
  return `This looks like a bug in Unbrowse ${version}. \`unbrowse bug "<what you expected>"\` prints a ready report. Agents: follow the unbrowse-contribute skill (reproduce, then a fix PR to github.com/${REPO}, once the person agrees).`;
}

export type Report = { title: string; body: string; failure?: Failure; next: string[] };

/** A ready-to-file report: the person's note, the environment and the last failure, all redacted. */
export function report(opts: { note: string; version: string; node: string; os: string; failure?: Failure; now?: number }): Report {
  const f = opts.failure;
  const note = redact(opts.note.trim());
  const title = note ? note.slice(0, 80) : f ? `\`unbrowse ${f.command.split(" ")[0] ?? ""}\`: ${f.message}`.slice(0, 80) : "unbrowse: <what failed>";
  const age = f ? Math.round(((opts.now ?? Date.now()) - Date.parse(f.at)) / 60000) : 0;
  const lines = [
    "## What happened",
    "",
    note || "<what you expected, and what happened instead>",
    "",
    "## Reproduce",
    "",
    "```sh",
    f ? `unbrowse ${f.command}` : "unbrowse <the shortest command that shows it>",
    "```",
    "",
    "## Environment",
    "",
    `- unbrowse ${opts.version}, Node ${opts.node}, ${opts.os}`,
    ...(f
      ? [
          "",
          `## Last failure (${f.at}, ${age < 1 ? "just now" : `${age} min ago`}${f.version !== opts.version ? `, unbrowse ${f.version}` : ""})`,
          "",
          "```",
          `${f.status ? `HTTP ${f.status}: ` : ""}${f.message}`,
          ...(f.stack ? [f.stack] : []),
          ...(f.details ? [f.details] : []),
          "```",
        ]
      : []),
  ];
  const words = (note || f?.message || "").replace(/[^\w\s-]/g, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 4).join(" ");
  const next = [
    `gh issue list -R ${REPO} --state all --search "${words}"`,
    `gh pr list -R ${REPO} --state all --search "${words}"`,
    `client bug (CLI, SDK, MCP proxy, plugin, docs): fork, failing test, fix, then gh pr create -R ${REPO} (skill: unbrowse-contribute)`,
    `hosted bug (run results, 5xx): gh issue create -R ${REPO} --title "hosted: …" --body-file <this report>`,
  ];
  return { title, body: lines.join("\n"), ...(f ? { failure: f } : {}), next };
}
