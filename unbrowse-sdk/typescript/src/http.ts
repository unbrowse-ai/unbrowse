import { DEFAULT_PORT, ERRORS } from "./generated.js";
import { answerHolds, hex, nodeProof, portOf, tokenKey } from "./proof.js";
import { answerIsTheNodes, bodyHash, signRequest, STREAM } from "./signed.js";

export const DEFAULT_NODE = `http://127.0.0.1:${DEFAULT_PORT}`;

/**
 * Why a request failed. `code` is read from the HTTP status, since the node answers `{ "error": "<why>" }`, or from the
 * code its body names. Each code, its status, its class and what it means are the node's: `ERRORS` (agent-api.json).
 */
export class UnbrowseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly body?: unknown,
  ) {
    super(message);
    // Each subclass is named for itself: `AuthenticationError`, `NotFoundError`, ...
    this.name = new.target.name;
  }
}

/*
 * One class per way a request fails, all `UnbrowseError`s, so a caller catches what it can handle and lets the rest
 * through: `catch (e) { if (e instanceof AuthenticationError) ... }`. `code` and `status` are the same as before.
 */

/** 400: a call the node couldn't run with these inputs; an owner command that failed. */
export class BadRequestError extends UnbrowseError {}
/** 401: no token, or a key that is unknown, revoked or expired; on `/owner`, not the token the running node holds. */
export class AuthenticationError extends UnbrowseError {}
/** 402: a paid route this key isn't authorised for, past its cap, or over the owner's per-fetch maximum. */
export class PaymentRequiredError extends UnbrowseError {}
/** 403: the owner declined (or didn't answer in five minutes), or turned learning off. */
export class PermissionDeniedError extends UnbrowseError {}
/** 404: no such route, owner command or walk picture; or nothing does the goal yet and no `url` was given. */
export class NotFoundError extends UnbrowseError {}
/** 409: routes on more than one site do the goal: give `url` to say which. */
export class ConflictError extends UnbrowseError {}
/** 422: the browser or the learner couldn't do it; `message` says why. */
export class UnprocessableEntityError extends UnbrowseError {}
/**
 * 422 with the node's code `browser_missing`: what was asked needs the node's browser (to learn a page, or to drive one by
 * hand), and the node lacks it or the call said `browser: "never"`. Everything else works without it: search, calls of
 * routes the node holds or fetches, whoami. `install` says how to get it (`unbrowse browser install`); `fetches` is
 * whether the node fetches it by itself when a goal needs it. Also an `UnprocessableEntityError`, which is what code
 * written before the browser was optional catches.
 */
export class BrowserMissingError extends UnprocessableEntityError {
  /** The browser as the node saw it: `missing`, `installing` (fetching it now: try again in a minute) or `present`. */
  get browser(): "present" | "missing" | "installing" {
    const b = (this.body as { browser?: unknown } | undefined)?.browser;
    return b === "present" || b === "installing" ? b : "missing";
  }
  /** The parts missing: `program` (the browser program, for driving a page) and `chromium` (for any page). */
  get missing(): string[] {
    const m = (this.body as { missing?: unknown } | undefined)?.missing;
    return Array.isArray(m) ? m.map(String) : [];
  }
  /** How to get it, on the node's machine. */
  get install(): string {
    const i = (this.body as { install?: unknown } | undefined)?.install;
    return typeof i === "string" ? i : "unbrowse browser install";
  }
  /** Whether the node fetches the browser itself the first time a goal needs it. */
  get fetches(): boolean {
    return (this.body as { fetch?: unknown } | undefined)?.fetch === true;
  }
}
/** 503: the node is paused by its owner, or waiting for Keychain access. */
export class NodeUnavailableError extends UnbrowseError {}
/** Status 0: the node isn't running, or nothing answers at its address. */
export class NodeConnectionError extends UnbrowseError {}
/** Status 0: the node didn't answer in time. Also a `NodeConnectionError`. */
export class NodeTimeoutError extends NodeConnectionError {}

/** The classes by their names in `ERRORS`. */
const BY_NAME: Record<string, typeof UnbrowseError> = {
  BadRequestError,
  AuthenticationError,
  PaymentRequiredError,
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  UnprocessableEntityError,
  BrowserMissingError,
  NodeUnavailableError,
  NodeConnectionError,
  NodeTimeoutError,
};

