import { Browser, type BrowserOptions } from "./browser.js";
import { CALL_WAIT_MS, primitiveRequest, type AgentPrimitives, type PrimitiveArgs, type PrimitiveResult } from "./generated.js";
import type * as W from "./generated.js";
import { DEFAULT_NODE, errorFor, env, keepOutOfLogs, proveNode, send, trimBase, type Line } from "./http.js";
import type { StartOptions } from "./start.js";
import type { LinkPreview, BrowseReply, CallOptions, CallResult, Capabilities, Card, Cut, DoOptions, DoPagesOptions, DoResult, JudgeResult, Judgment, Json, PageAsk, PagesResult, LearnedRoute, Login, NetworkOffers, NetworkSkipped, PaymentRefused, Report, ReportResult, Reputation, Route, RouteFailure, Truncated, Whoami } from "./types.js";

/** `do` may walk a page, and a call may heal by walking it again: both can take minutes. */

export type UnbrowseNodeOptions = {
  /** The agent token from the setup the Unbrowse app shows when it makes the key. Defaults to `UNBROWSE_AGENT_TOKEN`. */
  token?: string;
  /** The node's address. Defaults to `UNBROWSE_NODE`, then http://127.0.0.1:7788. */
  baseUrl?: string;
  /** Per-request timeout. Defaults to 330 s. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /**
   * The browsing session this client's pages belong to: each session has its own tab in a site's browser on the node,
   * so agents browsing the same site at once each read and drive their own page, even on one key. Defaults to one
   * drawn fresh for this client; pass the same name to pick up a page another client of yours opened.
   */
  session?: string;
  /**
   * Node.js only: start the node on this machine on the first request, when none answers (or no token is given), as
   * `Unbrowse.start()` does with these options; `close()` stops it again, and the next request starts it again. Off
   * by default.
   */
  autoStart?: boolean | StartOptions;
};

/** The node process a client started (`Unbrowse.start`), which `close()` stops. @internal */
export type Started = { stop(): Promise<void>; exited(): boolean };

// Loaded only when a node is started: it is Node.js's alone, and a page built on this client never loads it.
const START = "./start.js";
async function starter(): Promise<typeof import("./start.js")> {
  return import(/* @vite-ignore */ START);
}

// The converters below read the node's wire records (generated.ts, from agent-api.json) into this package's camel
// case. They take the wire types, so a field the node renames or drops fails to compile here rather than reading as
// undefined; the fallbacks are for a node older than the manifest.

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function toReputation(r: W.Reputation | undefined): Reputation | undefined {
  if (!r) return undefined;
  return { default: r.default === true, unverified: r.unverified !== false, countedUses: Number(r.counted_uses ?? 0), passRate: Number(r.pass_rate ?? 0), unavailable: r.unavailable === true, version: Number(r.version ?? 0) };
}

function toRoute(r: W.Route): Route {
  if ("remote" in r) {
    // Another node's site and goal are its lister's words, unchecked: the node keeps them under `listed_as`, never
    // under the keys its own routes are described by, and so does this.
    return {
      id: String(r.id),
      site: "",
      what: "",
      remote: true,
      ...(r.listed_as && { listedAs: { site: r.listed_as.site ?? "", what: r.listed_as.what ?? "" } }),
      contributor: r.contributor,
      fee: r.fee,
      ...(typeof r.over_max === "string" && { overMax: r.over_max }),
      ...(r.link && { link: r.link }),
      ...(r.reputation && { reputation: toReputation(r.reputation) }),
    };
  }
  return {
    id: String(r.id),
    site: r.site ?? "",
    what: r.what ?? "",
    remote: false,
    ...(r.method !== undefined && { method: r.method }),
    ...(r.path !== undefined && { path: r.path }),
    ...(r.write !== undefined && { write: r.write }),
    ...(r.listed !== undefined && { listed: r.listed }),
    ...(r.yours !== undefined && { yours: r.yours }),
    ...(Array.isArray(r.inputs) && { inputs: r.inputs }),
  };
}

