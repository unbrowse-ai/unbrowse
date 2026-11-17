// The telemetry worker: takes batches of usage events from nodes and keeps them in D1 for aggregate queries, and
// relays agents' bug reports to GitHub issues.
//
//   POST /v1/events   {"events": [{"event": "tool_call", "version": "1.4.2", "os": "macos", "install_id": "…",
//                                  "tool": "unbrowse_do", "outcome": "ok", "duration_ms": 120}]}
//   POST /v1/reports  {"kind": "wrong_data", "summary": "…", "expected": "…", "got": "…", "version": "1.4.2", …}
//
// A batch is kept whole or refused whole (400): every event must hold the allowed fields only, each value from its
// list or of its shape (./schema.js). Nothing else about the request is kept: not the caller's IP address, its
// headers, its country or the exact time. An event's row holds its own fields and the hour it arrived.

import { checkBatch, MAX_BODY_BYTES } from "./schema.js";
import * as report from "./report.js";
import { namedQueries } from "./sql.js";

const COLUMNS = ["event", "version", "os", "install_id", "tool", "outcome", "duration_ms", "error_class"];
const INSERT = `INSERT INTO events (received_hour, ${COLUMNS.join(", ")}) VALUES (?, ${COLUMNS.map(() => "?").join(", ")})`;

function answer(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
}

/** Whether the request says its body is JSON. */
function isJson(request) {
  return (request.headers.get("content-type") || "").toLowerCase().startsWith("application/json");
}

/** The request's body as text, or null when it is longer than `limit` bytes. */
async function readCapped(request, limit) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The start of the hour `now` is in, in Unix seconds. */
export function hourOf(now) {
  return Math.floor(now / 3_600_000) * 3600;
}

export async function handle(request, env, now = Date.now(), fetcher = (url, init) => fetch(url, init)) {
  const { pathname } = new URL(request.url);
  if (pathname === "/healthz") return answer(200, { status: "ok" });
  if (pathname === "/v1/reports") return relay(request, env, now, fetcher);
  if (pathname.startsWith("/v1/stats/")) return stats(request, env, pathname.slice("/v1/stats/".length));
  if (pathname !== "/v1/events") return answer(404, { error: "not found" });
  if (request.method !== "POST") return answer(405, { error: "POST a batch of events" });
  if (!isJson(request)) return answer(415, { error: "send JSON" });
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return answer(413, { error: `at most ${MAX_BODY_BYTES} bytes a batch` });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return answer(400, { error: "not JSON" });
  }
  const { events, error } = checkBatch(body);
  if (error) return answer(400, { error });
  const hour = hourOf(now);
  const insert = env.TELEMETRY_DB.prepare(INSERT);
  try {
    await env.TELEMETRY_DB.batch(events.map((e) => insert.bind(hour, ...COLUMNS.map((c) => e[c] ?? null))));
  } catch {
    return answer(503, { error: "not kept; the node drops it" });
  }
  return answer(204);
}

// ---- bug reports ----
//
// A report becomes an issue in REPORTS_REPO (unbrowse-ai/unbrowse), filed with GITHUB_TOKEN, a Worker secret. Its text
// is scrubbed again here (./report.js), whatever the node did. Reports of one problem (one fingerprint) share one
// issue: the first opens it, later ones bump its count and add a comment that says only the count, at most once a
// day per issue and at most COMMENTS_PER_DAY a day in all. A problem whose issue was closed opens a new one. D1 keeps
// the fingerprint, its issue and its counts, and a count of reports per signer per day under a hash of the signer
// key and the day; never a report's text, which lives only in the public issue.
//
// Only a node files: a report is signed by the node that sends it, with its own report key (Ed25519, kept by the node,
// apart from its wallet so a report names no one), over "unbrowse/report\n" and the body's exact bytes. The key and the
// signature ride in `x-unbrowse-key` and `x-unbrowse-signature` (hex). An unsigned or badly signed report is refused
// (401) before anything is read or kept. The limits are per signer: what one key files a day, and how many new issues
// of those, so one sender can't spend the day's issues or comments. A key costs nothing to make, so the daily caps
// on new issues and comments still hold for everyone, and a rate limit by IP at Cloudflare's edge (README) slows one
// sender without the worker ever seeing the IP. The install id is the sender's own word and limits nothing.
//
// While nodes from before signing are still out, REPORTS_ACCEPT_UNSIGNED=1 takes unsigned reports too: all of them
// together under limits far below one signer's (UNSIGNED_PER_DAY, UNSIGNED_NEW_ISSUES_PER_DAY), each one logged as a
// warning that says how to turn it off, since nothing about them says who sent them.

