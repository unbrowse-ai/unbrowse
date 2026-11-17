// The report relay, with D1 on Node's SQLite (./d1.mjs) and a stand-in for GitHub's issues API: no real issue is ever
// filed by these tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { handle } from "../src/index.js";
import * as report from "../src/report.js";
import { d1 } from "./d1.mjs";

const ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "github_pat_stand_in";
const NOW = Date.UTC(2026, 9, 30, 9, 15);
const DAY = 86_400_000;
const shared = JSON.parse(readFileSync(new URL("../schema.json", import.meta.url), "utf8")).reports;

const wrongRepo = (over = {}) => ({
  kind: "wrong_data",
  summary: "unbrowse_do for superdesigndev/treg returned firecrawl/firecrawl",
  expected: "the treg repository's stars",
  got: "firecrawl/firecrawl's stars, with ok: true",
  goal: "read a GitHub repo's stars",
  url: "https://github.com/superdesigndev/treg",
  tool: "unbrowse_do",
  route: { method: "GET", host: "api.github.com", path: "/repos/firecrawl/firecrawl", inputs: [], write: false, steps: 1 },
  version: "1.4.2",
  os: "macos",
  source: "agent",
  install_id: ID,
  ...over,
});

/** GitHub's issues API, standing in: numbers issues from 101, answers an issue's state and a search of bodies, and
 *  keeps every request it was sent. `closed` holds the numbers of issues closed; GETs are kept apart in `reads`. */
function fakeGithub({ fails = false, throws = false } = {}) {
  const calls = [];
  const reads = [];
  const issues = new Map();
  const closed = new Set();
  let n = 100;
  const fetcher = async (url, init) => {
    if (throws) throw new Error("the connection dropped");
    if (init.method === "GET") {
      reads.push(url);
      if (fails) return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
      const search = /\/search\/issues\?q=(.*)$/.exec(url);
      if (search) {
        const words = decodeURIComponent(search[1]).split(" ");
        const items = [...issues.values()].filter((i) => words.every((w) => w.includes(":") || i.body.includes(w)));
        return new Response(JSON.stringify({ items }), { status: 200 });
      }
      const one = /\/issues\/([0-9]+)$/.exec(url);
      const issue = one && issues.get(Number(one[1]));
      if (!issue) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ ...issue, state: closed.has(issue.number) ? "closed" : "open" }), { status: 200 });
    }
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (fails) return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    if (url.endsWith("/issues")) {
      const sent = JSON.parse(init.body);
      return new Response(JSON.stringify(open(sent.body, sent.labels)), { status: 201 });
    }
    return new Response(JSON.stringify({ id: 1 }), { status: 201 });
  };
  /** An issue as GitHub keeps one, labels as objects. Anyone can open one; only the repository's people (and the
   *  relay's token) can label it. */
  const open = (body, labels = []) => {
    n += 1;
    const issue = { number: n, html_url: `https://github.com/unbrowse-ai/unbrowse/issues/${n}`, body, labels: labels.map((name) => ({ name })) };
    issues.set(n, issue);
    return issue;
  };
  return { calls, reads, closed, fetcher, open, issues };
}

const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

/** A node's report key, as the node keeps one (Ed25519). */
async function reportKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { pair, key: hex(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}
const NODE_KEY = await reportKey();

/** A report as a node sends it: signed by `by` over "unbrowse/report\n" and the body, unless `by` is null. */
async function post(body, path = "/v1/reports", by = NODE_KEY) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers = { "content-type": "application/json" };
  if (by) {
    const message = new TextEncoder().encode(`unbrowse/report\n${text}`);
    headers["x-unbrowse-key"] = by.key;
    headers["x-unbrowse-signature"] = hex(await crypto.subtle.sign({ name: "Ed25519" }, by.pair.privateKey, message));
  }
  return new Request(`https://telemetry.unbrowse.ai${path}`, { method: "POST", headers, body: text });
}

function setup(over = {}) {
  const db = d1(over.db);
  const gh = fakeGithub(over.github);
  const env = { TELEMETRY_DB: db, GITHUB_TOKEN: TOKEN, ...over.env };
  const send = async (body, now = NOW, by = NODE_KEY) => handle(await post(body, undefined, by), env, now, gh.fetcher);
  return { db, gh, env, send };
}