function toSkipped(s: W.NetworkSkipped | undefined): NetworkSkipped | null {
  if (!s || !Array.isArray(s.entries)) return null;
  return { entries: s.entries.map((e) => ({ entryId: String(e.entry_id), feeUsdc: Number(e.fee_usdc) })), maxFetchUsdc: Number(s.max_fetch_usdc), why: str(s.why) ?? "" };
}

function toOffers(o: W.NetworkOffers | undefined): NetworkOffers | null {
  if (!o || !Array.isArray(o.entries)) return null;
  return { entries: o.entries.map((e) => ({ entryId: String(e.entry_id), what: str(e.what) ?? "", feeUsdc: Number(e.fee_usdc) })), next: str(o.next) ?? "" };
}

function toRefused(p: W.PaymentRefused | undefined): PaymentRefused | null {
  if (!p || typeof p !== "object") return null;
  return { entryId: String(p.entry_id ?? ""), error: str(p.error) ?? "", why: str(p.why) ?? "" };
}

function toTruncated(t: W.Truncated | null | undefined): Truncated | null {
  if (!t || typeof t !== "object") return null;
  const cuts: Cut[] = Array.isArray(t.cuts)
    ? t.cuts.map((c: W.Cut) => ({ at: String(c.at ?? ""), kept: Number(c.kept ?? 0), total: Number(c.total ?? 0), unit: c.unit === "chars" ? "chars" : "items" }))
    : [];
  return { keptBytes: Number(t.kept_bytes ?? 0), totalBytes: Number(t.total_bytes ?? 0), cuts, whole: str(t.whole), note: str(t.note) ?? "" };
}

function toFailure(f: W.RouteFailure | undefined): RouteFailure | null {
  if (!f) return null;
  // A network entry that failed is named by its entry; the public shape has one id for either.
  return { routeId: String("route_id" in f ? f.route_id : f.entry_id), error: str(f.error) };
}

function toCall<T>(r: W.CallResult): CallResult<T> {
  // A node from before the field was named for its currency sends only `paid_unb`; the amount is USDC either way.
  const paid = typeof r.paid_usdc === "number" ? r.paid_usdc : typeof r.paid_unb === "number" ? r.paid_unb : null;
  return {
    ok: r.ok === true,
    ms: r.ms ?? 0,
    data: (r.data ?? null) as T | null,
    truncated: toTruncated(r.truncated),
    error: str(r.error),
    paidUsdc: paid,
    paidUnb: paid,
    possibleCommit: r.possible_commit === true,
    retry: r.retry ?? null,
    // Every call runs on this node: a network route's body is fetched and run here (`network.ran_on` says so), so
    // the node sends no `remote` on a call.
    remote: false,
    fields: r.fields
      ? { returned: r.fields.returned ?? [], more: (r.fields.more ?? []).map((f) => ({ path: f.path, kind: f.kind, ...(f.example !== undefined && { example: f.example }) })), moreTotal: r.fields.more_total ?? 0, whole: r.fields.whole === true }
      : null,
    ...(r.bounties && { bounties: r.bounties }),
  };
}

const inputStrings = (inputs: Record<string, string | number | boolean>) => Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v)]));

/** The browse command a reply's `next` names (`{tool: "unbrowse_browse", args: {do: [...]}}`); a node from before `next`
 * was a call sent the command bare. */
function browseCommand(next: unknown): string[] | null {
  const call = next as { tool?: unknown; args?: { do?: unknown } } | null | undefined;
  const command = Array.isArray(next) ? next : call?.tool === "unbrowse_browse" ? call.args?.do : null;
  const words = Array.isArray(command) ? command.filter((x: unknown): x is string => typeof x === "string") : [];
  return words.length ? words : null;
}

function toLearned(r: W.LearnedRoute): LearnedRoute {
  return { routeId: r.route_id, what: r.what ?? "", inputs: r.inputs ?? [], write: r.write === true };
}

