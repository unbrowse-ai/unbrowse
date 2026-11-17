// A fake node's owner door, answering as app/src/api.rs does: POST /owner/{cmd}, GET /owner/events, GET /owner/frame.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UnbrowseOwner, UnbrowseError } from "../dist/index.js";
import { nodeAddress, nodePort, ownerToken } from "../dist/local.js";
import { proofAnswer } from "./proof-fixture.mjs";
import { signing } from "./signed-fixture.mjs";

// The node's key waits on the Keychain until a test says it is unlocked.
let keyLocked = true;
const TOKEN = "owner-token";
// The token the running node holds: a restart makes a fresh one (api.rs, `owner_token`).
let nodeToken = TOKEN;
const seen = [];
const streams = [];
let server;
let base;

let settings = { map_while_browsing: true, hold_routes: false, signed_in_calls: true, paused: false, api_port: 7788, storage_gb: 4, excluded: [], share_routes: "used", coin_dev_buy_bps: 100, coin_complete_others: false };
const ENTRY = `0x${"ab".repeat(32)}`;
// A CoinDone, as the node answers each coin write: no chain behind it.
const coinDone = (a) => ({ tx: "0xcoin", coin: "0xC", entry: a.entry, amount: a.unb ?? a.coins ?? null });
const COMMANDS = {
  node_info: () => ({ name: "lewis-mac", version: "0.1.0", api_port: 7788, dev: true }),
  settings: () => settings,
  save_settings: (a) => a.settings,
  activity: (a) => [{ at: 1, who: "claude", site: "hn.algolia.com", what: `limit ${a.limit ?? "none"}`, kind: "call", result: "passed", ms: 212, unb: null, tx: null, note: null }],
  agent_create: (a) => ({ agent: { index: 3, name: a.name, address: "0xabc", cap_usdc: a.cap_usdc, cap_unb: a.cap_usdc, expires: 9, created: 1, revoked: false, tx: null }, setup: "UNBROWSE_AGENT_TOKEN=…" }),
  vault_add: (a) => ({ site: a.site, account: a.account, kind: a.kind, counter: 0, created: 1 }),
  vault_reveal: () => "hunter2",
  vault_import: () => ({ added: 2, known: 1, skipped: [{ why: "no username", count: 1 }] }),
  vault_code: (a) => ({ site: a.site, account: a.account, kind: "stored", counter: 0, created: 1, code: true }),
  wallet_phrase: () => "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title",
  wallet_restore: () => ({ address: "0xNew", previous: "0xOld" }),
  browsers: () => ({ using: "/Applications/Chromium.app/Contents/MacOS/Chromium", chosen: null, found: [{ name: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium", downloaded: false }], downloading: false, download_error: null }),
  choose_browser: (a) => ({ using: a.path, chosen: a.path, found: [], downloading: false, download_error: null }),
  download_browser: () => ({ using: null, chosen: null, found: [], downloading: true, download_error: null }),
  hands: () => ({ browsers: [{ site: "linkedin.com", url: "https://www.linkedin.com/login", held: false, walk: "hands:linkedin.com" }], asks: [{ id: "ask-1", site: "linkedin.com", why: "sign in", agent: "claude", asked_at: 1, expires_at: 301 }], watching: null }),
  hands_watch: (a) => ({ site: a.site, url: "https://www.linkedin.com/login", walk: `hands:${a.site}`, width: 1280, height: 720, held: false }),
  hands_input: (a) => ({ site: a.site, url: "https://www.linkedin.com/login", walk: `hands:${a.site}`, width: 1280, height: 720, held: true }),
  hands_give_back: (a) => ({ site: a.site, answered: 1 }),
  hands_stop: () => ({}),
  claim_now: () => 2,
  deposit: () => "0xdeposit",
  request_withdraw: () => "0xask",
  withdraw: () => "0xwithdraw",
  collect_earnings: () => ["0xclaim1", "0xclaim2"],
  earnings: () => ({
    staking: { earned: 1.5, claimed: 1, to_claim: 0.5 },
    contributor: { earned: 0.4, claimed: 0, to_claim: 0.4 },
    routes_paid: 2.2,
    to_claim: 0.9,
  }),
  set_pricing: (a) => ({ auto: a.auto, floor: a.floor, ceiling: a.ceiling, epoch: 3, block: 120, lines: 0 }),
  passkeys: () => ({ on: true, never: [], passkeys: [{ id: "pk-1", site: "github.com", account: "me", created: 1, used: null, how: "auto" }] }),
  passkey_never: (a) => a.site,
  passkey_enrol: (a) => ({ site: a.site, until: 600_000, how: "add a passkey on the site's security page" }),
  money: () => ({ balance: "12.50", available_to_spend: "11.75", needed_to_start: "0.00", add_funds_url: "https://unbrowse.ai/fund/#node=0xabc&chain=5042002&min=0.00&nonce=n1", payments: "open", parts: { at_address: "0.75", kept_for_fees: "0.25", deposit: "11.75", account_deposit: null, signed: "0.00" }, agents: [{ index: 0, name: "Your agents", daily_limit: "5.00", spent_today: "0.03", pays_from: "node" }], earnings: { available: "1.10" } }),
  update_status: () => ({ running: "13.1.0", enabled: true, latest: "13.2.0", min_version: null, outdated: false, checking: false, ready: null, error: null }),
  identity: () => {
    if (keyLocked) throw [503, "Waiting for Keychain access: allow Unbrowse in the macOS dialog."];
    return { address: "0x1234567890AbcdEF1234567890aBcdef12345678", created: false };
  },
  wallet: () => {
    throw [400, "the chain isn't up"];
  },
  // Bounties, as the node answers them (a BountyDone, a BountyView): no chain behind them.
  bounty_post: () => ({ tx: "0xpost", id: 7 }),
  bounty_confirm: (a) => ({ tx: "0xconfirm", id: a.id }),
  bounty_settle: (a) => ({ tx: "0xsettle", id: a.id }),
  bounty_release: (a) => ({ tx: "0xrelease", id: a.id }),
  bounty_refund: (a) => ({ tx: "0xrefund", id: a.id }),
  bounty_show: (a) => bountyView(a.id),
  bounty_list: (a) => (a.mine ? [bountyView(7)] : [bountyView(8), bountyView(7)]),
  bounty_auto: (a) => ({ on: a.on ?? true }),
  // Route coins, as the node answers them (a CoinDone, Holdings).
  coin_holdings: () => ({
    wallet: "0xW",
    owed_as_contributor_usdc: 0.25,
    fetch_delay: 86400,
    coins: [
      {
        coin: "0xC", entry: ENTRY, state: "trading", held: 40, lots: [{ delay: 86400, earning: 60, pending: 0, unstaking: 0, ready_at: 0 }],
        owed_usdc: 0.12, parked_usdc: 0, checked: true, latest_passed: true, price: 0.5, value_unb: 50,
      },
    ],
  }),
  coin_launch: coinDone,
  coin_buy: coinDone,
  coin_sell: coinDone,
  coin_stake: coinDone,
  coin_unstake: coinDone,
  coin_withdraw: coinDone,
  coin_claim: coinDone,
  coin_fetch_delay: (a) => ({ delay: a.delay ?? 86400, tx: a.delay ? "0xdelay" : null }),
  coin_dev_buy: (a) => ({ bps: a.bps ?? 100 }),
  coin_rank: (a) => Object.fromEntries(a.entries.map((e) => [e, { rank: 12.5, staked: 60, collateral: 30, market_cap: 5.2, price: 0.5 }])),
};

function bountyView(id) {
  return {
    id, poster: "0xP", mine: id === 7, site: "shop.example", site_name: "Shop", amount: 2000, limit_price: 0.5, posted_at: 1_700_000_000,
    deadline: 1_702_592_000, confirmed: false, settled: false, reserved: 0, use_usdc: 0, refundable: 0, state: "open",
  };
}

before(async () => {
  server = http.createServer(signing((req, res) => {
    const url = new URL(req.url, "http://x");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const proof = proofAnswer(req.url, server.address().port, { owner: nodeToken });
      if (proof) return reply(res, 200, proof);
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const auth = req.headers.authorization;
      // A request without a token stands for one a proxy in front of the node would have signed.
      if (auth !== undefined && auth !== `Bearer ${nodeToken}`) return reply(res, 401, { error: "the owner's token only" });
      if (req.method === "GET" && url.pathname === "/owner/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders(); // as axum does: the stream is open before the first event
        streams.push(res);
        return;
      }
      if (req.method === "GET" && url.pathname === "/owner/frame") {
        if (url.searchParams.get("walk") === "none") return reply(res, 404, { error: "no picture of that walk" });
        res.writeHead(200, { "content-type": "image/jpeg" });
        return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      }
      const cmd = url.pathname.replace(/^\/owner\//, "");
      const run = COMMANDS[cmd];
      if (!run) return reply(res, 404, { error: `no command ${cmd}` });
      try {
        reply(res, 200, run(body ?? {}));
      } catch ([status, error]) {
        reply(res, status, { error });
      }
    });
  }, () => [nodeToken]));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  streams.forEach((s) => s.destroy());
  server.closeAllConnections();
  server.close();
});

function reply(res, status, json) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(json));
}

const owner = (token = TOKEN) => new UnbrowseOwner({ token, baseUrl: base });

test("the node's address reads from its identity, with nothing of the chain's wallet", async () => {
  keyLocked = false;
  try {
    assert.equal(await owner().address(), "0x1234567890AbcdEF1234567890aBcdef12345678");
    assert.equal(last().url, "/owner/identity");
  } finally {
    keyLocked = true;
  }
});
const last = () => seen[seen.length - 1];
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("a command posts its arguments to /owner/{cmd} with the owner's token", async () => {
  const info = await owner().nodeInfo();
  assert.equal(info.name, "lewis-mac");
  assert.equal(last().method, "POST");
  assert.equal(last().url, "/owner/node_info");
  assert.equal(last().headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(last().body, {});
  assert.equal(await owner().command("claim_now"), 2);
});

test("named methods send the node's own argument names", async () => {
  const o = owner();
  await o.createAgent({ name: "claude", capUsdc: 5, days: 30 });
  assert.deepEqual(last().body, { name: "claude", cap_usdc: 5, cap_unb: 5, days: 30 }, "the cap in USDC, and under its old name for a node from before the rename");
  // An older caller's capUnb is the same cap.
  await o.createAgent({ name: "claude", capUnb: 5, days: 30 });
  assert.deepEqual(last().body, { name: "claude", cap_usdc: 5, cap_unb: 5, days: 30 });
  // An older caller's approvalUsd still compiles and is dropped: no call waits for the owner.
  await o.createAgent({ name: "claude", capUnb: 5, days: 30, approvalUsd: 20 });
  assert.deepEqual(last().body, { name: "claude", cap_usdc: 5, cap_unb: 5, days: 30 });
  await o.vaultAdd({ site: "example.com", account: "me", kind: "derived" });
  assert.deepEqual(last().body, { site: "example.com", account: "me", kind: "derived", password: null });
  assert.equal(await o.vaultReveal("example.com", "me"), "hunter2");
  const imported = await o.vaultImport("url,username,password\nhttps://example.com,me,pw\n");
  assert.deepEqual(last().body, { csv: "url,username,password\nhttps://example.com,me,pw\n" });
  assert.equal(imported.added, 2);
  const coded = await o.vaultCode("example.com", "me", "otpauth://totp/x?secret=GEZDGNBV");
  assert.deepEqual(last().body, { site: "example.com", account: "me", key: "otpauth://totp/x?secret=GEZDGNBV" });
  assert.equal(coded.code, true);
  assert.equal((await o.walletPhrase()).split(" ").length, 24);
  assert.deepEqual(await o.walletRestore("legal winner …"), { address: "0xNew", previous: "0xOld" });
  assert.deepEqual(last().body, { words: "legal winner …" });
  assert.equal((await o.browsers()).found[0].name, "Chromium");
  await o.chooseBrowser(null);
  assert.deepEqual(last().body, { path: null });
  assert.equal((await o.downloadBrowser()).downloading, true);
  const [a] = await o.activity();
  assert.equal(a.what, "limit none");
  await o.activity(50);
  assert.deepEqual(last().body, { limit: 50 });
});

test("money moves by the node's current commands: the deposit in USDC, earnings claimed whole", async () => {
  const o = owner();
  const sent = [];
  const note = () => sent.push([last().url, last().body]);
  await o.deposit(2.5), note();
  await o.requestWithdraw(1), note();
  await o.withdraw(), note();
  assert.deepEqual(await o.collectEarnings(), ["0xclaim1", "0xclaim2"]);
  note();
  assert.deepEqual(sent, [
    ["/owner/deposit", { amount: 2.5 }],
    ["/owner/request_withdraw", { amount: 1 }],
    ["/owner/withdraw", {}],
    ["/owner/collect_earnings", {}],
  ]);
  const e = await o.earnings();
  assert.deepEqual([e.staking.to_claim, e.contributor.to_claim, e.to_claim], [0.5, 0.4, 0.9]);
  const p = await o.setPricing({ fee: 0.02, auto: true, floor: 0.001, ceiling: 0.5 });
  assert.deepEqual(last().body, { fee: 0.02, auto: true, floor: 0.001, ceiling: 0.5 });
  assert.equal(p.auto, true);
  assert.equal(typeof o.pledge, "undefined", "the pledge commands are gone, as they are from the node");
  for (const gone of ["postBond", "stakeRoute", "unbond", "withdrawVested", "earnFromUse", "setAutoStake", "fraudCommit"]) {
    assert.equal(typeof o[gone], "undefined", `${gone} is gone: route coins take the bond's place`);
  }
});

test("money reads one balance in dollars, as decimal strings, with each agent's daily limit", async () => {
  const o = owner();
  const m = await o.money();
  assert.equal(last().url, "/owner/money");
  assert.equal(m.balance, "12.50");
  assert.equal(m.needed_to_start, "0.00");
  assert.deepEqual(m.agents[0], { index: 0, name: "Your agents", daily_limit: "5.00", spent_today: "0.03", pays_from: "node" });
  assert.deepEqual(m.earnings, { available: "1.10" });
  assert.match(m.add_funds_url, /\/fund\/#node=0xabc&chain=5042002&min=0\.00&nonce=/);
});

test("passkeys and updates read as the node keeps them", async () => {
  const o = owner();
  assert.equal((await o.passkeys()).passkeys[0].how, "auto");
  assert.equal(await o.passkeyNever("github.com"), "github.com");
  assert.deepEqual(last().body, { site: "github.com", never: true });
  await o.passkeyEnrol("github.com", { minutes: 5 });
  assert.deepEqual(last().body, { site: "github.com", cdp: null, minutes: 5 });
  assert.equal((await o.updateStatus()).latest, "13.2.0");
});

// Every command the client sends by name is one the node's owner door answers: the client follows the node's commands
// (`OWNER_COMMANDS` in unbrowse-node/app/src/commands.rs), read from the node's agent-api.json when this package sits in
// its repository.
test("every command the client sends is one the node answers", { skip: !existsSync(nodeApi()) && "the node's source isn't beside this package" }, () => {
  const api = JSON.parse(readFileSync(nodeApi(), "utf8"));
  const answered = new Set(api.owner.map((c) => c.command));
  assert.ok(answered.has("list_route") && answered.has("coin_stake"), "the node's commands were read");
  // The client's methods are generated from the node's list (generated.js) with a few friendlier forms (owner.js).
  const client = ["owner.js", "generated.js"].map((f) => readFileSync(new URL(`../dist/${f}`, import.meta.url), "utf8")).join("\n");
  const sent = [...client.matchAll(/this\.command\("([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(sent.length > 40);
  assert.deepEqual(sent.filter((c) => !answered.has(c)), [], "commands the node doesn't answer");
});

// The other way round: every command the node answers has the method its entry names, and that method reaches it.
test("every command the node answers has its method", { skip: !existsSync(nodeApi()) && "the node's source isn't beside this package" }, async () => {
  const api = JSON.parse(readFileSync(nodeApi(), "utf8"));
  const o = owner();
  for (const c of api.owner) {
    assert.equal(typeof o[c.sdk.ts], "function", `UnbrowseOwner has no ${c.sdk.ts}() for ${c.command}`);
  }
  // A command with no arguments goes out by its own name.
  const before = seen.length;
  for (const c of api.owner.filter((c) => !c.input.required?.length && !c.input.allOf)) await o[c.sdk.ts]().catch(() => {});
  const reached = new Set(seen.slice(before).map((r) => r.url.replace(/^\/owner\//, "")));
  assert.deepEqual(api.owner.filter((c) => !c.input.required?.length && !c.input.allOf && !reached.has(c.command)).map((c) => c.command), []);
});

function nodeApi() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "unbrowse-node", "agent-api.json");
}

test("the owner takes over a site's page, drives it and gives it back", async () => {
  const o = owner();
  const h = await o.hands();
  assert.equal(h.asks[0].why, "sign in");
  const page = await o.handsWatch("linkedin.com");
  assert.equal(page.walk, "hands:linkedin.com");
  const held = await o.handsInput("linkedin.com", { kind: "click", x: 0.5, y: 0.4 });
  assert.deepEqual(last().body, { site: "linkedin.com", kind: "click", x: 0.5, y: 0.4 });
  assert.equal(held.held, true);
  await o.handsInput("linkedin.com", { kind: "key", key: "Enter" });
  assert.deepEqual(last().body, { site: "linkedin.com", kind: "key", key: "Enter" });
  assert.deepEqual(await o.handsGiveBack("linkedin.com"), { site: "linkedin.com", answered: 1 });
  assert.deepEqual(last().body, { site: "linkedin.com", done: true });
  await o.handsStop();
  assert.equal(last().url, "/owner/hands_stop");
});

test("settings go back as they came", async () => {
  const o = owner();
  const s = await o.settings();
  const saved = await o.saveSettings({ ...s, paused: true });
  assert.deepEqual(last().body, { settings: { ...s, paused: true } });
  assert.equal(saved.paused, true);
});

test("the per-fetch maximum is set by sending the settings back with it", async () => {
  const o = owner();
  const s = await o.settings();
  const saved = await o.setMaxFetch(0.2);
  assert.deepEqual(last().body, { settings: { ...s, max_fetch_usdc: 0.2 } });
  assert.equal(saved.max_fetch_usdc, 0.2);
});

test("without a token nothing is signed, for a proxy that signs it", async () => {
  await new UnbrowseOwner({ baseUrl: base }).nodeInfo();
  assert.equal(last().headers.authorization, undefined);
});

test("refusals throw with the node's reason", async () => {
  await assert.rejects(owner().identity(), (e) => e instanceof UnbrowseError && e.code === "unavailable" && /Keychain/.test(e.message));
  await assert.rejects(owner().wallet(), (e) => e.code === "bad_request" && e.message === "the chain isn't up");
  await assert.rejects(owner().command("nope"), (e) => e.code === "not_found" && e.message === "no command nope");
  await assert.rejects(owner("wrong").nodeInfo(), (e) => e.code === "unauthorized");
});

test("a walk's picture comes back as a JPEG", async () => {
  const jpeg = await owner().frame("learn-1");
  assert.equal(last().url, "/owner/frame?walk=learn-1");
  assert.deepEqual([...new Uint8Array(await jpeg.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);
  await assert.rejects(owner().frame("none"), (e) => e.code === "not_found");
});

test("events arrive by name, whole, however the stream is cut", async () => {
  const stream = owner().events();
  const got = [];
  let opened = 0;
  stream.on("open", () => opened++);
  stream.on("activity", (p) => got.push(["activity", p]));
  stream.on("call", (p) => got.push(["call", p]));
  stream.on("eye", (p) => got.push(["eye", p]));
  await until(() => opened === 1);
  const s = streams[streams.length - 1];
  assert.equal(seen.find((r) => r.url === "/owner/events").headers.accept, "text/event-stream");
  s.write(": keep-alive\n\n");
  s.write("event: activity\ndata: null\n\n");
  s.write('event: call\ndata: {"phase":"start","rou');
  s.write('te":"hn-search"}\n\nevent: eye\r\ndata: {"kind":"failed","walk":"w1","error":"x"}\r\n\r\n');
  s.write("event: frame\ndata: {}\n\n"); // nobody listens: dropped
  await until(() => got.length === 3);
  assert.deepEqual(got, [
    ["activity", null],
    ["call", { phase: "start", route: "hn-search" }],
    ["eye", { kind: "failed", walk: "w1", error: "x" }],
  ]);
  stream.close();
});

test("an event the node didn't sign is never passed on, and the stream drops", async () => {
  const errors = [];
  const stream = owner().events({ onError: (e) => errors.push(e) });
  const got = [];
  let opened = 0;
  stream.on("open", () => opened++);
  stream.on("activity", (p) => got.push(p));
  await until(() => opened === 1);
  const s = streams[streams.length - 1];
  s.write("event: activity\ndata: 1\n\n");
  await until(() => got.length === 1);
  // A process between the node and the window adds one of its own.
  s.writeUnsigned("event: activity\ndata: 2\n\n");
  await until(() => errors.length > 0);
  assert.deepEqual(got, [1], "the added event never reached a listener");
  assert.match(errors[0].message, /isn't the node's/);
  stream.close();
});

test("a stream that drops comes back and says so, until it is closed", async () => {
  const errors = [];
  const stream = owner().events({ onError: (e) => errors.push(e) });
  let opened = 0;
  const off = stream.on("open", () => opened++);
  await until(() => opened === 1);
  const before = streams.length;
  streams[streams.length - 1].end(); // the node restarts
  await until(() => opened === 2 && streams.length === before + 1);
  stream.close();
  off();
  const after = streams.length;
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(streams.length, after, "a closed stream doesn't reconnect");
  assert.equal(errors.length, 0, "a stream that ended cleanly isn't an error");
});

test("a stream that reads its token follows the node's fresh token through a restart", async () => {
  let held = TOKEN; // what owner.token holds
  const errors = [];
  const stream = new UnbrowseOwner({ token: () => held, baseUrl: base }).events({ onError: (e) => errors.push(e) });
  let opened = 0;
  stream.on("open", () => opened++);
  try {
    await until(() => opened === 1);
    nodeToken = "the-next-start's-token";
    streams[streams.length - 1].end(); // the node restarts...
    await until(() => errors.length >= 1); // ...and for a moment the file still holds the old token
    assert.equal(errors[0].code, "unauthorized");
    assert.equal(stream.closed, false, "the file can change, so the stream keeps trying");
    held = nodeToken;
    await until(() => opened === 2);
    assert.equal(last().headers.authorization, `Bearer ${nodeToken}`);
  } finally {
    stream.close();
    nodeToken = TOKEN;
  }
});

test("a command reads a token it's given the way to read, each time", async () => {
  let held = TOKEN;
  const o = new UnbrowseOwner({ token: () => held, baseUrl: base });
  await o.command("settings");
  assert.equal(last().headers.authorization, `Bearer ${TOKEN}`);
  nodeToken = held = "the-next-start's-token";
  try {
    await o.command("settings");
    assert.equal(last().headers.authorization, `Bearer ${nodeToken}`);
  } finally {
    nodeToken = TOKEN;
  }
});

test("a stream whose token can't change stops at the refusal, and says why", async () => {
  const errors = [];
  const stream = owner("wrong").events({ onError: (e) => errors.push(e) });
  await until(() => stream.closed);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "unauthorized");
  assert.match(errors[0].message, /ownerToken/);
  const tries = seen.filter((r) => r.url === "/owner/events" && r.headers.authorization === "Bearer wrong").length;
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(seen.filter((r) => r.url === "/owner/events" && r.headers.authorization === "Bearer wrong").length, tries, "it never asks again");
});

test("a refusal with no token of ours is a proxy's to mend: the stream keeps trying", async () => {
  let refused = 0;
  const proxied = (url, init) => (refused++ < 1 ? Promise.resolve(new Response(JSON.stringify({ error: "the proxy has no token yet" }), { status: 401 })) : fetch(url, init));
  const errors = [];
  const stream = new UnbrowseOwner({ baseUrl: base, fetch: proxied }).events({ onError: (e) => errors.push(e) });
  let opened = 0;
  stream.on("open", () => opened++);
  await until(() => opened === 1);
  assert.equal(errors[0].code, "unauthorized");
  stream.close();
});

test("one listener's failure leaves the others listening", async () => {
  const stream = owner().events();
  const got = [];
  stream.on("activity", () => {
    throw new Error("a broken screen");
  });
  stream.on("activity", () => got.push(1));
  let opened = false;
  stream.on("open", () => (opened = true));
  const swallowed = [];
  const logged = console.error;
  console.error = (e) => swallowed.push(e);
  try {
    await until(() => opened);
    streams[streams.length - 1].write("event: activity\ndata: null\n\nevent: activity\ndata: null\n\n");
    await until(() => got.length === 2 && swallowed.length === 2);
  } finally {
    console.error = logged;
    stream.close();
  }
  assert.equal(swallowed[0].message, "a broken screen");
});

test("local reads the token and port where the node keeps them", () => {
  const home = mkdtempSync(join(tmpdir(), "unbrowse-home-"));
  assert.equal(ownerToken(home), undefined, "a node that never ran here has no token");
  assert.equal(nodePort(home), 7788);
  writeFileSync(join(home, "owner.token"), "abc123\n");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ api_port: 7790 }));
  assert.equal(ownerToken(home), "abc123");
  assert.equal(nodePort(home), 7790);
  assert.equal(nodeAddress(home), process.env.UNBROWSE_NODE || "http://127.0.0.1:7790");
});

test("each bounty method posts its command with the arguments the node takes", async () => {
  const o = owner();
  assert.deepEqual(await o.bountyPost("shop.example", 2000), { tx: "0xpost", id: 7 });
  assert.deepEqual([last().url, last().body], ["/owner/bounty_post", { site: "shop.example", amount: 2000 }], "a limit or days left out isn't sent");
  await o.bountyPost("shop.example", 1500.5, 0.5, 7);
  assert.deepEqual(last().body, { site: "shop.example", amount: 1500.5, limit: 0.5, days: 7 }, "any amount goes: the node is the judge of it");
  assert.equal((await o.bountyConfirm(7, ENTRY)).tx, "0xconfirm");
  assert.deepEqual([last().url, last().body], ["/owner/bounty_confirm", { id: 7, entry: ENTRY }]);
  await o.bountySettle(7);
  assert.deepEqual([last().url, last().body], ["/owner/bounty_settle", { id: 7 }]);
  await o.bountyRelease(7, ENTRY);
  assert.deepEqual([last().url, last().body], ["/owner/bounty_release", { id: 7, entry: ENTRY }]);
  assert.deepEqual(await o.bountyRefund(7), { tx: "0xrefund", id: 7 });
  assert.deepEqual([last().url, last().body], ["/owner/bounty_refund", { id: 7 }]);
  const one = await o.bountyShow(7);
  assert.deepEqual([one.site, one.amount, one.limit_price, one.state, one.refundable], ["shop.example", 2000, 0.5, "open", 0]);
  assert.deepEqual((await o.bountyList()).map((d) => d.id), [8, 7]);
  assert.deepEqual((await o.bountyList(true)).map((d) => d.id), [7]);
  assert.deepEqual(last().body, { mine: true });
  assert.equal((await o.bountyAuto(false)).on, false);
  assert.deepEqual([last().url, last().body], ["/owner/bounty_auto", { on: false }]);
  assert.equal((await o.bountyAuto()).on, true);
});

test("each coin method posts its command with the arguments the node takes", async () => {
  const o = owner();
  const held = await o.coinHoldings();
  assert.deepEqual([held.fetch_delay, held.coins[0].entry, held.coins[0].lots[0].earning], [86400, ENTRY, 60]);
  assert.equal((await o.coinLaunch(ENTRY, 500)).coin, "0xC");
  assert.deepEqual([last().url, last().body], ["/owner/coin_launch", { entry: ENTRY, unb: 500 }]);
  await o.coinBuy(ENTRY, 100);
  assert.deepEqual([last().url, last().body], ["/owner/coin_buy", { entry: ENTRY, unb: 100 }]);
  await o.coinSell(ENTRY, 40);
  assert.deepEqual([last().url, last().body], ["/owner/coin_sell", { entry: ENTRY, coins: 40 }]);
  await o.coinStake(ENTRY, 60);
  assert.deepEqual([last().url, last().body], ["/owner/coin_stake", { entry: ENTRY, coins: 60 }], "no delay sent: the node's 24 hours");
  await o.coinStake(ENTRY, 60, 604800);
  assert.deepEqual(last().body, { entry: ENTRY, coins: 60, delay: 604800 });
  await o.coinUnstake(ENTRY, 86400, 10);
  assert.deepEqual([last().url, last().body], ["/owner/coin_unstake", { entry: ENTRY, delay: 86400, coins: 10 }]);
  await o.coinWithdraw(ENTRY, 86400);
  assert.deepEqual([last().url, last().body], ["/owner/coin_withdraw", { entry: ENTRY, delay: 86400 }]);
  assert.equal((await o.coinClaim(ENTRY)).tx, "0xcoin");
  assert.deepEqual([last().url, last().body], ["/owner/coin_claim", { entry: ENTRY }]);
  assert.deepEqual(await o.coinFetchDelay(), { delay: 86400, tx: null });
  assert.deepEqual(last().body, {}, "null only reads it");
  assert.equal((await o.coinFetchDelay(3600)).tx, "0xdelay");
  assert.deepEqual(last().body, { delay: 3600 });
  assert.deepEqual(await o.coinDevBuy(), { bps: 100 }, "on at 1% by default");
  assert.deepEqual(last().body, {});
  await o.coinDevBuy(0);
  assert.deepEqual(last().body, { bps: 0 }, "0 turns it off, and is sent");
  assert.equal((await o.coinRank([ENTRY]))[ENTRY].rank, 12.5);
  assert.deepEqual([last().url, last().body], ["/owner/coin_rank", { entries: [ENTRY] }]);
});

test("the owner's token goes to no listener that cannot prove the node holds it", async () => {
  const heard = [];
  const fake = http.createServer((req, res) => {
    heard.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    // Says what the node says to a key it doesn't hold, or proves an agent's token instead of the owner's.
    res.end(JSON.stringify(req.url.startsWith("/v1/node/proof") ? { agents: [] } : { name: "impostor" }));
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const owner = new UnbrowseOwner({ token: TOKEN, baseUrl: `http://127.0.0.1:${fake.address().port}` });
  await assert.rejects(owner.command("node_info"), (e) => e.status === 401 && /token wasn't sent/.test(e.message));
  assert.ok(heard.length > 0 && heard.every((h) => h === undefined), JSON.stringify(heard));
  fake.close();
});

test("an owner client printed or serialized shows no token", async () => {
  const { inspect } = await import("node:util");
  const o = new UnbrowseOwner({ token: TOKEN, baseUrl: base });
  assert.ok(!inspect(o, { depth: 5 }).includes(TOKEN));
  assert.ok(!JSON.stringify(o).includes(TOKEN));
});
