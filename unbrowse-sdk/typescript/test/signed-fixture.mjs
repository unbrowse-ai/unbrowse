// The node's signed door, for the fake nodes: `signing(handler, tokens)` is a request listener that takes a request
// signed with one of `tokens` (checking it as the node does, each nonce once), hands `handler` the request with the
// token where the node's handlers read it (`authorization`), and signs what `handler` answers: its status and body, or
// for an event stream each event with its place. A request that isn't signed goes to `handler` as it is. Not a test
// file. Written apart from the SDK's code (node:crypto, not WebCrypto), so the tests check one against the other.
import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { tokenKey } from "../dist/proof.js";

const mac = (token, parts) => createHmac("sha256", token).update(parts.join("\n")).digest("hex");
export const bodyHash = (b) => createHash("sha256").update(b).digest("hex");
export const requestMac = (token, method, authority, target, body, time, nonce) => mac(token, ["unbrowse/request/v2", method.toUpperCase(), authority.toLowerCase(), target, bodyHash(body), String(time), nonce]);
export const replyMac = (token, status, hash, nonce) => mac(token, ["unbrowse/reply/v1", String(status), hash, nonce]);
export const eventMac = (token, nonce, seq, name, data) => mac(token, ["unbrowse/event/v1", nonce, String(seq), name, data]);

export function signing(handler, tokens) {
  const seen = new Set();
  return (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const key = req.headers["x-unbrowse-key"];
      const fresh = Object.assign(Readable.from(body.length ? [body] : []), { url: req.url, method: req.method, headers: { ...req.headers }, socket: req.socket });
      if (!key) return handler(fresh, res);
      const token = tokens().find((t) => tokenKey(t) === key);
      const { "x-unbrowse-time": time, "x-unbrowse-nonce": nonce, "x-unbrowse-signature": sig } = req.headers;
      const good = token && sig === requestMac(token, req.method, req.headers.host ?? "", req.url, body, time, nonce) && Math.abs(Date.now() / 1000 - Number(time)) <= 60 && !seen.has(nonce);
      if (!good) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "the request's signature doesn't match it" }));
      }
      seen.add(nonce);
      fresh.headers.authorization = `Bearer ${token}`;
      signAnswer(res, token, nonce);
      handler(fresh, res);
    });
  };
}

/** Holds what `res` is told until it ends (or, for an event stream, signs each event as it goes), then signs it. */
function signAnswer(res, token, nonce) {
  const { setHeader, write, end, writeHead } = { setHeader: res.setHeader.bind(res), write: res.write.bind(res), end: res.end.bind(res), writeHead: res.writeHead.bind(res) };
  // Node sends the head through `writeHead` (from `end`, `write` or `flushHeaders`): held until the signature is set.
  let ready = false;
  const held = [];
  let stream = false;
  let started = false;
  let pending = "";
  let seq = 0;
  const startStream = () => {
    if (started) return;
    started = true;
    setHeader("x-unbrowse-reply", replyMac(token, res.statusCode, "event-stream", nonce));
    ready = true;
  };
  const signEvents = (text) => {
    pending += text;
    let out = "";
    let at;
    // Blocks end at a blank line in either line ending; each goes out as it came, with its id added.
    while ((at = /\r?\n\r?\n/.exec(pending))) {
      const block = pending.slice(0, at.index);
      pending = pending.slice(at.index + at[0].length);
      const lines = block.split(/\r?\n/);
      const name = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
      const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      out += lines.some((l) => l.startsWith("data:")) ? `${block}\nid: ${seq}.${eventMac(token, nonce, seq++, name, data)}\n\n` : `${block}\n\n`;
    }
    return out;
  };
  // For a test standing in for a process between the node and the client: bytes the node didn't sign.
  res.writeUnsigned = (chunk) => write(chunk);
  res.writeHead = (status, ...rest) => {
    if (ready) return writeHead(status, ...rest);
    res.statusCode = status;
    const h = rest.find((x) => x && typeof x === "object");
    for (const [k, v] of Object.entries(h ?? {})) setHeader(k, v);
    stream = String(res.getHeader("content-type") ?? "").startsWith("text/event-stream");
    // Signed before anything can send the head (`flushHeaders`, as axum opens a stream before its first event).
    if (stream) startStream();
    return res;
  };
  res.write = (chunk, ...rest) => {
    stream ||= String(res.getHeader("content-type") ?? "").startsWith("text/event-stream");
    if (stream) {
      startStream();
      return write(signEvents(Buffer.from(chunk).toString()), ...rest.filter((x) => typeof x === "function"));
    }
    held.push(Buffer.from(chunk));
    return true;
  };
  res.end = (chunk, ...rest) => {
    if (chunk && typeof chunk !== "function") held.push(Buffer.from(chunk));
    if (stream) {
      startStream();
      return end(signEvents(Buffer.concat(held).toString()));
    }
    const body = Buffer.concat(held);
    setHeader("x-unbrowse-reply", replyMac(token, res.statusCode, bodyHash(body), nonce));
    ready = true;
    return end(body);
  };
}
