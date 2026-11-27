import { DEFAULT_NODE, UnbrowseError, errorFor, env, keepOutOfLogs, send, signedNonce, trimBase, type Line } from "./http.js";
import { eventMac, sameHex } from "./signed.js";
import { CALL_WAIT_MS, OwnerCommands } from "./generated.js";
import type { NewAgent, OwnerEvents, PasskeyArmed, Pricing, Settings, VaultLogin } from "./owner-types.js";

/** A call the owner runs may heal by walking the site again: it can take minutes. */

export type UnbrowseOwnerOptions = {
  /**
   * The owner's token, or how to read it. The node writes a fresh one to `~/.unbrowse/owner.token` (mode 0600) every
   * start, so a token held as text is refused from the node's next start: pass `ownerToken` from `unbrowse/local` itself,
   * not what it answers, and each request reads the file. Defaults to `UNBROWSE_OWNER_TOKEN`. Leave it out when a proxy
   * in front of the node adds it (a page served beside the node: pass `baseUrl: ""`).
   */
  token?: string | (() => string | undefined);
  /** The node's address. Defaults to `UNBROWSE_NODE`, then http://127.0.0.1:7788. `""` sends to the page's own origin. */
  baseUrl?: string;
  /** Per-request timeout. Defaults to 330 s. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

type Listener = (payload: any) => void;

/**
 * The node's live events over `GET /owner/events` (server-sent events), on one connection that comes back by itself
 * when the node restarts. Each (re)connect fires `open`: refetch what you show then, since events sent while the line
 * was down are gone. The restarted node has a fresh token, so that holds for a client that reads its token, or one
 * behind a proxy; a stream with a token held as text ends at the refusal, through `onError`, and `closed` says so.
 */
export class EventStream {
  private listeners = new Map<string, Set<Listener>>();
  private stop = new AbortController();

  constructor(
    private line: Line,
    private onError?: (e: UnbrowseError) => void,
    /** The token is text, so a refusal is final. A token read each time can change, and a proxy can mend its own. */
    private fixedToken = false,
  ) {
    void this.loop();
  }

  /** Listen for one event. Returns the function that stops listening. */
  on<K extends keyof OwnerEvents>(name: K, fn: (payload: OwnerEvents[K]) => void): () => void;
  on(name: string, fn: (payload: unknown) => void): () => void;
  on(name: string, fn: Listener): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
    return () => void set.delete(fn);
  }

  /** Close the connection for good. */
  close(): void {
    this.stop.abort();
    this.listeners.clear();
  }

  get closed(): boolean {
    return this.stop.signal.aborted;
  }

  private emit(name: string, payload: unknown) {
    for (const fn of [...(this.listeners.get(name) ?? [])]) {
      try {
        fn(payload);
      } catch (e) {
        // One listener's failure is its own: the stream and the other listeners carry on. A browser reports it as
        // it would any page error; elsewhere it is logged, never rethrown, since an uncaught error ends a Node process.
        const report = (globalThis as { reportError?: (e: unknown) => void }).reportError;
        if (report) report(e);
        else console.error(e);
      }
    }
  }

  private async loop() {
    let wait = 500;
    while (!this.closed) {
      try {
        const res: Response = await send(this.line, "GET", "/owner/events", { raw: true, accept: "text/event-stream", signal: this.stop.signal, timeoutMs: 0 });
        if (!res.body) throw errorFor("the node's event stream had no body", 0, "unreachable");
        wait = 500;
        this.emit("open", null);
        await this.read(res.body, signedNonce.get(res));
      } catch (e) {
        if (this.closed) return;
        if (this.fixedToken && e instanceof UnbrowseError && e.status === 401) {
          // No retry can pass: the node holds this token's successor until its next start, which makes another.
          const told = errorFor(`the node refused this token, and the stream has stopped (${e.message}): the node makes a fresh one every start, so pass \`token: ownerToken\` to read it each time`, e.status, e.code, e.body);
          if (this.onError) this.onError(told);
          else console.error(told);
          this.close();
          return;
        }
        this.onError?.(e instanceof UnbrowseError ? e : errorFor(`the node's event stream broke: ${(e as Error).message}`, 0, "unreachable"));
      }
      if (this.closed) return;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 10_000);
    }
  }

  /**
   * Reads the stream's events. A stream answering a signed request (`nonce`) has each event's `id` say its place and
   * carry the node's signature over it: an event out of place or not the node's ends the stream, which comes back.
   */
  private async read(body: ReadableStream<Uint8Array>, nonce?: string) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let halfCr = false;
    const seq = { next: 0 };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        let text = decoder.decode(value, { stream: true });
        if (text) {
          // A CRLF cut between its CR and its LF across two chunks is one line end, not two: the CR already
          // closed its line, so an LF opening the next chunk is that line end's other half and is dropped
          // (UNB-181).
          if (halfCr && text.startsWith("\n")) text = text.slice(1);
          halfCr = text.endsWith("\r");
          buf += text.replace(/\r\n?/g, "\n");
        }
        let end: number;
        while ((end = buf.indexOf("\n\n")) >= 0) {
          await this.dispatch(buf.slice(0, end), nonce, seq);
          buf = buf.slice(end + 2);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async dispatch(block: string, nonce: string | undefined, seq: { next: number }) {
    let name = "message";
    let id = "";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") name = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
    if (!data.length) return;
    const raw = data.join("\n");
    const token = this.line.token;
    if (nonce && token) {
      const [place, sig] = id.split(".");
      if (place !== String(seq.next) || !sig || !sameHex(await eventMac(token, nonce, seq.next, name, raw), sig)) {
        throw errorFor(`an event on the node's stream isn't the node's, or is out of place (expected event ${seq.next}): the stream was dropped`, 0, "unreachable");
      }
      seq.next += 1;
    }
    let payload: unknown = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      // Not JSON: passed on as text.
    }
    this.emit(name, payload);
  }
}

