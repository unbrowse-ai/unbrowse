import type { UnbrowseNode } from "./client.js";
import type { BrowseReply, LearnedRoute } from "./types.js";

export type BrowserOptions = {
  /** What you're doing, e.g. "post a listing": the node names the routes it learns from this browsing after it. */
  goal?: string;
  /** Which site's browser to drive, when you pick up one already open. `open()` sets it. */
  site?: string;
  /** The browsing session, and so the tab, this browser drives. Defaults to the client's (`node.session`). */
  session?: string;
};

export type SnapshotOptions = {
  /** Only interactive elements (`-i`): the usual choice before clicking or filling. */
  interactive?: boolean;
  /** Drop empty structural nodes (`-c`). */
  compact?: boolean;
  /** How deep to go (`-d`). */
  depth?: number;
  /** Only under this CSS selector (`-s`). */
  selector?: string;
};

export type WaitFor =
  | number
  | string
  | { text: string; timeoutMs?: number }
  | { url: string; timeoutMs?: number }
  | { load: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number }
  | { fn: string; timeoutMs?: number };

export type GetWhat = "text" | "html" | "value" | "title" | "url" | "count" | "box" | "styles";

/**
 * One site's browser on the node, driven by hand. A target is a ref from `snapshot()` (`@e3`) or a CSS selector.
 * Every method returns the node's reply: what the browser printed, and the routes this browsing has learned. Once a
 * route does what you're clicking through, call it instead (`node.call(route.routeId, inputs)`).
 *
 * Pages are the site's own, in the site's own profile on the node, so logins hold between steps and between runs. A
 * check only a person can pass goes to the owner with `askOwner`.
 */
export class Browser {
  /** The site this browser is on, once a page is open. */
  site: string;
  goal: string;
  /** The browsing session this browser drives: its own tab in the site's browser. */
  readonly session: string;
  /** Every route this browsing has learned, newest last. */
  readonly learned: LearnedRoute[] = [];
  /** The last reply's route for the goal, if `open` found one. */
  routeForGoal: LearnedRoute | null = null;

  constructor(
    private node: UnbrowseNode,
    opts: BrowserOptions = {},
  ) {
    this.site = opts.site ?? "";
    this.goal = opts.goal ?? "";
    this.session = opts.session ?? node.session;
  }

  /** Any command the node's browser takes, word by word: `run("get", "attr", "@e2", "href")`. */
  async run(...args: string[]): Promise<BrowseReply> {
    return this.runWaiting(args);
  }

  private async runWaiting(args: string[], timeoutMs?: number): Promise<BrowseReply> {
    const reply = await this.node.browse(args, { site: this.site, goal: this.goal, session: this.session, timeoutMs });
    if (reply.site) this.site = reply.site;
    for (const r of reply.learned) {
      if (!this.learned.some((l) => l.routeId === r.routeId)) this.learned.push(r);
    }
    if (reply.routeForGoal || args[0] === "open") this.routeForGoal = reply.routeForGoal;
    return reply;
  }

  /** Open a page (a full http(s) URL). With a goal a route already does, the reply's `routeForGoal` names it. */
  open(url: string, opts: { goal?: string } = {}): Promise<BrowseReply> {
    if (opts.goal !== undefined) this.goal = opts.goal;
    return this.run("open", url);
  }

  /** The page as an accessibility tree, each element with a ref (`@e3`) to act on. */
  snapshot(opts: SnapshotOptions = {}): Promise<BrowseReply> {
    const args = ["snapshot"];
    if (opts.interactive) args.push("-i");
    if (opts.compact) args.push("-c");
    if (opts.depth !== undefined) args.push("-d", String(opts.depth));
    if (opts.selector) args.push("-s", opts.selector);
    return this.run(...args);
  }

  click(target: string): Promise<BrowseReply> {
    return this.run("click", target);
  }

  dblclick(target: string): Promise<BrowseReply> {
    return this.run("dblclick", target);
  }

  /** Clear the field and fill it. What you fill becomes a route input when the page sends it. */
  fill(target: string, text: string): Promise<BrowseReply> {
    return this.run("fill", target, text);
  }

  /** Type into the field, keeping what's there. */
  type(target: string, text: string): Promise<BrowseReply> {
    return this.run("type", target, text);
  }

  /** Press a key: `Enter`, `Tab`, `Control+a`. */
  press(key: string): Promise<BrowseReply> {
    return this.run("press", key);
  }

  /** Pick an option by value or visible label. */
  select(target: string, value: string): Promise<BrowseReply> {
    return this.run("select", target, value);
  }

  check(target: string): Promise<BrowseReply> {
    return this.run("check", target);
  }

  uncheck(target: string): Promise<BrowseReply> {
    return this.run("uncheck", target);
  }

  hover(target: string): Promise<BrowseReply> {
    return this.run("hover", target);
  }