/** Said in the worker's log for every unsigned report taken, so the switch isn't left on unseen. */
export const UNSIGNED_WARNING =
  "REPORTS_ACCEPT_UNSIGNED=1: took a report no node signed. Turn it off once nodes sign their reports: `npx wrangler secret delete REPORTS_ACCEPT_UNSIGNED` (or remove it from the dashboard's variables), then `npx wrangler deploy`.";

const DAY_MS = 86_400_000;
const REPO = "unbrowse-ai/unbrowse";
const GITHUB_API = "https://api.github.com";

const BUMP = `INSERT INTO report_limits (key, day, count) VALUES (?, ?, 1)
  ON CONFLICT (key) DO UPDATE SET count = count + 1 RETURNING count`;
const CLAIM = `INSERT INTO report_issues (fingerprint, kind, issue_number, issue_url, reports, first_day, last_day, last_comment_day)
  VALUES (?, ?, 0, '', 1, ?, ?, -1)
  ON CONFLICT (fingerprint) DO UPDATE SET reports = reports + 1, last_day = excluded.last_day
  RETURNING issue_number, issue_url, reports, first_day, last_comment_day`;
const RECORD = "UPDATE report_issues SET issue_number = ?, issue_url = ?, reports = ?, first_day = ?, last_comment_day = ? WHERE fingerprint = ?";

/** A call to GitHub's API for the repository, with the Worker's token: a POST with `body`, or a GET without. */
function github(env, fetcher, path, body, { repoPath = true } = {}) {
  const base = env.GITHUB_API || GITHUB_API;
  return fetcher(repoPath ? `${base}/repos/${env.REPORTS_REPO || REPO}${path}` : `${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "unbrowse-report-relay",
      "x-github-api-version": "2022-11-28",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The JSON of a call that answered 2xx, or null; `undefined` when the call didn't complete. */
async function json(call) {
  const res = await call.catch(() => undefined);
  if (res === undefined) return undefined;
  return res.ok ? res.json().catch(() => null) : null;
}

/** The relay's mark for a fingerprint's issue: an HMAC of the fingerprint under the relay's own GitHub token, so only
 *  the relay can make it. The fingerprint is public (it is in every issue), and anyone can open an issue in the
 *  repository; the mark is what says an issue is one the relay opened. 32 hex digits. */
export async function issueMark(env, fp) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(env.GITHUB_TOKEN)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`unbrowse/report-issue\n${fp}`));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** The issue a fingerprint was filed under, for a claim whose issue may have been opened without its number being
 *  kept: only an issue the relay opened, one carrying its mark and its label, and of those the first, since a copy of
 *  a public issue's body comes after it. Never an issue someone else opened with the fingerprint in its body.
 *  `undefined` when GitHub couldn't be asked. */
async function findIssue(env, fetcher, fp) {
  const mark = await issueMark(env, fp);
  const q = encodeURIComponent(`repo:${env.REPORTS_REPO || REPO} is:issue label:agent-report in:body ${mark}`);
  const found = await json(github(env, fetcher, `/search/issues?q=${q}`, undefined, { repoPath: false }));
  if (found === undefined || found === null) return undefined;
  const ours = (found.items || []).filter(
    (i) =>
      Number.isSafeInteger(i.number) &&
      String(i.body || "").includes(`Relay mark \`${mark}\``) &&
      String(i.body || "").includes(`Fingerprint \`${fp}\``) &&
      (i.labels || []).some((l) => (typeof l === "string" ? l : l && l.name) === "agent-report"),
  );
  const issue = ours.sort((a, b) => a.number - b.number)[0];
  return issue ? { number: issue.number, html_url: issue.html_url } : null;
}