const CLASSES: Record<string, typeof UnbrowseError> = Object.fromEntries(ERRORS.filter((e) => e.class).map((e) => [e.code, BY_NAME[e.class]]));

/** The error for a failure: the class its `code` names, else a plain `UnbrowseError`. */
export function errorFor(message: string, status: number, code: string, body?: unknown): UnbrowseError {
  return new (CLASSES[code] ?? UnbrowseError)(message, status, code, body);
}

/** Each status the node answers with, as its code: the first `ERRORS` names for it (422 is `unprocessable` unless the
 * body names `browser_missing`). */
const CODES: Record<number, string> = {};
for (const e of ERRORS) if (e.status > 0 && !(e.status in CODES)) CODES[e.status] = e.code;

export function env(name: string): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];
}

/** Where a client sends, and with what. */
export type Line = {
  baseUrl: string;
  /** Signs each request (`signed.ts`), never sent itself. Absent: requests go unsigned (a proxy in front of the node signs them). */
  token?: string;
  timeoutMs: number;
  fetch: typeof globalThis.fetch;
};

/** Keeps the fields that hold a token out of what a log shows of `obj` (`console.log`, `util.inspect`) and out of
 * `JSON.stringify`: TypeScript's `private` is gone at run time. */
export function keepOutOfLogs(obj: object, ...fields: string[]): void {
  for (const f of fields) Object.defineProperty(obj, f, { enumerable: false, writable: true, configurable: true });
}

export function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Asks what listens at `line.baseUrl` to answer a fresh challenge for `token` (`/v1/node/proof`): only the node the token
 * is for can. It doesn't keep the token safe by itself (a process that relays the challenge to the node passes it):
 * the token is never sent at all, each request is signed with it (`signed.ts`). The proof keeps what a request says
 * from a listener that took the node's port while it was away and can't reach the node.
 */
export async function proveNode(line: Line, token: string, timeoutMs: number): Promise<void> {
  const port = portOf(line.baseUrl);
  // From here the token isn't accepted, as a 401 says: the listener isn't the node it is for, or the node no longer
  // holds it (revoked, expired, an owner token from before a restart). Which, a client can't tell, and needn't.
  const refused = (why: string) => errorFor(`${why}; the token wasn't sent`, 401, "unauthorized");
  if (port === undefined) throw refused(`the node's address (${line.baseUrl || "this page's origin"}) names no port to prove`);
  const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(Math.min(timeoutMs, 30_000)) : AbortSignal.timeout(30_000);
  let answer: unknown;
  try {
    // A redirect is never followed: whatever answers here proves itself here, or not at all.
    const res = await line.fetch(`${line.baseUrl}/v1/node/proof?challenge=${hex(challenge)}&key=${tokenKey(token)}`, { signal: timeout, redirect: "manual" });
    answer = redirected(res) ? undefined : await res.json().catch(() => undefined);
  } catch (e) {
    if (timeout.aborted) throw errorFor(`the node didn't answer within ${timeoutMs} ms`, 0, "timeout");
    throw errorFor(`couldn't reach the node at ${line.baseUrl}: is the Unbrowse app running? (${(e as Error).message})`, 0, "unreachable");
  }
  if (!answerHolds(answer, nodeProof(token, port, challenge))) {
    throw refused(`what answers at ${line.baseUrl} couldn't prove it is the node this token is for (or the node no longer holds the token)`);
  }
}

/** The nonce a signed raw answer was signed over, for an event stream to check its events against. */
export const signedNonce = new WeakMap<Response, string>();

/**
 * One request to the node. Answers are JSON unless `raw`, which hands back the response itself. `timeoutMs` 0 waits
 * as long as the caller's signal lets it (a stream of events).
 *
 * With a token, the request is signed with it and the token never goes over the wire; an answer is used only when the
 * node signed it for this request (`signed.ts`). Without one (a proxy in front of the node adds what it needs), it
 * goes as it is.
 */