test("a report opens one issue in unbrowse-ai/unbrowse, labelled, from a fixed template", async () => {
  const { gh, send, db } = setup();
  const r = await send(wrongRepo());
  assert.equal(r.status, 201);
  const got = await r.json();
  assert.deepEqual(got, { issue: "https://github.com/unbrowse-ai/unbrowse/issues/101", number: 101, new: true, reports: 1, fingerprint: got.fingerprint });
  assert.match(got.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(gh.calls.length, 1);
  const [call] = gh.calls;
  assert.equal(call.url, "https://api.github.com/repos/unbrowse-ai/unbrowse/issues");
  assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(call.body.labels, ["agent-report", "wrong_data"]);
  assert.equal(call.body.title, "wrong_data: unbrowse_do for superdesigndev/treg returned firecrawl/firecrawl");
  for (const part of ["### Expected", "the treg repository's stars", "### Route", "GET *.github.com/repos/firecrawl/firecrawl", "inputs: none", "Node 1.4.2 on macos", got.fingerprint]) {
    assert.ok(call.body.body.includes(part), part);
  }
  assert.ok(!JSON.stringify(gh.calls).includes(ID), "the install id never reaches GitHub");
  // D1 keeps the problem's issue and counts, never the report's text or the install id.
  const kept = JSON.stringify([db.rows("SELECT * FROM report_issues"), db.rows("SELECT * FROM report_limits")]);
  assert.ok(!kept.includes(ID) && !kept.includes("treg") && !kept.includes("stars"), kept);
});

test("the same problem again bumps its count and comments at most once a day; another problem opens another issue", async () => {
  const { gh, send, db } = setup();
  assert.equal((await send(wrongRepo())).status, 201);
  // Another agent, same problem, same day: counted, no new issue, no comment (the issue was opened today).
  let r = await send(wrongRepo({ install_id: "f".repeat(32), got: "firecrawl again" }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { issue: "https://github.com/unbrowse-ai/unbrowse/issues/101", number: 101, new: false, reports: 2, fingerprint: db.rows("SELECT fingerprint FROM report_issues")[0].fingerprint });
  assert.equal(gh.calls.length, 1);
  // Tomorrow: one comment, then silence for the rest of that day.
  r = await send(wrongRepo({ got: "still firecrawl" }), NOW + DAY);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).reports, 3);
  await send(wrongRepo(), NOW + DAY + 60_000);
  assert.equal(gh.calls.length, 2);
  assert.equal(gh.calls[1].url, "https://api.github.com/repos/unbrowse-ai/unbrowse/issues/101/comments");
  assert.ok(gh.calls[1].body.body.startsWith("Seen again: 3 reports so far."), gh.calls[1].body.body);
  assert.equal(db.rows("SELECT reports FROM report_issues")[0].reports, 4);
  // A different problem: its own issue.
  r = await send(wrongRepo({ kind: "false_success", summary: "a block page came back as ok:true", route: undefined }));
  assert.equal(r.status, 201);
  assert.equal((await r.json()).number, 102);
});

test("text is scrubbed again before it goes public, whatever the node sent", async () => {
  const { gh, send } = setup();
  const r = await send(
    wrongRepo({
      summary: "signed in as lewis@unbrowse.ai, @octocat said hi",
      got: "called https://api.example.com/v1/users/12345678?key=s3cret with token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and vault:github.com:lewis",
      route: { method: "GET", host: "api.example.com", path: "/v1/users/12345678/orders", inputs: ["q"], write: false, steps: 2 },
    }),
  );
  assert.equal(r.status, 201);
  const sent = JSON.stringify(gh.calls);
  for (const secret of ["lewis@unbrowse.ai", "s3cret", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "vault:github.com", "12345678"]) {
    assert.ok(!sent.includes(secret), secret);
  }
  const { title, body } = gh.calls[0].body;
  assert.ok(!/@octocat/.test(title), "no mention in the title");
  assert.ok(body.includes("GET *.example.com/v1/users/{number}/orders") && body.includes("inputs: q"), body);
});