/**
 * The Unbrowse node on this machine, as an agent sees it. Say what you want with `do`: the node calls the route that
 * does it, or learns one from the page and calls that. When the page needs hands, drive it with `browser()`; the
 * node learns from every step.
 */
export class UnbrowseNode {
  baseUrl: string;
  /** The browsing session this client's pages belong to (`session` in the options). */
  readonly session: string;
  private line: Line;
  private started: Started | null = null;
  private autoStart: StartOptions | null;
  private starting: Promise<void> | null = null;
  /** The node `autoStart` found or started, as far as this client has seen, is still there. */
  private brought = false;
  private caps: Promise<Capabilities> | null = null;

  constructor(opts: UnbrowseNodeOptions = {}) {
    this.baseUrl = trimBase(opts.baseUrl ?? env("UNBROWSE_NODE") ?? DEFAULT_NODE);
    this.session = opts.session ?? globalThis.crypto.randomUUID();
    this.line = {
      baseUrl: this.baseUrl,
      token: opts.token ?? env("UNBROWSE_AGENT_TOKEN"),
      timeoutMs: opts.timeoutMs ?? CALL_WAIT_MS,
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
    };
    // The address goes to the start only when it was named: else the start finds it from the home and port it's given.
    const { autoStart, baseUrl, ...rest } = opts;
    const named = baseUrl ?? env("UNBROWSE_NODE");
    this.autoStart = autoStart ? { ...rest, ...(named && { baseUrl: named }), ...(typeof autoStart === "object" ? autoStart : {}) } : null;
    keepOutOfLogs(this, "line", "autoStart");
  }

  /**
   * Node.js only. The node on this machine, started when none is running: the `unbrowse-node` program the package
   * brought (or `UNBROWSE_BIN`'s, or `program`), with no window, waited for until it answers, and an agent token read
   * from it when none is given. No browser is needed: the node serves search, calls and whoami without one. `close()`
   * stops a node this started and leaves one that was running already. Without a node program, it says how to get one.
   * A node that goes away later is brought back as `autoStart` does.
   */
  static async start(opts: StartOptions = {}): Promise<UnbrowseNode> {
    return (await starter()).start(opts);
  }

  /** @internal Takes over the node `start` found or started, and how to bring one back when it goes. */
  adopt(baseUrl: string, token: string | undefined, started: Started | null, bring: StartOptions | null = this.autoStart) {
    this.baseUrl = trimBase(baseUrl);
    this.line = { ...this.line, baseUrl: this.baseUrl, token: token ?? this.line.token };
    this.started = started;
    this.autoStart = bring;
    this.brought = true;
    this.caps = null;
  }