/**
 * The node as its owner sees it: everything the Unbrowse window does, over `POST /owner/{command}`. Routes, agent
 * keys, the vault, settings (the per-fetch maximum agents spend up to among them), the wallet and the chain. Records come back in the node's own snake
 * case, ready to send back (`saveSettings(settings)`).
 *
 * One method per command comes from the node's own list of them (`OwnerCommands`, generated from agent-api.json);
 * this class adds the live events, a walk's picture, and the friendlier forms a few commands keep from before.
 *
 * The owner's token can do anything on the node, the vault included. Keep it on this machine.
 */
export class UnbrowseOwner extends OwnerCommands {
  readonly baseUrl: string;
  private line: Line;
  private fixedToken: boolean;

  constructor(opts: UnbrowseOwnerOptions = {}) {
    super();
    this.baseUrl = trimBase(opts.baseUrl ?? env("UNBROWSE_NODE") ?? DEFAULT_NODE);
    const given = opts.token ?? env("UNBROWSE_OWNER_TOKEN");
    this.fixedToken = typeof given === "string" && given !== "";
    this.line = {
      baseUrl: this.baseUrl,
      get token() {
        return typeof given === "function" ? given() : given;
      },
      timeoutMs: opts.timeoutMs ?? CALL_WAIT_MS,
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
    };
    keepOutOfLogs(this, "line");
  }

  /** Any owner command by name, with its arguments as the node takes them: `command("activity", { limit: 50 })`. */
  command<T = unknown>(cmd: string, args: Record<string, unknown> = {}, opts: { signal?: AbortSignal } = {}): Promise<T> {
    return send(this.line, "POST", `/owner/${encodeURIComponent(cmd)}`, { body: args, signal: opts.signal });
  }

  /** The node's live events. One connection per stream: share it. */
  events(opts: { onError?: (e: UnbrowseError) => void } = {}): EventStream {
    return new EventStream(this.line, opts.onError, this.fixedToken);
  }

  /** The latest picture of a walk as a JPEG; the newest walk's when `walk` is left out. */
  async frame(walk = "", opts: { signal?: AbortSignal } = {}): Promise<Blob> {
    const res: Response = await send(this.line, "GET", `/owner/frame?walk=${encodeURIComponent(walk)}`, { raw: true, signal: opts.signal });
    return res.blob();
  }

  /** This node's own address alone: where to send it gas (`identity`). */
  async address(): Promise<string> {
    return (await this.identity()).address;
  }

  /**
   * Set the most the node pays, in USDC, to fetch one route another contributor lists (a sum, zero or more; 0 uses
   * only free routes and the node's own). Agents spend up to it on their own; nothing asks the owner.
   */
  async setMaxFetch(usdc: number): Promise<Settings> {
    const settings = await this.settings();
    return this.saveSettings({ ...settings, max_fetch_usdc: usdc });
  }