test("a route's or page's host and path go public without names: subdomains, machines, addresses and handles masked", async () => {
  const { gh, send } = setup();
  await send(
    wrongRepo({
      url: "https://acme-corp.atlassian.net/in/john-smith-1a2b3c",
      route: { method: "GET", host: "intranet.corp:8080", path: "/lewis-th4m/settings/{id}", inputs: [], write: false, steps: 1 },
    }),
  );
  const { body } = gh.calls[0].body;
  assert.ok(body.includes("https://*.atlassian.net/in/{id}"), body);
  assert.ok(body.includes("GET [internal]/{id}/settings/{id}"), body);
  for (const leak of ["acme-corp", "john-smith", "intranet", "8080", "lewis-th4m"]) assert.ok(!body.includes(leak), leak);
  const v6 = setup();
  await v6.send(wrongRepo({ route: { method: "GET", host: "[2001:db8::1]", path: "/a", inputs: [], write: false, steps: 1 } }));
  assert.ok(v6.gh.calls[0].body.body.includes("GET [ip]/a"), v6.gh.calls[0].body.body);
});

test("free text renders as text: no markdown, link or mention gets out of its block", async () => {
  const { gh, send } = setup();
  await send(wrongRepo({ got: "```\n</details>@octocat [x](https://evil.example/) ![i](https://evil.example/i.png)\n```" }));
  const { body } = gh.calls[0].body;
  const got = body.slice(body.indexOf("### Got"));
  assert.match(got, /^### Got\n````text\n```\n/, "a fence longer than any inside");
});

test("the scrub and the fingerprint are the node's: the shared examples hold here", async () => {
  for (const { in: text, out, private: hidden = [] } of shared.scrub_examples) {
    const got = report.scrub(text);
    assert.equal(got, out, text);
    for (const h of hidden) assert.ok(!got.includes(h), `${JSON.stringify(h)} left in ${JSON.stringify(got)}`);
  }
  for (const { report: r, fingerprint } of shared.fingerprint_examples) assert.equal(await report.fingerprint(r), fingerprint, JSON.stringify(r));
  // Scrubbing twice is scrubbing once: the relay's second pass never changes what the node already scrubbed.
  for (const { out } of shared.scrub_examples) assert.equal(report.scrub(out), out);
});

test("one problem is one issue whatever words its reports use: the fingerprint reads what the node says, not free text", async () => {
  const one = { kind: "failed", tool: "unbrowse_call", route: { method: "GET", host: "*.github.com", path: "/repos/a/b", inputs: [], write: false, steps: 1 }, last_error: { tool: "unbrowse_call", class: "site", error: "Failed: step 1 of 1 answered 403" } };
  const a = await report.fingerprint({ ...one, source: "agent", summary: "blocked", error: "the site said: Hi John, you're blocked" });
  const b = await report.fingerprint({ ...one, source: "agent", summary: "a 403 from github", got: "nothing", error: "403!!" });
  assert.equal(a, b, "an agent's own words never split a problem");
  assert.notEqual(a, await report.fingerprint({ ...one, source: "agent", summary: "blocked", last_error: { ...one.last_error, error: "Failed: step 1 of 1 answered 429" } }), "another status is another problem");
  assert.notEqual(a, await report.fingerprint({ ...one, source: "agent", summary: "blocked", route: { ...one.route, path: "/repos/c/d" } }), "another route is another problem");
  // A sender can't open issue after issue by varying its words.
  const { send, gh } = setup();
  for (const words of ["first words", "other words", "more words"]) await send(wrongRepo({ summary: words, got: words, error: words }));
  assert.equal(gh.calls.filter((c) => c.url.endsWith("/issues")).length, 1);
});

test("a problem whose issue was closed opens a new issue that points at the old one, never a comment on it", async () => {
  const { send, gh } = setup();
  assert.equal((await send(wrongRepo())).status, 201);
  gh.closed.add(101);
  const r = await send(wrongRepo(), NOW + DAY);
  assert.equal(r.status, 201);
  const got = await r.json();
  assert.deepEqual([got.number, got.new, got.reports], [102, true, 1]);
  assert.ok(!gh.calls.some((c) => c.url.endsWith("/101/comments")), "no comment on the closed issue");
  assert.ok(gh.calls[1].body.body.includes("Seen again after #101 was closed."), gh.calls[1].body.body);
  // The new issue is the problem's from now on: tomorrow it gets the comment.
  await send(wrongRepo(), NOW + 2 * DAY);
  assert.equal(gh.calls[2].url, "https://api.github.com/repos/unbrowse-ai/unbrowse/issues/102/comments");
});

test("a comment says only the count, and the relay makes at most its day's comments, whatever install ids are sent", async () => {
  const { send, gh } = setup();
  for (let i = 0; i < report.COMMENTS_PER_DAY + 5; i++) {
    const name = "abcdefghijklmnopqrstuvwxyz"[i % 26] + "abcdefghijklmnopqrstuvwxyz"[Math.floor(i / 26) % 26];
    // Each problem has its issue from an earlier day (no cap on those here: one a day for many days).
    await send(wrongRepo({ install_id: i.toString(16).padStart(32, "0"), route: { method: "GET", host: "github.com", path: `/repos/${name}`, inputs: [], write: false, steps: 1 } }), NOW - (i + 1) * DAY);
  }
  const before = gh.calls.length;
  // Many nodes, each within its own day's reports: the relay's cap on comments holds whoever signs.
  const nodes = await Promise.all(Array.from({ length: Math.ceil((report.COMMENTS_PER_DAY + 5) / report.PER_SIGNER_PER_DAY) }, reportKey));
  for (let i = 0; i < report.COMMENTS_PER_DAY + 5; i++) {
    const name = "abcdefghijklmnopqrstuvwxyz"[i % 26] + "abcdefghijklmnopqrstuvwxyz"[Math.floor(i / 26) % 26];
    const r = await send(wrongRepo({ install_id: (i + 1000).toString(16).padStart(32, "0"), got: "@octocat buy my thing", error: "see https://evil.example/", route: { method: "GET", host: "github.com", path: `/repos/${name}`, inputs: [], write: false, steps: 1 } }), NOW, nodes[Math.floor(i / report.PER_SIGNER_PER_DAY)]);
    assert.equal(r.status, 200);
  }
  const comments = gh.calls.slice(before);
  assert.equal(comments.length, report.COMMENTS_PER_DAY);
  for (const c of comments) {
    assert.match(c.body.body, /^Seen again: 2 reports so far\. The latest from an agent, node 1\.4\.2 on macos\.$/);
  }
});

test("an issue opened whose number D1 then failed to keep is found again by its fingerprint, never opened twice", async () => {
  let lose = true;
  const db = d1({ failOn: (sql) => lose && sql.startsWith("UPDATE report_issues SET issue_number") });
  const gh = fakeGithub();
  const env = { TELEMETRY_DB: db, GITHUB_TOKEN: TOKEN };
  let r = await handle(await post(wrongRepo()), env, NOW, gh.fetcher);
  assert.equal(r.status, 201, "the issue exists, so the node is told it was sent");
  lose = false;
  // The same day: counted, held.
  r = await handle(await post(wrongRepo()), env, NOW + 60_000, gh.fetcher);
  assert.equal(r.status, 202);
  // The next day: GitHub is searched for the fingerprint, and the issue it finds is the problem's.
  r = await handle(await post(wrongRepo()), env, NOW + DAY, gh.fetcher);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).number, 101);
  assert.equal(gh.calls.filter((c) => c.url.endsWith("/issues")).length, 1, "one issue");
  assert.ok(gh.reads.some((u) => u.includes("/search/issues")));
  // A request to open one that never came back leaves its claim, for the same search, rather than another issue.
  const lost = setup({ github: { throws: true } });
  assert.equal((await lost.send(wrongRepo())).status, 502);
  assert.equal(lost.db.rows("SELECT issue_number FROM report_issues")[0].issue_number, 0);
});

