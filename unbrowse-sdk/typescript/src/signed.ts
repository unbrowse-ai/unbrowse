// Requests signed with a token, never carrying it (`unbrowse_core::signed` on the node).
//
// The client names its token by its key (`tokenKey`) and signs each request with an HMAC-SHA256 keyed by the token over
// the method, the authority it goes to (host and port), the request target (path and query, as sent), a SHA-256 of the body, the time and a fresh nonce. The node
// checks it and takes each nonce once. A process that took the node's address, or relays it, gets one request it can't
// send again and no token. The node signs its answer over the status, a SHA-256 of the body and the request's nonce,
// and each event of a stream with its place in it, so an answer of anyone else's is never used.

import { hex, tokenKey } from "./proof.js";

const enc = new TextEncoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("signing a request needs WebCrypto (crypto.subtle): Node 20.3+ or a browser on https or localhost");
  return s;
}

async function hmac(token: string, parts: string[]): Promise<string> {
  const key = await subtle().importKey("raw", enc.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await subtle().sign("HMAC", key, enc.encode(parts.join("\n")))));
}

/** SHA-256 of a body, hex: what the signatures carry in its place. */
export async function bodyHash(body: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await subtle().digest("SHA-256", body as BufferSource)));
}

/** What stands for the body hash in the signature on an event stream's answer. */
export const STREAM = "event-stream";

/** `authority` is the host and port the request goes to (`addressOf`): signed for one, it verifies at no other. */
export async function requestMac(token: string, method: string, authority: string, target: string, body: Uint8Array, time: number, nonce: string): Promise<string> {
  return hmac(token, ["unbrowse/request/v2", method.toUpperCase(), authority.toLowerCase(), target, await bodyHash(body), String(time), nonce]);
}

export async function replyMac(token: string, status: number, hash: string, nonce: string): Promise<string> {
  return hmac(token, ["unbrowse/reply/v1", String(status), hash, nonce]);
}

export async function eventMac(token: string, nonce: string, seq: number, name: string, data: string): Promise<string> {
  return hmac(token, ["unbrowse/event/v1", nonce, String(seq), name, data]);
}

/** Two hex strings compared whole, without stopping at the first difference. */
export function sameHex(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
}

/** The headers that sign a request, and the nonce its answer is signed over. */
export async function signRequest(token: string, method: string, url: string, body: Uint8Array): Promise<{ headers: Record<string, string>; nonce: string }> {
  const { authority, target } = addressOf(url);
  const nonce = hex(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const time = Math.floor(Date.now() / 1000);
  return {
    nonce,
    headers: {
      "x-unbrowse-key": tokenKey(token),
      "x-unbrowse-time": String(time),
      "x-unbrowse-nonce": nonce,
      "x-unbrowse-signature": await requestMac(token, method, authority, target, body, time, nonce),
    },
  };
}

/** Whether an answer is the node's to the request that carried `nonce`. `hash` is `bodyHash` of its body, or `STREAM`. */
export async function answerIsTheNodes(token: string, status: number, headers: Headers, hash: string, nonce: string): Promise<boolean> {
  const theirs = headers.get("x-unbrowse-reply");
  return !!theirs && sameHex(await replyMac(token, status, hash, nonce), theirs);
}

/** What a request to `url` is signed over: the authority it goes to (`host:port`, lower case, the port always written)
 * and the path and query it sends. */
export function addressOf(url: string): { authority: string; target: string } {
  const base = (globalThis as { location?: { href?: string } }).location?.href ?? "http://localhost/";
  const u = new URL(url, base);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return { authority: `${u.hostname.toLowerCase()}:${port}`, target: u.pathname + u.search };
}