  focus(target: string): Promise<BrowseReply> {
    return this.run("focus", target);
  }

  scroll(direction: "up" | "down" | "left" | "right", px?: number, opts: { selector?: string } = {}): Promise<BrowseReply> {
    const args = ["scroll", direction];
    if (px !== undefined) args.push(String(px));
    if (opts.selector) args.push("--selector", opts.selector);
    return this.run(...args);
  }

  scrollIntoView(target: string): Promise<BrowseReply> {
    return this.run("scrollintoview", target);
  }

  /** Upload files (paths on the node's machine) into a file input. */
  upload(target: string, ...files: string[]): Promise<BrowseReply> {
    return this.run("upload", target, ...files);
  }

  /** Read something off the page: `get("text", "@e1")`, `get("title")`, `get("url")`. */
  get(what: GetWhat, target?: string): Promise<BrowseReply> {
    return this.run(...["get", what, ...(target ? [target] : [])]);
  }

  /** An element's attribute. */
  attr(target: string, name: string): Promise<BrowseReply> {
    return this.run("get", "attr", target, name);
  }

  /** Whether an element is visible, enabled or checked. */
  is(state: "visible" | "enabled" | "checked", target: string): Promise<BrowseReply> {
    return this.run("is", state, target);
  }

  /**
   * Find an element by what a person sees and act on it: `find("label", "Email", "fill", "me@example.com")`,
   * `find("role", "button", "click", undefined, { name: "Submit" })`. `name` narrows a role by its accessible name;
   * `exact` matches case and the whole text.
   */
  find(
    by: "role" | "text" | "label" | "placeholder" | "alt" | "title" | "testid" | "first" | "last",
    value: string,
    action: "click" | "fill" | "check" | "hover" | "text",
    actionValue?: string,
    opts: { name?: string; exact?: boolean } = {},
  ): Promise<BrowseReply> {
    const args = ["find", by, value, action];
    if (actionValue !== undefined) args.push(actionValue);
    if (opts.name !== undefined) args.push("--name", opts.name);
    if (opts.exact) args.push("--exact");
    return this.run(...args);
  }

  /** Wait for an element (selector or ref), a time in ms, text, a URL pattern, a load state or a JS condition. */
  wait(what: WaitFor): Promise<BrowseReply> {
    if (typeof what === "number") return this.run("wait", String(what));
    if (typeof what === "string") return this.run("wait", what);
    const args = ["wait"];
    if ("text" in what) args.push("--text", what.text);
    if ("url" in what) args.push("--url", what.url);
    if ("load" in what) args.push("--load", what.load);
    if ("fn" in what) args.push("--fn", what.fn);
    if (what.timeoutMs !== undefined) args.push("--timeout", String(what.timeoutMs));
    return this.run(...args);
  }

  back(): Promise<BrowseReply> {
    return this.run("back");
  }

  forward(): Promise<BrowseReply> {
    return this.run("forward");
  }

  reload(): Promise<BrowseReply> {
    return this.run("reload");
  }

  /**
   * Run JavaScript in the page; the reply's `output` is its result. A script has 30 s; `timeoutMs` gives it longer, up
   * to 300 000.
   */
  eval(js: string, opts: { timeoutMs?: number } = {}): Promise<BrowseReply> {
    if (opts.timeoutMs === undefined) return this.run("eval", js);
    return this.runWaiting(["eval", "--timeout", String(opts.timeoutMs), js], opts.timeoutMs + 60_000);
  }

  /** A screenshot, saved on the node's machine; the reply's `output` says where. */
  screenshot(opts: { path?: string; full?: boolean; annotate?: boolean } = {}): Promise<BrowseReply> {
    const args = ["screenshot"];
    if (opts.path) args.push(opts.path);
    if (opts.full) args.push("--full");
    if (opts.annotate) args.push("--annotate");
    return this.run(...args);
  }

  /**
   * Ask the owner to do something on this page only a person can: sign in when the vault has no login, enter a code,
   * pass a check. The page shows in the Unbrowse app, where the owner clicks and types on it; this waits until they
   * give it back (5 minutes, or `timeoutS` up to 1800) and the reply's `owner` says how it went. What they type never
   * reaches you; the session they earn stays in the site's profile, so your next step is signed in.
   */
  askOwner(why: string, opts: { timeoutS?: number } = {}): Promise<BrowseReply> {
    const args = ["ask_owner", why];
    if (opts.timeoutS !== undefined) args.push("--timeout", String(opts.timeoutS));
    // The node answers once the owner does: the request waits a little longer than the ask.
    return this.runWaiting(args, (Math.min(opts.timeoutS ?? 300, 1800) + 30) * 1000);
  }

  /** Close the site's browser. The node learns the flow first, while the browser still holds its session. */
  close(): Promise<BrowseReply> {
    return this.run("close");
  }
}