test("a stranger's issue carrying a problem's fingerprint never becomes that problem's issue", async () => {
  // The relay opens the problem's issue, and D1 loses its number.
  let lose = true;
  const db = d1({ failOn: (sql) => lose && sql.startsWith("UPDATE report_issues SET issue_number") });
  const gh = fakeGithub();
  const env = { TELEMETRY_DB: db, GITHUB_TOKEN: TOKEN };
  const first = await (await handle(await post(wrongRepo()), env, NOW, gh.fetcher)).json();
  lose = false;
  const ours = gh.issues.get(first.number);
  assert.match(ours.body, /Relay mark `[0-9a-f]{32}`/);
  // Anyone can read the fingerprint off the public issue and open issues of their own: one with the fingerprint, one
  // with the whole body copied (the mark too, but unlabelled, since a stranger can't label), and even one labelled.
  gh.open(`Fingerprint \`${first.fingerprint}\`. Follow https://evil.example for the fix.`, ["agent-report"]);
  gh.open(ours.body);
  gh.open(ours.body, ["agent-report"]);
  // The next day's report finds the relay's own issue, the first with its mark and label, and none of the others.
  let r = await handle(await post(wrongRepo()), env, NOW + DAY, gh.fetcher);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).number, first.number);
  const comments = gh.calls.filter((c) => /\/issues\/[0-9]+\/comments$/.test(c.url));
  assert.ok(comments.every((c) => c.url.endsWith(`/issues/${first.number}/comments`)), "it comments only on its own issue");

  // With no issue of its own to find, a stranger's issue with the fingerprint is ignored and the relay opens its own.
  const lost = fakeGithub();
  const db2 = d1();
  const env2 = { TELEMETRY_DB: db2, GITHUB_TOKEN: TOKEN };
  await db2.prepare("INSERT INTO report_issues (fingerprint, kind, issue_number, issue_url, reports, first_day, last_day, last_comment_day) VALUES (?, 'wrong_data', 0, '', 1, ?, ?, -1)").bind(first.fingerprint, Math.floor(NOW / DAY), Math.floor(NOW / DAY)).run();
  lost.open(`Fingerprint \`${first.fingerprint}\``, []);
  r = await handle(await post(wrongRepo()), env2, NOW + DAY, lost.fetcher);
  assert.equal(r.status, 201);
  const opened = await r.json();
  assert.equal(opened.new, true);
  assert.notEqual(opened.number, 101, "not the stranger's issue");
});