  /**
   * Make an agent key. `setup` names the agent, never its token; `token` is the token, on this answer alone: hand it to
   * the agent, then let it go. What the key
   * may spend an epoch is its cap, in USDC; what the node pays for one fetch is the owner's maximum (`setMaxFetch`).
   */
  createAgent(key: {
    name: string;
    /** The most the key spends an epoch, in USDC. */
    capUsdc?: number;
    /** @deprecated The same cap, named before fees were USDC: use `capUsdc`. */
    capUnb?: number;
    days: number;
    /** @deprecated Ignored and not sent: no call waits for the owner. */ approvalUsd?: number;
  }): Promise<NewAgent>;
  createAgent(name: string, capUsdc: number, days: number): Promise<NewAgent>;
  createAgent(key: string | { name: string; capUsdc?: number; capUnb?: number; days: number }, capUsdc?: number, days?: number): Promise<NewAgent> {
    const [name, cap, d] = typeof key === "string" ? [key, capUsdc as number, days as number] : [key.name, key.capUsdc ?? key.capUnb, key.days];
    // The cap goes under its old name too, the one a node from before the rename reads; the amount is USDC either way.
    return this.command("agent_create", { name, cap_usdc: cap, cap_unb: cap, days: d });
  }

  /** Save a login. `derived` makes its password from the root key and needs none; `stored` keeps the one given. */
  vaultAdd(login: { site: string; account: string; kind: "derived" | "stored"; password?: string }): Promise<VaultLogin>;
  vaultAdd(site: string, account: string, kind: "derived" | "stored", password?: string | null): Promise<VaultLogin>;
  vaultAdd(
    login: string | { site: string; account: string; kind: "derived" | "stored"; password?: string },
    account?: string,
    kind?: "derived" | "stored",
    password?: string | null,
  ): Promise<VaultLogin> {
    if (typeof login === "string") return super.vaultAdd(login, account as string, kind as "derived" | "stored", password);
    return this.command("vault_add", { site: login.site, account: login.account, kind: login.kind, password: login.password ?? null });
  }

  /** The node's one fee for all its routes, in USDC, and whether demand may move it between `floor` and `ceiling`. */
  setPricing(pricing: { fee: number; auto: boolean; floor: number; ceiling: number }): Promise<Pricing>;
  setPricing(fee: number, auto: boolean, floor: number, ceiling: number): Promise<Pricing>;
  setPricing(pricing: number | { fee: number; auto: boolean; floor: number; ceiling: number }, auto?: boolean, floor?: number, ceiling?: number): Promise<Pricing> {
    const p = typeof pricing === "number" ? { fee: pricing, auto: auto as boolean, floor: floor as number, ceiling: ceiling as number } : pricing;
    return super.setPricing(p.fee, p.auto, p.floor, p.ceiling);
  }

  /** Keep passkeys off one site (`never`, the default), or allow them there again. The site, as the node keeps it. */
  passkeyNever(site: string, never: boolean | null = true): Promise<string> {
    return super.passkeyNever(site, never);
  }

  /**
   * Keep the next passkey `site` makes, for `minutes`: in the node's own browser for the site, or in another one the
   * node reaches over DevTools at `cdp`. The browser must be signed in to the site; its own "add a passkey" flow does
   * the rest.
   */
  passkeyEnrol(site: string, opts?: { cdp?: string; minutes?: number }): Promise<PasskeyArmed>;
  passkeyEnrol(site: string, cdp?: string | null, minutes?: number | null): Promise<PasskeyArmed>;
  passkeyEnrol(site: string, opts?: string | null | { cdp?: string; minutes?: number }, minutes?: number | null): Promise<PasskeyArmed> {
    if (opts !== null && typeof opts === "object") return super.passkeyEnrol(site, opts.cdp ?? null, opts.minutes ?? null);
    return super.passkeyEnrol(site, opts ?? null, minutes ?? null);
  }

  /**
   * Give the page back: `done` says the owner did what an agent asked, which hears it. `ask` names the ask answered
   * (`hands().asks`), refused once it no longer waits; with `paymentApprover("sdk")` on, done naming a card payment's
   * ask approves that payment without the node's dialog. `via` says where the owner answered, for their activity.
   */
  handsGiveBack(site: string, done: boolean | null = true, ask?: string | null, via?: string | null): Promise<{ site: string; answered: number }> {
    return super.handsGiveBack(site, done, ask, via);
  }
}