/** Writes a statement, once more if it fails the first time. */
async function write(stmt) {
  try {
    await stmt.run();
  } catch {
    await stmt.run();
  }
}

const SIGNED = new TextEncoder().encode("unbrowse/report\n");

const unhex = (h) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

/** The report key that signed `text`, in hex: `x-unbrowse-key` (32 bytes) and `x-unbrowse-signature` (64 bytes, over
 *  "unbrowse/report\n" and the body), checked with Ed25519. Null when either is missing, malformed or doesn't verify. */
export async function signerOf(request, text) {
  const key = (request.headers.get("x-unbrowse-key") || "").toLowerCase();
  const sig = (request.headers.get("x-unbrowse-signature") || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key) || !/^[0-9a-f]{128}$/.test(sig)) return null;
  const body = new TextEncoder().encode(text);
  const message = new Uint8Array(SIGNED.length + body.length);
  message.set(SIGNED);
  message.set(body, SIGNED.length);
  try {
    const k = await crypto.subtle.importKey("raw", unhex(key), { name: "Ed25519" }, false, ["verify"]);
    return (await crypto.subtle.verify({ name: "Ed25519" }, k, unhex(sig), message)) ? key : null;
  } catch {
    return null;
  }
}

async function relay(request, env, now, fetcher) {
  if (request.method !== "POST") return answer(405, { error: "POST a report" });
  if (!isJson(request)) return answer(415, { error: "send JSON" });
  const text = await readCapped(request, report.MAX_BODY_BYTES);
  if (text === null) return answer(413, { error: `at most ${report.MAX_BODY_BYTES} bytes a report` });
  const signer = (await signerOf(request, text)) ?? (env.REPORTS_ACCEPT_UNSIGNED === "1" ? "unsigned" : null);
  if (signer === null) return answer(401, { error: "a report is signed by the node that sends it (x-unbrowse-key, x-unbrowse-signature)" });
  const unsigned = signer === "unsigned";
  if (unsigned) console.warn(UNSIGNED_WARNING);
  const perSigner = unsigned ? report.UNSIGNED_PER_DAY : report.PER_SIGNER_PER_DAY;
  const issuesPerSigner = unsigned ? report.UNSIGNED_NEW_ISSUES_PER_DAY : report.NEW_ISSUES_PER_SIGNER_PER_DAY;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return answer(400, { error: "not JSON" });
  }
  const why = report.check(body);
  if (why) return answer(400, { error: why });
  if (!env.GITHUB_TOKEN || !env.TELEMETRY_DB) return answer(503, { error: "reports aren't taken yet; the node keeps it and tries later" });

  const r = report.publicReport(body);
  const fp = await report.fingerprint(r);
  const day = Math.floor(now / DAY_MS);
  const db = env.TELEMETRY_DB;
  try {
    // Yesterday's counts go (report_limits is indexed by day).
    await db.prepare("DELETE FROM report_limits WHERE day < ?").bind(day).run();
    const mine = await db.prepare(BUMP).bind(await report.sha256hex(`signer:${signer}:${day}`), day).first();
    if (mine.count > perSigner) {
      return answer(429, { error: unsigned ? `at most ${perSigner} unsigned reports a day, all of them together: sign reports (an updated node does)` : `at most ${perSigner} reports a node a day` });
    }
    let row = await db.prepare(CLAIM).bind(fp, r.kind, day, day).first();

    // A claim from an earlier day that never got its number: the issue may have been opened and its number lost.
    // GitHub is asked before another is opened.
    let open = row.reports === 1;
    if (row.issue_number === 0 && row.reports > 1 && row.first_day < day) {
      const found = await findIssue(env, fetcher, fp);
      if (found === undefined) return answer(502, { error: "GitHub couldn't be asked; the node tries later" });
      if (found) {
        await write(db.prepare(RECORD).bind(found.number, found.html_url, row.reports, row.first_day, row.last_comment_day, fp));
        row = { ...row, issue_number: found.number, issue_url: found.html_url };
      } else open = true;
    }

    /** Opens the problem's issue (`previous`: the closed one it follows), within the day's cap. */
    const file = async (previous) => {
      const own = await db.prepare(BUMP).bind(await report.sha256hex(`issues:${signer}:${day}`), day).first();
      if (own.count > issuesPerSigner) return { capped: true };
      const filed = await db.prepare(BUMP).bind(`issues:${day}`, day).first();
      if (filed.count > report.NEW_ISSUES_PER_DAY) return { capped: true };
      const body = report.issueBody(r, fp, previous, await issueMark(env, fp));
      const res = await github(env, fetcher, "/issues", { title: report.title(r), body, labels: ["agent-report", r.kind] }).catch(() => undefined);
      if (res === undefined) return { lost: true };
      const issue = res.ok ? await res.json().catch(() => null) : null;
      if (!issue || !Number.isSafeInteger(issue.number)) return {};
      // The issue exists now, whatever D1 does next: a failed write leaves a claim GitHub is asked about later,
      // never a second issue.
      await write(db.prepare(RECORD).bind(issue.number, issue.html_url, 1, day, day, fp)).catch(() => {});
      return { issue };
    };

    if (open) {
      const { issue, capped, lost } = await file(null);
      if (!issue) {
        // A request that didn't complete may have opened the issue: its claim stays, for GitHub to be asked later.
        if (!lost) await db.prepare("DELETE FROM report_issues WHERE fingerprint = ? AND issue_number = 0").bind(fp).run();
        return capped
          ? answer(429, { error: "the relay has opened as many issues as it opens in a day; the node tries tomorrow" })
          : answer(502, { error: "GitHub didn't take the issue; the node tries later" });
      }
      return answer(201, { issue: issue.html_url, number: issue.number, new: true, reports: 1, fingerprint: fp });
    }
    if (row.issue_number === 0) return answer(202, { issue: null, new: false, reports: row.reports, fingerprint: fp });
    if (row.last_comment_day < day) {
      const known = await json(github(env, fetcher, `/issues/${row.issue_number}`));
      if (known && known.state === "closed") {
        // Closed means fixed, or not a bug: the problem seen again is a new issue, pointing at the old one.
        const { issue } = await file(row.issue_number);
        if (issue) return answer(201, { issue: issue.html_url, number: issue.number, new: true, reports: 1, fingerprint: fp });
      } else {
        const said = await db.prepare(BUMP).bind(`comments:${day}`, day).first();
        if (said.count <= report.COMMENTS_PER_DAY) {
          const commented = await github(env, fetcher, `/issues/${row.issue_number}/comments`, { body: report.seenAgainBody(r, row.reports) }).catch(() => null);
          if (commented && commented.ok) {
            await db.prepare("UPDATE report_issues SET last_comment_day = ? WHERE fingerprint = ?").bind(day, fp).run();
          }
        }
      }
    }
    return answer(200, { issue: row.issue_url, number: row.issue_number, new: false, reports: row.reports, fingerprint: fp });
  } catch {
    return answer(503, { error: "not kept; the node tries later" });
  }
}

// ---- reading the counts ----
//
//   GET /v1/stats/<name>   Authorization: Bearer <ADMIN_TOKEN>   → 200 {"name": …, "rows": [...]}
//
// Only the named questions in queries.sql, never SQL from the caller. With no ADMIN_TOKEN secret the door doesn't
// exist (404), and a wrong token gets the same 404, so the worker never says whether it has one.

/** Whether two strings are equal, in time that depends only on their lengths. */
function same(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function stats(request, env, name) {
  const token = env.ADMIN_TOKEN || "";
  const given = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (token.length < 16 || !same(given, token)) return answer(404, { error: "not found" });
  if (request.method !== "GET") return answer(405, { error: "GET a named question" });
  const queries = namedQueries(env.QUERIES || "");
  if (!name) return answer(200, { names: Object.keys(queries) });
  if (!Object.hasOwn(queries, name)) return answer(404, { error: `no question named ${name}`, names: Object.keys(queries) });
  try {
    const { results } = await env.TELEMETRY_DB.prepare(queries[name]).all();
    return answer(200, { name, rows: results });
  } catch {
    return answer(503, { error: "the store didn't answer" });
  }
}

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};