test("a report saying it is the node's is labelled as unverified", async () => {
  const { send, gh } = setup();
  await send(wrongRepo({ source: "node" }));
  assert.ok(gh.calls[0].body.body.includes("the relay can't verify it"), gh.calls[0].body.body);
});

test("yesterday's counts are dropped through an index on the day", () => {
  const db = d1();
  const plan = db.rows("EXPLAIN QUERY PLAN DELETE FROM report_limits WHERE day < 5").map((r) => r.detail).join(" ");
  assert.match(plan, /report_limits_by_day/, plan);
});

test("a report off the schema is refused whole, and GitHub hears nothing", async () => {
  const bad = [
    [{ cookie: "a=b" }, "field not allowed: cookie"],
    [{ headers: {} }, "field not allowed: headers"],
    [{ kind: "feature_request" }, `kind is one of ${report.KINDS.join(", ")}`],
    [{ url: "https://github.com/a/b?tab=1" }, "url is a scheme, host and path only"],
    [{ url: "https://me:pw@github.com/a" }, "url is a scheme, host and path only"],
    [{ tool: "unbrowse_vault" }, "tool is not an allowed value"],
    [{ route: { method: "GET", host: "x.com", path: "/a", inputs: [], write: false, steps: 1, body: "{}" } }, "route field not allowed: body"],
    [{ route: { method: "GET", host: "x.com", path: "/a?q=1", inputs: [], write: false, steps: 1 } }, "route.path is a path"],
    [{ route: { method: "GET", host: "x.com", path: "/a", inputs: ["q=rust"], write: false, steps: 1 } }, "route.inputs holds names"],
    [{ summary: "x".repeat(141) }, "summary is at most 140 characters"],
    [{ summary: "  " }, "summary says what went wrong"],
    [{ install_id: "nope" }, "install_id is 32 hex characters"],
    [{ last_error: { tool: "unbrowse_do", class: "site", error: "x", body: "y" } }, "last_error field not allowed: body"],
  ];
  for (const [over, why] of bad) {
    const { gh, send } = setup();
    const r = await send(wrongRepo(over));
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.equal((await r.json()).error, why);
    assert.equal(gh.calls.length, 0);
  }
  const { send } = setup();
  const missing = wrongRepo();
  delete missing.install_id;
  assert.equal((await send(missing)).status, 400);
  assert.equal((await send(" ".repeat(report.MAX_BODY_BYTES + 1))).status, 413);
  assert.equal((await send("{")).status, 400);
});