export async function send(line: Line, method: "GET" | "POST", path: string, opts: { body?: unknown; signal?: AbortSignal; raw?: boolean; accept?: string; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<any> {
  const limit = opts.timeoutMs ?? line.timeoutMs;
  const timeout = limit > 0 ? AbortSignal.timeout(limit) : undefined;
  const signals = [opts.signal, timeout].filter((s): s is AbortSignal => !!s);
  const token = line.token;
  // What answers there proves first it is the node the token is for, so nothing a request says goes to a listener that
  // can't reach the node.
  if (token) await proveNode(line, token, limit);
  const url = `${line.baseUrl}${path}`;
  const bytes = opts.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(opts.body));
  const signedBy = token ? await signRequest(token, method, url, bytes) : undefined;
  let res: Response;
  try {
    res = await line.fetch(url, {
      method,
      headers: {
        ...opts.headers,
        ...signedBy?.headers,
        ...(opts.body !== undefined && { "content-type": "application/json" }),
        ...(opts.accept && { accept: opts.accept }),
      },
      body: opts.body === undefined ? undefined : bytes,
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
      // A request to the node goes to its address and nowhere else: an answer that points elsewhere ends it.
      redirect: "manual",
    });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    if (timeout?.aborted) throw errorFor(`the node didn't answer within ${limit} ms`, 0, "timeout");
    throw errorFor(`couldn't reach the node at ${line.baseUrl || "this page's origin"}: is the Unbrowse app running? (${(e as Error).message})`, 0, "unreachable");
  }
  if (redirected(res)) {
    await res.body?.cancel().catch(() => undefined);
    throw errorFor(`what answered at ${line.baseUrl || "this page's origin"} pointed elsewhere (status ${res.status}): a request to the node is never sent on`, 0, "unreachable");
  }
  const streams = (res.headers.get("content-type") ?? "").startsWith("text/event-stream");
  if (res.ok && opts.raw && streams) {
    if (token && signedBy && !(await answerIsTheNodes(token, res.status, res.headers, STREAM, signedBy.nonce))) {
      await res.body?.cancel().catch(() => undefined);
      throw notTheNodes(line, res.status);
    }
    if (signedBy) signedNonce.set(res, signedBy.nonce);
    return res;
  }
  const body = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(body);
  const verified = !token || !signedBy || (await answerIsTheNodes(token, res.status, res.headers, await bodyHash(body), signedBy.nonce));
  // A success is used only when it is the node's. A refusal isn't signed when the node couldn't tell whose it was, and
  // is never acted on: it is said as a failure either way.
  if (res.ok && !verified) throw notTheNodes(line, res.status);
  // A refusal the node didn't sign (it couldn't tell whose the request was) may be anyone's words: only its status is
  // read, and what is said is this client's own.
  if (!res.ok && !verified) throw errorFor(unsignedRefusal(res.status), res.status, CODES[res.status] ?? `http_${res.status}`);
  if (res.ok && opts.raw) return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  let parsed: any = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON: kept as text in the error below.
  }
  if (!res.ok) {
    const why = typeof parsed?.error === "string" ? parsed.error : text || res.statusText;
    // A code the node names (`browser_missing`) says more than the status; a node from before codes names none.
    const code = typeof parsed?.code === "string" && parsed.code in CLASSES ? parsed.code : CODES[res.status] ?? `http_${res.status}`;
    throw errorFor(why, res.status, code, parsed ?? text);
  }
  return parsed;
}

/** Whether an answer is a redirect, which no request to the node follows (a browser's manual redirect is opaque). */
function redirected(res: Response): boolean {
  return res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
}

function notTheNodes(line: Line, status: number): UnbrowseError {
  return errorFor(
    `what answered at ${line.baseUrl || "this page's origin"} didn't sign its answer as the node this token is for does (status ${status}): nothing it said is used or shown`,
    0,
    "unreachable",
  );
}

/**
 * What a client says of a refusal the node didn't sign, by its status alone: the node signs every answer once it knows
 * whose the request is, so an unsigned one is either the node refusing before that (an unknown key, a bad signature, a
 * clock too far off, a node not ready) or something else holding its address. Its words are never shown.
 */
export function unsignedRefusal(status: number): string {
  const said: Record<number, string> = {
    401: "the node refused this request before it could tell whose it was: the key may be unknown, revoked or expired, or this machine's clock too far off (get a fresh key: `unbrowse connect`, or `unbrowse agent token`)",
    413: "the request was larger than the node takes",
    421: "the node takes requests at 127.0.0.1 or localhost on its own port only",
    503: "the node isn't ready for this (starting, paused, or waiting for its key, or it couldn't record the request): try again shortly",
  };
  return `${said[status] ?? "the node refused this request"} (status ${status}; the answer wasn't signed, so nothing it said is shown)`;
}