  /**
   * Stops the node this client started (`start`, `autoStart`); a node that was running already is left running. A
   * start still running finishes first, so its node is stopped too. A later request starts the node again, as the
   * first one did.
   */
  async close(): Promise<void> {
    await this.starting?.catch(() => {});
    const s = this.started;
    this.started = null;
    this.brought = false;
    if (s) await s.stop();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Finds the node, when `autoStart` says to: the first time a request needs it, and again once it has gone. A node
   * this client started is known gone by its process, so the request waits for the next one. One started elsewhere
   * shows only as a request that couldn't reach it (`request`), which is answered as it failed: it may have been a
   * write, and the node that takes the next request is a new one.
   */
  private async ensureStarted(): Promise<void> {
    if (!this.autoStart || (this.brought && !this.started?.exited())) return;
    this.starting ??= (async () => {
      // Its process has gone; this takes it off the list of what ends with the script.
      await this.started?.stop();
      this.started = null;
      // A token given in the options goes with it; one in the environment is for bring to weigh (it may be another node's).
      const opts: StartOptions = { ...this.autoStart, fetch: this.line.fetch };
      const found = await (await starter()).bring(opts);
      this.adopt(found.baseUrl, found.token, found.started);
    })().finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  /** @internal */
  async request(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<any> {
    await this.ensureStarted();
    if (!this.line.token) {
      throw errorFor(
        "no agent token: pass { token } or set UNBROWSE_AGENT_TOKEN (`unbrowse agent token` prints one; `unbrowse agent new <name>` makes a key of the agent's own)",
        401,
        "unauthorized",
      );
    }
    try {
      return await send(this.line, method, path, { body, signal, timeoutMs });
    } catch (e) {
      if ((e as { code?: unknown }).code === "unreachable" && !this.started) this.brought = false;
      throw e;
    }
  }

  /** One agent primitive, shared with the tool adapters. @internal */
  async primitive<P extends keyof AgentPrimitives>(tool: P, args: PrimitiveArgs<P>, signal?: AbortSignal, timeoutMs?: number): Promise<PrimitiveResult<P>> {
    if (tool === "unbrowse_call" && "browser" in args && args.browser === "never") {
      if ((await this.primitive("unbrowse_whoami", {}, signal, timeoutMs)).call_browser !== true) {
        throw errorFor("this node does not support browser: never on direct route calls. Update it or leave browser unset", 0, "unsupported");
      }
    }
    const req = primitiveRequest(tool, args);
    return this.request(req.method, req.path, req.body, signal, timeoutMs);
  }

  /** Which agent key this client holds, and the node it's live on. A cheap way to check the setup. */
  async whoami(): Promise<Whoami> {
    const r = await this.primitive("unbrowse_whoami", {});
    return {
      agent: r.agent,
      address: r.address,
      node: r.node,
      ...(r.browser !== undefined && { browser: r.browser }),
      ...(typeof r.browser_fetch === "boolean" && { browserFetch: r.browser_fetch }),
      ...(r.owner !== undefined && { owner: r.owner }),
    };
  }

  /**
   * The node's setup, step by step: each step done or not, a line saying where it stands, and the `setup` call that does
   * it. `do` acts on one (`accept_terms`, `sign_in`, `connect_apps`, `web`, `connect_site` with `host`), asking the owner
   * on their screen first. `person` in the answer is what to hand them (a link, a place in the app), never a command.
   */
  async setup(opts: { do?: "accept_terms" | "sign_in" | "connect_apps" | "web" | "connect_site"; host?: string } = {}) {
    return this.primitive("unbrowse_setup", { ...(opts.do && { do: opts.do }), ...(opts.host && { host: opts.host }) });
  }

  /**
   * What the node can do now: whether it has its browser (`present`, `missing`, `installing`, or `unknown` for a node
   * from before the browser was optional), whether it fetches it itself when a goal needs it, and whether it takes
   * `do`'s `browser` option. Search and calls never need the browser; learning a page and driving one do.
   */
  async capabilities(): Promise<Capabilities> {
    const w = await this.whoami();
    return { browser: w.browser ?? "unknown", fetchesBrowser: w.browserFetch === true, browserOption: w.browser !== undefined };
  }

  /**
   * Routes for what you want, by plain words or the site's name: this node's and other contributors' (`remote: true`,
   * with their fetch fee; `overMax` on one the owner's maximum rules out), ranked together. An empty query lists
   * every local route.
   */
  /**
   * A route's values before you call or change it: each step, each field's class and where it comes from, whether a
   * step needs a browser, the scripts the route carries, and its own description. Nothing is called and nothing is
   * paid; no value is shown, only its class and where it came from.
   */
  /**
   * The page in the node's browser as actions, not text: each interactive element with its stable ref, role, name,
   * state and the commands it takes (click, fill, type, select, check). Nothing is clicked and nothing is paid.
   */
  async observe(opts: { site?: string; session?: string; goal?: string } = {}) {
    return this.primitive("unbrowse_observe", { site: opts.site ?? "", session: opts.session ?? "", goal: opts.goal ?? "" });
  }

  /**
   * A page that asks for a person, met with your own eyes: `look` shows it as a picture (`image`, at `w` x `h` CSS
   * pixels) with its text and `asks` (whether it still asks), and `click`, `drag`, `type`, `press`, `wait` or `done`
   * take one step. Every reply is the page again, so you see what your step did; `asks` is the page's own answer.
   * For a short challenge timer, `quick: true` lands a hand step with no picture after it, and `steps` lands a batch of
   * hand steps (`{action, x, y, ...}`) over one browser attachment (it overrides `action`); `look` afterwards.
   */
  async challenge(
    action: "look" | "click" | "drag" | "type" | "press" | "wait" | "done",
    opts: { url?: string; site?: string; session?: string; x?: number; y?: number; toX?: number; toY?: number; text?: string; key?: "Enter" | "Tab" | "Escape" | "Backspace"; ms?: number; quick?: boolean; steps?: Array<Record<string, unknown>> } = {},
  ) {
    return this.primitive("unbrowse_challenge", {
      action,
      url: opts.url ?? "",
      site: opts.site ?? "",
      session: opts.session ?? "",
      x: opts.x,
      y: opts.y,
      to_x: opts.toX,
      to_y: opts.toY,
      text: opts.text,
      key: opts.key,
      ms: opts.ms,
      quick: opts.quick,
      steps: opts.steps,
    });
  }

  async inspect(routeId: string) {
    return this.primitive("unbrowse_inspect", { route_id: routeId });
  }

  async search(query = ""): Promise<Route[]> {
    const r = await this.primitive("unbrowse_search", { query });
    return (r?.routes ?? []).map(toRoute);
  }

  /**
   * The calls a page makes, so you can pick the one that does your goal instead of guessing. Walks `url` once in the
   * node's browser (or reuses the walk this session already made) and returns its candidates: `index` (the candidate's
   * own index to pick), method, host, path, status, bytes, the top-level keys of the answer, and `page` when it is the
   * page itself. With `pick` the node keeps that candidate as a route, named `what` (or `goal`), and returns it in
   * `route`, ready for `call`.
   */
  async walk(url: string, opts: { goal?: string; pick?: number; what?: string; session?: string } = {}) {
    return this.primitive("unbrowse_walk", {
      url,
      goal: opts.goal ?? "",
      pick: opts.pick,
      what: opts.what ?? "",
      session: opts.session ?? "",
    });
  }

  /**
   * What you want, done: the route that does `goal` is called. When none does yet and you give `url` (a page that
   * does it), the node's browser walks the page once, keeps the call that answers the goal, and calls that; the
   * next `do` with the same goal skips the browser. When the page needs clicks or typing, `how` is `"browse"` and the
   * page is open in the node's browser for you to drive. Before the browser, another contributor's route for the
   * page's site may do it (`how: "network"`): the node pays its fee itself, with nothing to approve, up to the
   * owner's per-fetch maximum, `networkSkipped` names any it passed over for costing more, and `paymentRefused` one whose
   * fee this agent's daily limit or balance couldn't cover. A write that fails is
   * answered as it failed, never retried another way: read `result.retry`.
   */
  async do<T = Json>(goal: string, opts: DoOptions = {}): Promise<DoResult<T>> {
    if (opts.browser === "never") {
      // A node from before the option reads past it and may open its browser: "never" isn't sent where it can't hold.
      this.caps ??= this.capabilities().catch((e) => {
        this.caps = null;
        throw e;
      });
      if (!(await this.caps).browserOption) {
        throw errorFor("this node is from before do's browser option, so it can't keep a call off its browser: update the node, or leave browser unset", 0, "unsupported");
      }
    }
    const waitMs = opts.waitMs === undefined ? {} : { wait_ms: Math.trunc(opts.waitMs) };
    let r = opts.ask
      ? await this.primitive("unbrowse_do", { ask: opts.ask, session: this.session, ...waitMs }, opts.signal)
      : await this.primitive(
          "unbrowse_do",
          { goal, url: opts.url ?? "", inputs: inputStrings(opts.inputs ?? {}), session: this.session, ...(opts.browser && opts.browser !== "auto" && { browser: opts.browser }), ...(opts.fields?.length && { fields: opts.fields }), ...waitMs },
          opts.signal,
        );
    // A caller that said no wait is answered as before: the ask is collected while the node still works on it, within
    // the client's own wait.
    const until = Date.now() + this.line.timeoutMs;
    while (opts.waitMs === undefined && r.how === "working" && r.ask && Date.now() < until) {
      r = await this.primitive("unbrowse_do", { ask: r.ask, session: this.session }, opts.signal);
    }
    if (r.how === "working") return { how: "working", ask: r.ask ?? "", phase: r.phase ?? "" };
    // One url asked is never answered as several pages.
    if (r.how === "pages") throw errorFor("the node answered several pages to one", 0, "unsupported");
    const routeFailed = toFailure(r.route_failed);
    if (r.how === "browse") return { how: "browse", site: r.site ?? "", page: r.page ?? "", why: r.why ?? "", routeFailed, networkSkipped: toSkipped(r.network_skipped), networkOffers: toOffers(r.network_offers), paymentRefused: toRefused(r.payment_refused) };
    if (r.how === "network") {
      const e = r.entry;
      const entry = { id: String(e?.id ?? ""), contributor: e?.contributor ?? "", fee: Number(e?.fee ?? 0), listedAs: { site: e?.listed_as?.site ?? "", what: e?.listed_as?.what ?? "" }, ...(e?.reputation && { reputation: toReputation(e.reputation) }) };
      return { how: "network", entry, result: toCall<T>(r.result), routeFailed, ...(r.explored === true && { explored: true }) };
    }
    return { how: r.how === "learned" ? "learned" : "called", route: toRoute(r.route), result: toCall<T>(r.result), pickedBy: str(r.picked_by), routeFailed, networkSkipped: toSkipped(r.network_skipped), networkOffers: toOffers(r.network_offers), paymentRefused: toRefused(r.payment_refused) };
  }

  /**
   * Several pages at once, each done as `do` does one url, side by side on the node. Within a site its first page goes
   * first, so a route learned there answers the site's other pages (another coin's, item's or user's) in one call
   * each. Each answer is cut to how it went, its time and its data; a page that needs clicks or typing says so
   * (`how: "browse"`) and isn't opened: ask `do` for it alone. At most 100 pages.
   *
   * The batch is one ask (`ask`) and each page an ask of its own (each page's `ask`). Answered within `waitMs` (the
   * node's 40 s unsaid) while pages are still being learned, it says `stillWorking`, with the pages answered so far and
   * the rest `how: "working"`, listed in `pending`: `doPages("", [], { ask })` collects the whole batch, and
   * `do("", { ask: page.ask })` that page alone.
   */
  async doPages<T = Json>(goal: string, pages: PageAsk[], opts: DoPagesOptions = {}): Promise<PagesResult<T>> {
    const asked = pages.map((p) => (typeof p === "string" ? { url: p } : { url: p.url, ...(p.goal && { goal: p.goal }), ...(p.inputs && { inputs: inputStrings(p.inputs) }) }));
    const waitMs = opts.waitMs === undefined ? {} : { wait_ms: Math.trunc(opts.waitMs) };
    const r = opts.ask
      ? await this.primitive("unbrowse_do", { ask: opts.ask, session: this.session, ...waitMs }, opts.signal)
      : await this.primitive(
          "unbrowse_do",
          { goal, pages: asked, inputs: inputStrings(opts.inputs ?? {}), session: this.session, ...(opts.browser && opts.browser !== "auto" && { browser: opts.browser }), ...(opts.fields?.length && { fields: opts.fields }), ...waitMs },
          opts.signal,
        );
    if (r.how !== "pages") throw errorFor("this node is from before do's pages: update it, or ask for each page with do", 0, "unsupported");
    return {
      ms: r.ms,
      count: r.count,
      pages: r.pages.map((p) => ({
        url: p.url,
        how: p.how,
        ms: p.ms,
        ok: p.ok,
        routeId: p.route_id ?? null,
        data: (p.data ?? null) as T | null,
        error: p.error ?? null,
        why: p.why ?? null,
        routeFailed: toFailure(p.route_failed),
        ask: p.ask ?? null,
      })),
      fields: Object.fromEntries(Object.entries(r.fields).map(([id, f]) => [id, f.map((x) => ({ path: x.path, kind: x.kind, ...(x.example !== undefined && { example: x.example }) }))])),
      pending: r.pending ?? [],
      ask: r.ask ?? null,
      stillWorking: r.outcome === "still_working",
    };
  }

  /**
   * Call a route and get the site's answer. Inputs go by the names in the route's `inputs`; values are sent as
   * strings. A call that doesn't pass resolves with `ok: false` rather than throwing: read `retry` before you run a
   * write again. Nothing waits for the owner; a network route whose fee is over the owner's per-fetch maximum is
   * refused (`payment_required`), naming both.
   */
  async call<T = Json>(routeId: string, inputs: Record<string, string | number | boolean> = {}, opts: CallOptions = {}): Promise<CallResult<T>> {
    return toCall<T>(await this.primitive("unbrowse_call", { route_id: routeId, inputs: inputStrings(inputs), ...(opts.fields?.length && { fields: opts.fields }), ...(opts.browser && { browser: opts.browser }) }, opts.signal));
  }

  /**
   * What an `unbrowse://` link names: a site's routes, or one route, as the network lists them and the chain proves
   * them. Nothing is called or paid; `call` a route by its id afterwards. A link that isn't one is refused.
   */
  async open(link: string): Promise<LinkPreview> {
    const r = await this.primitive("unbrowse_open", { link });
    return {
      link: r.link,
      site: r.site,
      ...(r.entry && { entry: r.entry }),
      routes: (r.routes ?? []).map(toRoute),
      ...(r.unavailable && { unavailable: r.unavailable }),
    };
  }

  /** Logins saved on the node, as references (`vault:<site>:<account>`). Values never leave the node. */
  async logins(): Promise<Login[]> {
    const r = await this.primitive("unbrowse_logins", {});
    return r?.logins ?? [];
  }

  /**
   * Payment cards saved on the node: each by its label and last four digits, with a `vault:card:<label>:<field>` reference for every field a
   * checkout asks for. Fill one into a page with the browser (`fill(target, card.number)`): the node types it, and asks the owner to approve
   * the payment first. Card numbers never leave the node.
   */
  async cards(): Promise<Card[]> {
    const r = await this.primitive("unbrowse_logins", {});
    return r?.cards ?? [];
  }

  /**
   * Report a problem with Unbrowse itself, so it gets fixed: a result for another thing than asked, ok with a block page
   * or no data, a call that failed or needed a workaround, a confusing answer. Once per distinct problem, then carry
   * on. The node scrubs it (no query strings, emails, tokens or your names), adds the route's shape and your last
   * error, and sends it to be filed as a public GitHub issue on unbrowse-ai/unbrowse. Never for a site that is simply
   * down, and never with personal data. `report` in the result says whether it was sent, queued or off.
   */
  async report(r: Report, opts: { signal?: AbortSignal } = {}): Promise<ReportResult> {
    // An optional field left empty isn't sent, as the node would read it as not given.
    const given = (v: string | undefined) => (v ? v : undefined);
    const x = await this.primitive(
      "unbrowse_report",
      {
        kind: r.kind,
        summary: r.summary,
        expected: r.expected,
        got: r.got,
        route_id: given(r.routeId),
        goal: given(r.goal),
        url: given(r.url),
        // The node takes a tool with or without its `unbrowse_`.
        tool: given(r.tool) as PrimitiveArgs<"unbrowse_report">["tool"],
        error: given(r.error),
      },
      opts.signal,
    );
    return {
      report: x.report,
      issue: str(x.issue),
      newIssue: x.new_issue === true,
      why: str(x.why),
      fingerprint: x.fingerprint ?? "",
      scrubbed: x.scrubbed ?? {},
      contents: (x.contents ?? null) as Json,
    };
  }

  /**
   * Tell the node what you saw in a route's answer, so its next answers are right: you read the answer against your
   * goal, and the node keeps what you say. `wrong` with `url` and `why`: the answer doesn't do that page (an empty
   * list, another thing, the wrong tab); `do()` for it then passes the route over and learns the page afresh, or opens
   * it for your hands. `what`: your words for what the answer really is, which the route goes by from then on.
   * `right` with `fields`: those paths are the answer, kept as the route's defaults.
   */
  async judge(j: Judgment, opts: { signal?: AbortSignal } = {}): Promise<JudgeResult> {
    const given = (v: string | undefined) => (v ? v : undefined);
    const x = (await this.primitive(
      "unbrowse_judge",
      { route_id: j.routeId, verdict: j.verdict, url: given(j.url), why: given(j.why), what: given(j.what), fields: j.fields?.length ? j.fields : undefined, writes: j.writes },
      opts.signal,
    )) as W.JudgeResult;
    return {
      route: toRoute(x.route),
      wrongPages: (x.judged?.wrong_pages ?? []).map((w) => ({ page: w.page, why: w.why })),
      named: x.judged?.named === true,
      fields: x.judged?.fields ?? [],
      writes: x.judged?.writes === true,
      next: x.next ?? "",
    };
  }

  /**
   * Answer what a call's `bounties.confirm` asked (spec ch. 8), once each, with its `bounty` and `entry`: `right` when
   * the answer you got from that entry does your owner's bounty, and the node asks your owner, confirming the bounty
   * (it buys that entry's coin) only on their yes; `wrong` when it doesn't, and you won't be asked about that entry
   * again. Never call an entry only to answer: calls are paid.
   */
  async answerBounty(a: { routeId: string; verdict: "right" | "wrong"; bounty: number; entry: string }, opts: { signal?: AbortSignal } = {}): Promise<W.BountyAnswer> {
    const x = await this.primitive("unbrowse_judge", { route_id: a.routeId, verdict: a.verdict, bounty: a.bounty, entry: a.entry }, opts.signal);
    return x as W.BountyAnswer;
  }

  /**
   * The node's browser, driven by hand, for a page that needs it (`do` says so with `how: "browse"`). Every step is recorded, and the node learns
   * routes from it as you go: each reply names them in `learned`.
   */
  browser(opts: BrowserOptions = {}): Browser {
    return new Browser(this, opts);
  }

  /** @internal One raw browse command, as `POST /v1/browse` takes it. */
  async browse(args: string[], opts: { site?: string; goal?: string; session?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<BrowseReply> {
    const r = await this.primitive("unbrowse_browse", { do: args, site: opts.site ?? "", goal: opts.goal ?? "", session: opts.session ?? this.session }, opts.signal, opts.timeoutMs);
    return {
      site: r.site ?? "",
      output: r.output ?? "",
      learned: (r.learned ?? []).map(toLearned),
      routeForGoal: r.route_for_goal ? toLearned(r.route_for_goal) : null,
      note: str(r.note),
      owner: r.owner === "done" || r.owner === "declined" || r.owner === "no_answer" ? r.owner : null,
      url: str(r.url),
      needsOwner: r.needs_owner === true,
      next: browseCommand(r.next),
    };
  }

  /**
   * The node as an MCP server, for agent frameworks that take one: tools `unbrowse_do`, `unbrowse_browse`,
   * `unbrowse_search`, `unbrowse_call` and `unbrowse_report`. It is `unbrowse mcp` over stdio, which signs each message
   * with the token: the framework never sends the token, so it never reaches a process that took or relays the node's
   * address. The config carries the token in the bridge's environment: keep it out of logs.
   */
  async mcpServer(): Promise<{ type: "stdio"; command: string; args: string[]; env: Record<string, string> }> {
    await this.ensureStarted();
    const token = this.line.token;
    if (!token) throw errorFor("no agent token: pass { token } or set UNBROWSE_AGENT_TOKEN", 401, "unauthorized");
    await proveNode(this.line, token, this.line.timeoutMs);
    return { type: "stdio", command: "unbrowse", args: ["mcp"], env: { UNBROWSE_NODE: this.baseUrl, UNBROWSE_AGENT_TOKEN: token } };
  }
}