test("a node files at most its day's reports and new issues, and the relay opens at most its day's issues", async () => {
  // Distinct problems are distinct routes: free text never makes one.
  const on = (name) => ({ route: { method: "GET", host: "github.com", path: `/repos/${name}`, inputs: [], write: false, steps: 1 } });
  const letters = (i) => "abcdefghijklmnopqrstuvwxyz"[i % 26] + "abcdefghijklmnopqrstuvwxyz"[Math.floor(i / 26)];
  const { send, gh } = setup();
  // One node's reports of problems already filed: within its day's reports, past its own new issues.
  const { send: first } = setup();
  for (let i = 0; i < report.NEW_ISSUES_PER_SIGNER_PER_DAY; i++) assert.equal((await first(wrongRepo(on(letters(i))))).status, 201);
  assert.equal((await first(wrongRepo(on("onemore")))).status, 429, "one node can't spend the day's new issues");
  for (let i = 0; i < report.PER_SIGNER_PER_DAY; i++) {
    const r = await send(wrongRepo(on(letters(i % report.NEW_ISSUES_PER_SIGNER_PER_DAY))));
    assert.ok([200, 201].includes(r.status), String(r.status));
  }
  let r = await send(wrongRepo(on("toomany")));
  assert.equal(r.status, 429);
  r = await send(wrongRepo(on("toomany")), NOW + DAY);
  assert.equal(r.status, 201, "a new day, a new count");

  // Many nodes: the relay's own cap on new issues holds whoever signs.
  const relay = setup();
  const nodes = await Promise.all(Array.from({ length: Math.ceil(report.NEW_ISSUES_PER_DAY / report.NEW_ISSUES_PER_SIGNER_PER_DAY) + 1 }, reportKey));
  const by = (i) => nodes[Math.floor(i / report.NEW_ISSUES_PER_SIGNER_PER_DAY)];
  for (let i = 0; i < report.NEW_ISSUES_PER_DAY; i++) {
    assert.equal((await relay.send(wrongRepo(on(letters(i))), NOW, by(i))).status, 201);
  }
  const last = nodes[nodes.length - 1];
  r = await relay.send(wrongRepo(on("pastthecap")), NOW, last);
  assert.equal(r.status, 429);
  assert.equal(relay.gh.calls.length, report.NEW_ISSUES_PER_DAY);
  r = await relay.send(wrongRepo(on("pastthecap")), NOW + DAY, last);
  assert.equal(r.status, 201, "the problem is filed the next day");
  assert.ok(gh.calls.length > 0);
});

test("without its token, or with GitHub refusing, nothing is kept and the node tries later", async () => {
  let s = setup({ env: { GITHUB_TOKEN: undefined } });
  let r = await s.send(wrongRepo());
  assert.equal(r.status, 503);
  assert.equal(s.gh.calls.length, 0);

  s = setup({ github: { fails: true } });
  r = await s.send(wrongRepo());
  assert.equal(r.status, 502);
  assert.equal(s.db.rows("SELECT * FROM report_issues").length, 0, "the claim on the issue is let go");
  // GitHub back: the same report opens its issue.
  const again = await handle(await post(wrongRepo()), s.env, NOW, fakeGithub().fetcher);
  assert.equal(again.status, 201);

  s = setup({ db: { fails: true } });
  assert.equal((await s.send(wrongRepo())).status, 503);
});

test("only POST with JSON is answered", async () => {
  const { env, gh } = setup();
  assert.equal((await handle(new Request("https://telemetry.unbrowse.ai/v1/reports"), env, NOW, gh.fetcher)).status, 405);
  const text = new Request("https://telemetry.unbrowse.ai/v1/reports", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal((await handle(text, env, NOW, gh.fetcher)).status, 415);
});

test("the relay's lists are the shared schema's", () => {
  assert.deepEqual(report.FIELDS, shared.fields);
  assert.deepEqual(report.REQUIRED, shared.required);
  assert.deepEqual(report.KINDS, shared.kinds);
  assert.deepEqual(report.SOURCES, shared.sources);
  assert.deepEqual(report.TOOLS, shared.tools);
  assert.deepEqual(report.METHODS, shared.methods);
  assert.deepEqual(report.ROUTE_FIELDS, shared.route_fields);
  assert.deepEqual(report.LAST_ERROR_FIELDS, shared.last_error_fields);
  assert.deepEqual(report.MAX_CHARS, shared.max_chars);
  assert.equal(report.MAX_INPUTS, shared.max_inputs);
  assert.equal(report.MAX_STEPS, shared.max_steps);
  assert.equal(report.MAX_BODY_BYTES, shared.max_body_bytes);
  assert.equal(report.PER_INSTALL_PER_DAY, shared.per_install_per_day);
  assert.equal(report.NEW_ISSUES_PER_DAY, shared.new_issues_per_day);
  assert.equal(report.COMMENTS_PER_DAY, shared.comments_per_day);
});

test("the relay files nothing unsigned", async () => {
  const { env, gh, db } = setup();
  const refused = async (req) => {
    const r = await handle(req, env, NOW, gh.fetcher);
    assert.equal(r.status, 401);
    assert.match((await r.json()).error, /signed/);
  };
  // No signature at all, as anyone on the internet could post.
  await refused(await post(wrongRepo(), undefined, null));
  // Signed, then changed on the way: the body isn't what was signed.
  const signed = await post(wrongRepo());
  await refused(new Request(signed.url, { method: "POST", headers: signed.headers, body: JSON.stringify(wrongRepo({ summary: "something else entirely" })) }));
  // One key's signature under another key's name.
  const other = await reportKey();
  const headers = new Headers(signed.headers);
  headers.set("x-unbrowse-key", other.key);
  await refused(new Request(signed.url, { method: "POST", headers, body: JSON.stringify(wrongRepo()) }));
  // Junk in the headers.
  headers.set("x-unbrowse-key", "zz");
  await refused(new Request(signed.url, { method: "POST", headers, body: JSON.stringify(wrongRepo()) }));
  assert.equal(gh.calls.length, 0, "GitHub hears nothing");
  assert.equal(db.rows("SELECT * FROM report_limits").length, 0, "nothing is counted or kept");
  // While old nodes are still out, the operator may take unsigned reports, all under one shared limit.
  const open = setup({ env: { REPORTS_ACCEPT_UNSIGNED: "1" } });
  assert.equal((await open.send(wrongRepo(), NOW, null)).status, 201);
});

test("while unsigned reports are let in, each is logged loudly and they share limits far below one signer's", async () => {
  const warned = [];
  const was = console.warn;
  console.warn = (m) => warned.push(String(m));
  try {
    const { send } = setup({ env: { REPORTS_ACCEPT_UNSIGNED: "1" } });
    const kinds = ["wrong_data", "false_success", "failed", "slow", "confusing", "other"];
    const said = [];
    for (const [i, kind] of kinds.entries()) said.push((await send(wrongRepo({ kind, summary: `problem ${i}` }), NOW, null)).status);
    assert.equal(said[0], 201, "one new issue");
    assert.equal(said[1], 429, "a second new issue is past the unsigned cap");
    assert.equal(said[5], 429, "the sixth unsigned report of the day is past the shared cap");
    assert.ok(warned.length >= 5 && warned.every((w) => w.includes("REPORTS_ACCEPT_UNSIGNED") && w.includes("wrangler secret delete")), JSON.stringify(warned));
    // A signed report isn't held to them.
    const signed = (await send(wrongRepo({ summary: "signed one" }))).status;
    assert.ok(signed >= 200 && signed < 300, `a signed report is taken: ${signed}`);
  } finally {
    console.warn = was;
  }
});

test("the relay files only into its own repository, wherever a report points", async () => {
  const { gh, send } = setup();
  const r = await send(wrongRepo({ url: "https://api.github.com/repos/someone/else/issues", route: { method: "POST", host: "api.github.com", path: "/repos/someone/else/issues", inputs: [], write: true, steps: 1 } }));
  assert.equal(r.status, 201);
  assert.ok(gh.calls.every((c) => c.url.startsWith("https://api.github.com/repos/unbrowse-ai/unbrowse/")), JSON.stringify(gh.calls.map((c) => c.url)));
});
