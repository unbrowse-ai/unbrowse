//! The signing bridge's runtime: the page's own scripts, run again in a JS sandbox, signing the request.
//!
//! A route with a [`Class::Script`](crate::graph::Class::Script) field asks its transport for the value
//! ([`crate::replay::Fetch::sign_request`]). This is one bridge: it boots the captured scripts against the route's
//! page (with the caller's inputs in the URL, where the page reads what it was asked), lets the page's own code build
//! and sign its call, and reads back the request it would have sent. The headers it set are the answer.
//!
//! Nothing here knows a site. A bundle is scripts; a page is a URL; a signature is whatever the scripts write onto the
//! request they make. Sites whose code needs no more than the environment shimmed here work; one that needs more gets
//! it in the shim, never in a per-site branch.
//!
//! The runtime is a program, like the browser: `SIGNING_PROGRAM` (default `node`), run with the harness below and the
//! bundle on disk. A machine without one answers `None`, and the call goes to the browser as it always did.

use std::collections::HashMap;
use std::io::BufRead;
use std::process::{Command, Stdio};

use crate::replay::Request;

/// What the page had in front of it when it signed: the two storages, carried on the session ([`crate::mint`] reads
/// them at mint time). A bundle that keeps its signing key or a nonce there reads it here, where it is put back.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Storage {
    #[serde(default)]
    pub local: HashMap<String, String>,
    #[serde(default)]
    pub session: HashMap<String, String>,
}

/// How long the page's scripts get to boot and make their call, in milliseconds.
const SETTLE_MS: u64 = 2_000;

/// How long the page's scripts are given to boot before the sandbox reads what they made: the constant, or
/// `UNBROWSE_SIGN_SETTLE_MS` for a page whose bundle is slow to reach its call (measured, not guessed by site).
pub(crate) fn settle_ms() -> u64 {
    std::env::var("UNBROWSE_SIGN_SETTLE_MS").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(SETTLE_MS)
}

/// How long one script may run, in milliseconds: `UNBROWSE_SIGN_SCRIPT_MS`, else two seconds, never longer than the
/// settle window. A script that hangs (a third party's SDK, an ad tag) is cut at this, and the page's own boot goes on:
/// it is not allowed to eat the window the call needs.
fn script_ms() -> u64 {
    std::env::var("UNBROWSE_SIGN_SCRIPT_MS").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(2_000)
}

/// The scripts a walk captured, in the order the page loaded them: (url, body).
pub type Bundle = Vec<(String, String)>;

/// The host side of a run: the only code that holds the runtime's own objects. It builds the realm the shim and the
/// page run in and hands the shim a few functions that take and give back plain values ([`PRELUDE`]).
const BOOT: &str = r#"'use strict';
// The host side of the sandbox, the only code here that holds the runtime's own objects. It reads the files it was
// started with, builds a realm that holds nothing of the runtime's (`DONT_CONTEXTIFY`: a fresh global, its own
// builtins), and runs the shim there, handing it a handful of functions that take and give back only strings,
// numbers and the realm's own values. Nothing the page can reach leads back here: every error a host function would
// throw is re-made in the realm before it crosses, and nothing host-made is ever returned.
const fs = require('fs');
const vm = require('vm');
const nodeCrypto = require('crypto');
const [shimPath, specPath, inputPath] = process.argv.slice(2);
const shimText = fs.readFileSync(shimPath, 'utf8');
const specText = fs.readFileSync(specPath, 'utf8');
const inputText = fs.readFileSync(inputPath, 'utf8');
let debug = false;
try { debug = !!JSON.parse(specText).debug; } catch (e) {}
const OUT_MAX = 64 << 20;
const line = (v) => { try { process.stdout.write(JSON.stringify(v) + '\n'); } catch (e) {} };
const noImport = () => { throw realmError('Error', 'import() is not available in the sandbox'); };
const realm = vm.createContext(vm.constants.DONT_CONTEXTIFY, { importModuleDynamically: async () => noImport() });
const Made = {};
for (const n of ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'Promise']) Made[n] = vm.runInContext(n, realm);
function realmError(name, message, stack) {
  const C = Made[name] || Made.Error;
  const e = new C(String(message));
  if (stack) { try { e.stack = String(stack); } catch (x) {} }
  return e;
}
// A value thrown inside a host function is the runtime's own when it is one of its objects: it is re-made in the realm
// from its words alone. A value the page or the shim threw is theirs already, and goes back as it came.
function inRealm(e) {
  if (e !== null && (typeof e === 'object' || typeof e === 'function') && e instanceof Object) {
    let name = 'Error', message = '', stack = '';
    try { name = String(e.name || 'Error'); } catch (x) {}
    try { message = String(e.message || ''); } catch (x) {}
    try { stack = String(e.stack || ''); } catch (x) {}
    return realmError(name, message, stack);
  }
  return e;
}
const guard = (f) => function () { try { return f.apply(undefined, arguments); } catch (e) { throw inRealm(e); } };
const handlers = { uncaughtException: null, unhandledRejection: null };
process.on('uncaughtException', (e) => { const f = handlers.uncaughtException; if (typeof f === 'function') { try { f(inRealm(e)); } catch (x) {} } });
process.on('unhandledRejection', (e) => { const f = handlers.unhandledRejection; if (typeof f === 'function') { try { f(inRealm(e)); } catch (x) {} } });
let out = '';
const timers = new Map();
let timerIds = 0;
const contexts = new WeakSet();
const modules = new Map();
let moduleIds = 0;
// A module's identifier, as a string, or '' where there is none: all the shim learns of the host's module object.
const identifierOf = (m) => { try { return String((m && m.identifier) || ''); } catch (e) { return ''; } };
const moduleOf = (w) => { let id = 0; try { id = Number(w && w._ubModule); } catch (e) {} return modules.get(id); };
const pending = new Map();
let netIds = 0;
let inbuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  inbuf += d;
  let i;
  while ((i = inbuf.indexOf('\n')) >= 0) {
    const text = inbuf.slice(0, i);
    inbuf = inbuf.slice(i + 1);
    let id = 0;
    try { id = Number(JSON.parse(text).id); } catch (e) {}
    const cb = pending.get(id);
    if (cb) { pending.delete(id); try { cb(text); } catch (e) { const f = handlers.uncaughtException; if (typeof f === 'function') { try { f(inRealm(e)); } catch (x) {} } } }
  }
});
process.stdin.on('error', () => {});
const keyTable = new Map();
let keyIds = 0;
const fromWire = (v) => {
  if (Array.isArray(v)) return v.map(fromWire);
  if (v && typeof v === 'object') {
    if (typeof v.$b === 'string') return Buffer.from(v.$b, 'base64');
    if (typeof v.$k === 'number') { const k = keyTable.get(v.$k); if (!k) throw new TypeError('not a key of this sandbox'); return k; }
    const o = {};
    for (const k of Object.keys(v)) o[k] = fromWire(v[k]);
    return o;
  }
  return v;
};
const toWire = (v) => {
  if (v instanceof ArrayBuffer) return { $b: Buffer.from(v).toString('base64') };
  if (ArrayBuffer.isView(v)) return { $b: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  if (v instanceof nodeCrypto.webcrypto.CryptoKey) {
    const id = ++keyIds;
    keyTable.set(id, v);
    return { $k: id, type: v.type, extractable: v.extractable, algorithm: JSON.parse(JSON.stringify(v.algorithm, (k, x) => (ArrayBuffer.isView(x) ? Array.from(x) : x))), usages: Array.from(v.usages) };
  }
  if (Array.isArray(v)) return v.map(toWire);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = toWire(v[k]); return o; }
  return v;
};
const URL_PARTS = ['href', 'origin', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];
const urlParts = (u) => JSON.stringify(URL_PARTS.reduce((o, k) => { o[k] = u[k]; return o; }, {}));
const H = Object.create(null);
Object.assign(H, {
  spec: specText,
  input: inputText,
  debug,
  ready: guard(() => { line({ t: 'ready' }); }),
  log: guard((s) => { if (debug) { try { process.stderr.write(String(s)); } catch (e) {} } }),
  out: guard((s) => { if (out.length < OUT_MAX) out += String(s); }),
  exit: guard(() => { line({ t: 'done', out }); process.exit(0); }),
  on: guard((ev, f) => { if (ev in handlers) handlers[ev] = f; }),
  timer: guard((cb, ms) => {
    const id = ++timerIds;
    timers.set(id, setTimeout(() => { timers.delete(id); cb(); }, Math.max(0, Math.min(Number(ms) || 0, 2147483647))));
    return id;
  }),
  untimer: guard((id) => { const t = timers.get(Number(id)); if (t) { clearTimeout(t); timers.delete(Number(id)); } }),
  contextify: guard((o) => {
    if (contexts.has(o)) return;
    vm.createContext(o, { importModuleDynamically: async () => noImport() });
    contexts.add(o);
  }),
  run: guard((o, src, filename, timeout) => {
    const opts = { filename: String(filename || 'evalmachine'), importModuleDynamically: async () => noImport() };
    if (Number(timeout) > 0) opts.timeout = Number(timeout);
    return vm.runInContext(String(src), o, opts);
  }),
  module: guard((src, identifier, context, initMeta, dynamic, wrapper) => {
    const id = ++moduleIds;
    const mod = new vm.SourceTextModule(String(src), {
      identifier: String(identifier || ('module:' + id)),
      context,
      initializeImportMeta: (meta) => { if (typeof initMeta === 'function') initMeta(meta); },
      // The module that asked is named to the shim by its identifier, a string: the host's module object never
      // crosses into the realm.
      importModuleDynamically: async (specifier, referrer) => {
        if (typeof dynamic !== 'function') noImport();
        let w;
        try { w = await dynamic(String(specifier), identifierOf(referrer)); } catch (e) { throw inRealm(e); }
        const m = moduleOf(w);
        if (!m) throw realmError('Error', 'import: ' + String(specifier));
        return m;
      },
    });
    modules.set(id, mod);
    return id;
  }),
  namespace: guard((id) => { const m = modules.get(Number(id)); return m ? m.namespace : undefined; }),
  link: guard((id, resolver, ok, fail) => {
    const m = modules.get(Number(id));
    if (!m) { fail(realmError('Error', 'no such module')); return; }
    m.link(async (specifier, referencing) => {
      let w;
      try { w = await resolver(String(specifier), identifierOf(referencing)); } catch (e) { throw inRealm(e); }
      const dep = moduleOf(w);
      if (!dep) throw realmError('Error', 'import: ' + String(specifier));
      return dep;
    }).then(() => ok(), (e) => fail(inRealm(e)));
  }),
  evaluate: guard((id, ok, fail) => {
    const m = modules.get(Number(id));
    if (!m) { fail(realmError('Error', 'no such module')); return; }
    m.evaluate().then(() => ok(), (e) => fail(inRealm(e)));
  }),
  bridge: guard((request, cb) => {
    const id = ++netIds;
    pending.set(id, cb);
    line({ t: 'net', id, req: JSON.parse(String(request)) });
  }),
  url: guard((input, base) => { try { return urlParts(base == null ? new URL(String(input)) : new URL(String(input), String(base))); } catch (e) { return ''; } }),
  urlSet: guard((href, field, value) => {
    if (['protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'href'].indexOf(String(field)) < 0) return '';
    try { const u = new URL(String(href)); u[String(field)] = String(value); return urlParts(u); } catch (e) { return ''; }
  }),
  random: guard((n) => nodeCrypto.randomBytes(Math.max(0, Math.min(Number(n) || 0, 65536))).toString('base64')),
  uuid: guard(() => nodeCrypto.randomUUID()),
  hash: guard((alg, data, key) => {
    try {
      const h = key == null ? nodeCrypto.createHash(String(alg)) : nodeCrypto.createHmac(String(alg), Buffer.from(String(key), 'base64'));
      return h.update(Buffer.from(String(data), 'base64')).digest('base64');
    } catch (e) { return null; }
  }),
  subtle: guard((method, args, cb) => {
    const m = String(method);
    if (['digest', 'importKey', 'exportKey', 'sign', 'verify', 'encrypt', 'decrypt', 'generateKey', 'deriveBits', 'deriveKey', 'wrapKey', 'unwrapKey'].indexOf(m) < 0) { cb(false, 'NotSupportedError'); return; }
    let p;
    try { p = nodeCrypto.webcrypto.subtle[m](...fromWire(JSON.parse(String(args)))); } catch (e) { cb(false, String((e && e.name) || 'Error') + ': ' + String((e && e.message) || '')); return; }
    Promise.resolve(p).then((r) => { let s; try { s = JSON.stringify(toWire(r)); } catch (e) { cb(false, 'Error: ' + String(e && e.message)); return; } cb(true, s === undefined ? 'null' : s); },
      (e) => cb(false, String((e && e.name) || 'Error') + ': ' + String((e && e.message) || '')));
  }),
});
Object.freeze(H);
const start = vm.runInContext(shimText, realm, { filename: 'unbrowse-shim.js', importModuleDynamically: async () => noImport() });
start(H);
"#;

/// The platform the shim and the page see, made inside their realm: the shim's first lines, before a harness.
const PRELUDE: &str = r#"// The platform the shim and the page run on, made in this realm from plain values: a timer is a number, a URL is
// parsed by the runtime and handed back as its parts, a hash is computed there and handed back as base64. No object
// of the runtime's crosses; what crosses is a string, a number, or a function of this realm called back.
const process = {
  env: H.debug ? { UNBROWSE_SIGN_DEBUG: '1' } : {},
  stderr: { write: (s) => { H.log(String(s)); return true; } },
  stdout: { write: (s) => { H.out(String(s)); return true; } },
  exit: () => H.exit(),
  on: (ev, f) => { H.on(String(ev), f); },
};
const setTimeout = (f, ms, ...args) => H.timer(() => { if (typeof f === 'function') f(...args); }, ms);
const clearTimeout = (id) => { if (typeof id === 'number') H.untimer(id); };
const setInterval = (f, ms, ...args) => {
  const box = { id: 0 };
  const tick = () => { box.id = setTimeout(tick, Math.max(1, Number(ms) || 0)); if (typeof f === 'function') f(...args); };
  box.id = setTimeout(tick, Math.max(1, Number(ms) || 0));
  return box;
};
const clearInterval = (b) => { if (b && typeof b.id === 'number') H.untimer(b.id); };
const queueMicrotask = (f) => { Promise.resolve().then(() => f()); };
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const toB64 = (bytes) => {
  let s = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) { const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]; s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]; }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
    s += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + '=';
  }
  return s;
};
const fromB64 = (text) => {
  const s = String(text).replace(/[\s=]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0, acc = 0, o = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64.indexOf(s[i]);
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return out.subarray(0, o);
};
const utf8 = (str) => {
  const s = String(str);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; } else c = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
};
// UTF-8 bytes as text; `rest` is a sequence a stream left unfinished, handed back for the next chunk.
const fromUtf8 = (bytes, keep) => {
  let s = '';
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    let need = b < 0x80 ? 0 : b >= 0xf0 && b < 0xf8 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : -1;
    if (need < 0) { s += '�'; i++; continue; }
    if (i + need >= n && need > 0 && keep) return { text: s, rest: bytes.slice(i) };
    let c = need === 0 ? b : b & (0x3f >> need);
    let ok = true;
    for (let k = 1; k <= need; k++) { const x = bytes[i + k]; if (x === undefined || (x & 0xc0) !== 0x80) { ok = false; break; } c = (c << 6) | (x & 63); }
    if (!ok) { s += '�'; i++; continue; }
    i += need + 1;
    if (c >= 0x10000) { c -= 0x10000; s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023)); } else s += String.fromCharCode(c);
  }
  return { text: s, rest: null };
};
const bytesOf = (v) => {
  if (v == null) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'object' && typeof v.byteLength === 'number' && typeof v.slice === 'function' && Object.prototype.toString.call(v) === '[object ArrayBuffer]') return new Uint8Array(v);
  return utf8(String(v));
};
class TextEncoder {
  get encoding() { return 'utf-8'; }
  encode(s) { return utf8(s === undefined ? '' : s); }
  encodeInto(s, dest) { const b = utf8(s); const n = Math.min(b.length, dest.length); dest.set(b.subarray(0, n)); return { read: String(s).length, written: n }; }
}
class TextDecoder {
  constructor(label, opts) { const l = String(label || 'utf-8').toLowerCase(); this._latin = /latin1|iso-8859-1|windows-1252|ascii/.test(l); this._rest = null; this.fatal = !!(opts && opts.fatal); this.ignoreBOM = !!(opts && opts.ignoreBOM); }
  get encoding() { return this._latin ? 'windows-1252' : 'utf-8'; }
  decode(input, opts) {
    let bytes = bytesOf(input === undefined ? new Uint8Array(0) : input);
    if (this._latin) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s; }
    if (this._rest) { const m = new Uint8Array(this._rest.length + bytes.length); m.set(this._rest); m.set(bytes, this._rest.length); bytes = m; this._rest = null; }
    const r = fromUtf8(bytes, !!(opts && opts.stream));
    this._rest = r.rest;
    let t = r.text;
    if (!this.ignoreBOM && t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return t;
  }
}
const domError = (name, message) => { const e = new Error(String(message)); e.name = name; return e; };
const btoa = (s) => {
  const t = String(s);
  const b = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (c > 255) throw domError('InvalidCharacterError', 'The string to be encoded contains characters outside of the Latin1 range.'); b[i] = c; }
  return toB64(b);
};
const atob = (s) => {
  const t = String(s).replace(/[\t\n\f\r ]/g, '');
  if (/[^A-Za-z0-9+/=]/.test(t) || t.length % 4 === 1) throw domError('InvalidCharacterError', 'The string to be decoded is not correctly encoded.');
  const b = fromB64(t);
  let out = '';
  for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i]);
  return out;
};
const HEX = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; };
const fromHex = (s) => { const t = String(s); const out = new Uint8Array(t.length >> 1); for (let i = 0; i < out.length; i++) { const v = parseInt(t.substr(i * 2, 2), 16); if (Number.isNaN(v)) return out.subarray(0, i); out[i] = v; } return out; };
const latin = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const fromLatin = (s) => { const t = String(s); const b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i) & 255; return b; };
const encode = (s, enc) => {
  switch (String(enc || 'utf8').toLowerCase()) {
    case 'hex': return fromHex(s);
    case 'base64': case 'base64url': return fromB64(s);
    case 'latin1': case 'binary': case 'ascii': return fromLatin(s);
    default: return utf8(s);
  }
};
const decode = (b, enc) => {
  switch (String(enc || 'utf8').toLowerCase()) {
    case 'hex': return HEX(b);
    case 'base64': return toB64(b);
    case 'base64url': return toB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    case 'latin1': case 'binary': return latin(b);
    case 'ascii': return latin(b.map((x) => x & 127));
    default: return fromUtf8(b, false).text;
  }
};
// A byte buffer with the encodings a producer reaches for. The page's own browser has none; a generated program and a
// copied module may.
class Buffer extends Uint8Array {
  static from(v, enc, len) {
    if (typeof v === 'string') { const b = encode(v, enc); const out = new Buffer(b.length); out.set(b); return out; }
    if (v instanceof ArrayBuffer) return new Buffer(v, enc || 0, len === undefined ? v.byteLength - (enc || 0) : len);
    const b = Array.isArray(v) ? v : bytesOf(v);
    const out = new Buffer(b.length);
    for (let i = 0; i < b.length; i++) out[i] = b[i] & 255;
    return out;
  }
  static alloc(n, fill) { const b = new Buffer(Math.max(0, Number(n) || 0)); if (fill !== undefined) b.fill(typeof fill === 'string' ? fill.charCodeAt(0) : fill); return b; }
  static allocUnsafe(n) { return new Buffer(Math.max(0, Number(n) || 0)); }
  static isBuffer(x) { return x instanceof Buffer; }
  static byteLength(s, enc) { return typeof s === 'string' ? encode(s, enc).length : bytesOf(s).length; }
  static concat(list, total) {
    const n = total === undefined ? list.reduce((a, b) => a + b.length, 0) : total;
    const out = new Buffer(n);
    let o = 0;
    for (const b of list) { if (o >= n) break; out.set(bytesOf(b).subarray(0, n - o), o); o += b.length; }
    return out;
  }
  toString(enc, start, end) { return decode(this.subarray(start || 0, end === undefined ? this.length : end), enc); }
  equals(o) { const b = bytesOf(o); if (b.length !== this.length) return false; for (let i = 0; i < b.length; i++) if (b[i] !== this[i]) return false; return true; }
  toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
  write(s, offset, enc) { const b = encode(s, enc); this.set(b.subarray(0, this.length - (offset || 0)), offset || 0); return Math.min(b.length, this.length - (offset || 0)); }
  readUInt32BE(o) { o = o || 0; return ((this[o] << 24) >>> 0) + (this[o + 1] << 16) + (this[o + 2] << 8) + this[o + 3]; }
  writeUInt32BE(v, o) { o = o || 0; this[o] = (v >>> 24) & 255; this[o + 1] = (v >>> 16) & 255; this[o + 2] = (v >>> 8) & 255; this[o + 3] = v & 255; return o + 4; }
}
// A hash or an HMAC, fed in pieces and computed by the runtime over the bytes when it is read.
const hasher = (alg, key) => {
  const parts = [];
  const self = {
    update(data, enc) { parts.push(typeof data === 'string' ? encode(data, enc) : bytesOf(data)); return self; },
    digest(enc) {
      const all = Buffer.concat(parts);
      const said = H.hash(String(alg), toB64(all), key == null ? null : toB64(key));
      if (said == null) throw new Error('Digest method not supported');
      const b = Buffer.from(fromB64(said));
      return enc ? b.toString(enc) : b;
    },
    copy() { const c = hasher(alg, key); for (const p of parts) c.update(p); return c; },
  };
  return self;
};
const createHash = (alg) => hasher(alg, null);
const createHmac = (alg, key) => hasher(alg, typeof key === 'string' ? utf8(key) : bytesOf(key));
// WebCrypto: the runtime computes, keyed by handles this realm holds. A key is a plain object here; which runtime key it
// names stays on the other side.
const keyIds = new WeakMap();
class CryptoKey {}
const wire = (v) => {
  if (v instanceof CryptoKey) return { $k: keyIds.get(v) };
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { $b: toB64(bytesOf(v)) };
  if (Array.isArray(v)) return v.map(wire);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = wire(v[k]); return o; }
  return v;
};
const unwire = (v) => {
  if (Array.isArray(v)) return v.map(unwire);
  if (v && typeof v === 'object') {
    if (typeof v.$b === 'string') { const b = fromB64(v.$b); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    if (typeof v.$k === 'number') { const k = new CryptoKey(); keyIds.set(k, v.$k); k.type = v.type; k.extractable = v.extractable; k.algorithm = v.algorithm; k.usages = v.usages; return k; }
    const o = {};
    for (const k of Object.keys(v)) o[k] = unwire(v[k]);
    return o;
  }
  return v;
};
const subtle = {};
for (const m of ['digest', 'importKey', 'exportKey', 'sign', 'verify', 'encrypt', 'decrypt', 'generateKey', 'deriveBits', 'deriveKey', 'wrapKey', 'unwrapKey']) {
  subtle[m] = (...args) => new Promise((resolve, reject) => {
    let text;
    try { text = JSON.stringify(wire(args)); } catch (e) { reject(e); return; }
    H.subtle(m, text, (ok, said) => {
      if (!ok) { const i = String(said).indexOf(': '); reject(domError(i > 0 ? said.slice(0, i) : 'OperationError', i > 0 ? said.slice(i + 2) : said)); return; }
      try { resolve(unwire(JSON.parse(said))); } catch (e) { reject(e); }
    });
  });
}
const getRandomValues = (a) => {
  const b = bytesOf(a);
  if (b.length > 65536) throw domError('QuotaExceededError', 'getRandomValues takes at most 65536 bytes');
  b.set(fromB64(H.random(b.length)));
  return a;
};
const webCrypto = { getRandomValues, randomUUID: () => H.uuid(), subtle, createHash, createHmac };
// The address types: the runtime parses, this realm holds the parts.
const formEncode = (s) => encodeURIComponent(String(s)).replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+');
const formDecode = (s) => { const t = String(s).replace(/\+/g, ' '); try { return decodeURIComponent(t); } catch (e) { return t.replace(/%([0-9a-fA-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))); } };
class URLSearchParams {
  constructor(init) {
    this._list = [];
    this._url = null;
    if (init == null) return;
    if (typeof init === 'string') this._parse(init);
    else if (init instanceof URLSearchParams) this._list = init._list.map((p) => p.slice());
    else if (typeof init === 'object' && typeof init[Symbol.iterator] === 'function') { for (const p of init) this._list.push([String(p[0]), String(p[1])]); }
    else if (typeof init === 'object') { for (const k of Object.keys(init)) this._list.push([k, String(init[k])]); }
    else this._parse(String(init));
  }
  _parse(s) { this._list = []; const t = String(s).replace(/^\?/, ''); if (!t) return; for (const part of t.split('&')) { if (!part) continue; const i = part.indexOf('='); this._list.push(i < 0 ? [formDecode(part), ''] : [formDecode(part.slice(0, i)), formDecode(part.slice(i + 1))]); } }
  _changed() { if (this._url) this._url._setSearch(this.toString()); }
  get size() { return this._list.length; }
  append(k, v) { this._list.push([String(k), String(v)]); this._changed(); }
  delete(k, v) { this._list = this._list.filter((p) => !(p[0] === String(k) && (v === undefined || p[1] === String(v)))); this._changed(); }
  get(k) { const p = this._list.find((x) => x[0] === String(k)); return p ? p[1] : null; }
  getAll(k) { return this._list.filter((x) => x[0] === String(k)).map((x) => x[1]); }
  has(k, v) { return this._list.some((x) => x[0] === String(k) && (v === undefined || x[1] === String(v))); }
  set(k, v) { const key = String(k); const i = this._list.findIndex((x) => x[0] === key); if (i < 0) this._list.push([key, String(v)]); else { this._list[i] = [key, String(v)]; this._list = this._list.filter((x, j) => j <= i || x[0] !== key); } this._changed(); }
  sort() { this._list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this._changed(); }
  forEach(f, that) { for (const [k, v] of this._list) f.call(that, v, k, this); }
  keys() { return this._list.map((p) => p[0])[Symbol.iterator](); }
  values() { return this._list.map((p) => p[1])[Symbol.iterator](); }
  entries() { return this._list.map((p) => p.slice())[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  toString() { return this._list.map(([k, v]) => formEncode(k) + '=' + formEncode(v)).join('&'); }
}
const URL_FIELDS = ['href', 'origin', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];
class URL {
  constructor(input, base) {
    const said = H.url(String(input && input.href !== undefined ? input.href : input), base === undefined ? null : String(base && base.href !== undefined ? base.href : base));
    if (!said) throw new TypeError('Invalid URL: ' + String(input));
    this._take(said);
  }
  static canParse(input, base) { return !!H.url(String(input), base === undefined ? null : String(base)); }
  static parse(input, base) { try { return new URL(input, base); } catch (e) { return null; } }
  static createObjectURL() { return 'blob:null/' + H.uuid(); }
  static revokeObjectURL() {}
  _take(said) {
    const p = JSON.parse(said);
    this._p = p;
    if (!this._params) { this._params = new URLSearchParams(p.search); this._params._url = this; } else this._params._parse(p.search);
  }
  _set(field, value) { const said = H.urlSet(this._p.href, field, String(value)); if (said) this._take(said); else if (field === 'href') throw new TypeError('Invalid URL: ' + String(value)); }
  _setSearch(s) { const said = H.urlSet(this._p.href, 'search', s); if (said) this._p = JSON.parse(said); }
  get searchParams() { return this._params; }
  toString() { return this._p.href; }
  toJSON() { return this._p.href; }
}
for (const f of URL_FIELDS) {
  Object.defineProperty(URL.prototype, f, {
    configurable: true, enumerable: true,
    get() { return this._p[f]; },
    set: f === 'origin' ? undefined : function (v) { this._set(f, v); },
  });
}
// A body as a stream: one chunk, or the chunks a source enqueues. Enough for a page that reads a response with a reader.
class ReadableStream {
  constructor(source) {
    this._q = []; this._done = false; this._err = null; this._waiting = []; this.locked = false;
    const self = this;
    const wake = () => { while (self._waiting.length && (self._q.length || self._done || self._err)) { const w = self._waiting.shift(); if (self._err) w.reject(self._err); else if (self._q.length) w.resolve({ value: self._q.shift(), done: false }); else w.resolve({ value: undefined, done: true }); } };
    this._wake = wake;
    const controller = { enqueue: (c) => { self._q.push(c); wake(); }, close: () => { self._done = true; wake(); }, error: (e) => { self._err = e; wake(); }, desiredSize: 1 };
    try { if (source && typeof source.start === 'function') source.start(controller); } catch (e) { this._err = e; }
    this._pull = source && typeof source.pull === 'function' ? () => source.pull(controller) : null;
  }
  getReader() {
    this.locked = true;
    const self = this;
    return {
      read() { return new Promise((resolve, reject) => { self._waiting.push({ resolve, reject }); self._wake(); if (self._pull && !self._q.length && !self._done) { try { self._pull(); } catch (e) { reject(e); } } }); },
      releaseLock() { self.locked = false; },
      cancel() { self._done = true; self._q = []; self._wake(); return Promise.resolve(); },
      get closed() { return Promise.resolve(); },
    };
  }
  cancel() { this._done = true; this._q = []; this._wake(); return Promise.resolve(); }
  pipeThrough(t) { return (t && t.readable) || this; }
  pipeTo() { return Promise.resolve(); }
  tee() { return [this, this]; }
  async *[Symbol.asyncIterator]() { const r = this.getReader(); for (;;) { const { value, done } = await r.read(); if (done) return; yield value; } }
}
class Headers {
  constructor(init) {
    this._m = new Map();
    if (!init) return;
    if (typeof init.forEach === 'function' && !Array.isArray(init)) init.forEach((v, k) => this.append(k, v));
    else if (Array.isArray(init)) { for (const [k, v] of init) this.append(k, v); }
    else { for (const k of Object.keys(init)) this.append(k, init[k]); }
  }
  append(k, v) { const n = String(k).toLowerCase(); this._m.set(n, this._m.has(n) ? this._m.get(n) + ', ' + String(v) : String(v)); }
  set(k, v) { this._m.set(String(k).toLowerCase(), String(v)); }
  get(k) { const n = String(k).toLowerCase(); return this._m.has(n) ? this._m.get(n) : null; }
  has(k) { return this._m.has(String(k).toLowerCase()); }
  delete(k) { this._m.delete(String(k).toLowerCase()); }
  forEach(f, that) { for (const [k, v] of this._m) f.call(that, v, k, this); }
  keys() { return this._m.keys(); }
  values() { return this._m.values(); }
  entries() { return this._m.entries(); }
  getSetCookie() { return []; }
  [Symbol.iterator]() { return this._m.entries(); }
}
class Blob {
  constructor(parts, opts) {
    const bytes = [];
    for (const p of parts || []) bytes.push(p instanceof Blob ? p._b : bytesOf(p));
    const n = bytes.reduce((a, b) => a + b.length, 0);
    this._b = new Uint8Array(n);
    let o = 0;
    for (const b of bytes) { this._b.set(b, o); o += b.length; }
    this.type = String((opts && opts.type) || '').toLowerCase();
  }
  get size() { return this._b.length; }
  text() { return Promise.resolve(fromUtf8(this._b, false).text); }
  arrayBuffer() { return Promise.resolve(this._b.slice().buffer); }
  bytes() { return Promise.resolve(this._b.slice()); }
  slice(a, b, type) { const x = new Blob([], { type }); x._b = this._b.slice(a || 0, b === undefined ? this._b.length : b); return x; }
  stream() { const b = this._b; return new ReadableStream({ start(c) { c.enqueue(b); c.close(); } }); }
}
class File extends Blob {
  constructor(parts, name, opts) { super(parts, opts); this.name = String(name); this.lastModified = (opts && opts.lastModified) || Date.now(); }
}
class FormData {
  constructor() { this._list = []; }
  append(k, v) { this._list.push([String(k), v]); }
  set(k, v) { this.delete(k); this.append(k, v); }
  get(k) { const p = this._list.find((x) => x[0] === String(k)); return p ? p[1] : null; }
  getAll(k) { return this._list.filter((x) => x[0] === String(k)).map((x) => x[1]); }
  has(k) { return this._list.some((x) => x[0] === String(k)); }
  delete(k) { this._list = this._list.filter((x) => x[0] !== String(k)); }
  forEach(f, that) { for (const [k, v] of this._list) f.call(that, v, k, this); }
  entries() { return this._list.map((p) => p.slice())[Symbol.iterator](); }
  keys() { return this._list.map((p) => p[0])[Symbol.iterator](); }
  values() { return this._list.map((p) => p[1])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
}
const bodyText = (b) => (b == null ? '' : typeof b === 'string' ? b : b instanceof Blob ? fromUtf8(b._b, false).text : b instanceof URLSearchParams ? b.toString() : (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) ? fromUtf8(bytesOf(b), false).text : String(b));
class Request {
  constructor(input, init) {
    init = init || {};
    const from = input instanceof Request ? input : null;
    this.url = from ? from.url : String(input && input.href !== undefined ? input.href : input);
    this.method = String(init.method || (from && from.method) || 'GET').toUpperCase();
    this.headers = new Headers(init.headers || (from && from.headers));
    this.body = init.body !== undefined ? init.body : from ? from.body : null;
    this.signal = init.signal || null;
    this.credentials = init.credentials || 'same-origin';
    this.mode = init.mode || 'cors';
    this.cache = init.cache || 'default';
    this.redirect = init.redirect || 'follow';
  }
  clone() { return new Request(this); }
  text() { return Promise.resolve(bodyText(this.body)); }
  json() { return this.text().then((t) => JSON.parse(t)); }
  arrayBuffer() { return Promise.resolve(utf8(bodyText(this.body)).buffer); }
}
class Response {
  constructor(body, init) {
    init = init || {};
    this._t = bodyText(body);
    this.status = init.status === undefined ? 200 : Number(init.status);
    this.statusText = String(init.statusText || '');
    this.headers = new Headers(init.headers);
    this.ok = this.status >= 200 && this.status < 300;
    this.redirected = false; this.type = 'basic'; this.url = '';
    this.bodyUsed = false;
    const t = this._t;
    this.body = body == null ? null : new ReadableStream({ start(c) { c.enqueue(utf8(t)); c.close(); } });
  }
  static json(data, init) { const r = new Response(JSON.stringify(data), init); if (!r.headers.has('content-type')) r.headers.set('content-type', 'application/json'); return r; }
  static error() { const r = new Response(null, { status: 0 }); r.type = 'error'; return r; }
  static redirect(url, status) { return new Response(null, { status: status || 302, headers: { location: String(url) } }); }
  text() { this.bodyUsed = true; return Promise.resolve(this._t); }
  json() { return this.text().then((t) => JSON.parse(t)); }
  arrayBuffer() { return Promise.resolve(utf8(this._t).buffer); }
  blob() { return Promise.resolve(new Blob([this._t])); }
  clone() { const r = new Response(this._t, { status: this.status, statusText: this.statusText, headers: this.headers }); return r; }
}
class AbortSignal {
  constructor() { this.aborted = false; this.reason = undefined; this.onabort = null; this._l = []; }
  addEventListener(t, f) { if (t === 'abort') this._l.push(f); }
  removeEventListener(t, f) { this._l = this._l.filter((x) => x !== f); }
  dispatchEvent(e) { for (const f of this._l.slice()) { try { f(e); } catch (x) {} } return true; }
  throwIfAborted() { if (this.aborted) throw this.reason; }
  _abort(reason) { if (this.aborted) return; this.aborted = true; this.reason = reason === undefined ? domError('AbortError', 'This operation was aborted') : reason; const e = { type: 'abort', target: this }; if (typeof this.onabort === 'function') { try { this.onabort(e); } catch (x) {} } this.dispatchEvent(e); }
  static abort(reason) { const s = new AbortSignal(); s._abort(reason); return s; }
  static timeout(ms) { const s = new AbortSignal(); setTimeout(() => s._abort(domError('TimeoutError', 'The operation timed out')), ms); return s; }
  static any(list) { const s = new AbortSignal(); for (const x of list || []) { if (x.aborted) { s._abort(x.reason); break; } x.addEventListener('abort', () => s._abort(x.reason)); } return s; }
}
class AbortController {
  constructor() { this.signal = new AbortSignal(); }
  abort(reason) { this.signal._abort(reason); }
}
class DOMException extends Error {
  constructor(message, name) { super(String(message === undefined ? '' : message)); this.name = String(name || 'Error'); this.code = 0; }
}
// What the shim names that a browser has: every one made here, none taken from the runtime.
const web = { URL, URLSearchParams, TextEncoder, TextDecoder, ReadableStream, Headers, Request, Response, Blob, File, FormData, AbortController, AbortSignal, DOMException, Buffer };
// The calls the shim makes to boot a page: each runs in a realm the runtime makes for it, and gives back that realm's values.
const vm = {
  createContext: (o) => { H.contextify(o); return o; },
  runInContext: (src, o, opts) => H.run(o, String(src), String((opts && opts.filename) || 'evalmachine'), Number((opts && opts.timeout) || 0)),
  SourceTextModule: class SourceTextModule {
    constructor(src, opts) {
      opts = opts || {};
      this._ubModule = H.module(String(src), String(opts.identifier || ''), opts.context, opts.initializeImportMeta || null, opts.importModuleDynamically || null);
    }
    get namespace() { return H.namespace(this._ubModule); }
    link(resolver) { return new Promise((ok, fail) => H.link(this._ubModule, resolver, ok, fail)); }
    evaluate() { return new Promise((ok, fail) => H.evaluate(this._ubModule, ok, fail)); }
  },
};
"#;

/// The JavaScript that boots a bundle and reports the request the page's code makes. It is the sandbox: the page sees
/// a window, a location, storage, timers, a fetch that records instead of sending, and an XHR that does the same.
const HARNESS: &str = r#"
const spec = JSON.parse(H.spec);
// There is no real-DOM mode. A DOM module (happy-dom) is the runtime's own code: its window, its nodes and their
// constructors are the runtime's objects, and every one of them leads back to the process. The page gets the shim's
// DOM, made in its own realm, and nothing in it loads anything by itself.
// A runtime takes its own time to start (a loaded machine, a cold module cache): the parent waits for this mark before
// it starts the clock, so a slow start is not read as a page that said nothing.
H.ready();
const scripts = JSON.parse(H.input);
// The page's own code, as the route carries it, by absolute address: a chunk the page loads again that is already
// here runs from the route instead of being fetched again. A browser reads its cache between calls; so does a call.
const carried = new Map();
for (const s of scripts) { try { carried.set(new URL(s.url, spec.pageUrl).href, s.body); } catch (e) { carried.set(String(s.url), s.body); } }
const out = [];
let errors = 0;
const errs = [];
// What the page asked the document for by id, and what it got: the lookup that found an empty element is a page
// reading state the walk did not carry, and the one that found nothing is markup past the route's page.
const lookups = [];
// The answer is written once the page has been quiet for the settle window, or at the hard cap: a page that signs a
// moment late is still read, and one that never settles cannot hold the call.
let settleTimer = null;
// The scripts the page's own runtime resolved for this signing: the document's boot set, and every chunk or module a
// loader asked for. A route can keep only what the call touched, and a generator can see the module list it is in.
const used = [];
const noteUsed = (url) => { try { if (used.indexOf(url) < 0) used.push(url); } catch (e) {} };
const done = () => { let values = []; try { values = (typeof g !== 'undefined' && g.__ub_values) ? g.__ub_values : []; } catch (e) {} let global; try { if (spec.readGlobal) { const v = g[spec.readGlobal]; global = v == null ? '' : String(v); } } catch (e) { global = ''; } let cookies = []; try { cookies = Array.from(jar.entries()); } catch (e) {} if (process.env.UNBROWSE_SIGN_DEBUG) { try { const uniq = Array.from(new Set(typeof descMissing !== 'undefined' ? descMissing : [])); process.stderr.write('[desc] ' + uniq.join(' ') + '\n'); } catch (e) {} } process.stdout.write(JSON.stringify({ requests: out, errors, errs, lookups, modules: used, values, global, cookies, targets: spec.targets || [], seen: Array.from(targetSeen) })); process.exit(0); };
// The call(s) the route asks about: once the page has made them all, a short grace is enough. A call after that is
// not the signature this boot was for, and waiting the whole quiet window for it is time the caller pays. The window
// is armed in many places (a fetch in flight, a chunk, the page's own answer); every arm reads this, so no later
// fetch can put the full window back after the targets are in.
const targets = (spec.targets || []).map((t) => ({ method: String(t.method || 'GET').toUpperCase(), path: String(t.path || '') }));
const targetSeen = new Set();
const pathOf = (u) => { const s = String(u || ''); try { return new URL(s, spec.pageUrl).pathname; } catch (e) { return s.split('?')[0]; } };
const quiet = () => (targets.length && targets.every((t) => targetSeen.has(t.method + ' ' + t.path)) ? Math.min(400, Number(spec.settleMs) || 0) : spec.settleMs);
const arm = () => { if (settleTimer) clearTimeout(settleTimer); settleTimer = setTimeout(done, quiet()); };
// A reader's nudge: the browser's own walk scrolls to the end and presses "show more"; a page that lazy-loads on
// scroll or on the viewport makes its call then. This DOM has no layout, so the scroll is the event, not the geometry.
const readerNudge = () => {
  try { const h = (g.document && g.document.documentElement && g.document.documentElement.scrollHeight) || 0; g.scrollTo(0, h); } catch (e) {}
  const Event = g.Event || function (type) { return { type: type }; };
  for (const target of [g, g.document]) { try { if (target && target.dispatchEvent) target.dispatchEvent(new Event('scroll')); } catch (e) {} }
  try { g.dispatchEvent(new Event('resize')); } catch (e) {}
};
const noteTarget = (url, method) => {
  if (!targets.length) return;
  targetSeen.add(String(method || 'GET').toUpperCase() + ' ' + pathOf(url));
  arm();
};
// A page's own code throws: in a promise it never awaited, in a timer, in a callback. That is the page's business, not
// the end of the answer — the call it already made, or makes after, is still the page's.
// What went wrong and where, from the page's own point of view: the message, then the deepest frames that name a
// bundle the page loaded (a runtime's own frames say nothing about the page).
const why = (e) => {
  const head = String((e && e.message) || e).slice(0, 200);
  // The frames that name a script and a place in it: a bundle is one long line, so the runtime's source excerpt is
  // the whole bundle and says nothing. A `at fn (url:line:col)` is what locates the read.
  const frames = String((e && e.stack) || '').split('\n').map((l) => l.trim()).filter((l) => l.indexOf('at ') === 0).map((l) => l.slice(3)).slice(0, 5);
  return (head + (frames.length ? ' @ ' + frames.join(' | ') : '')).slice(0, 900);
};
const oops = (what) => (e) => {
  errors += 1;
  if (errs.length < 8) errs.push(what + ': ' + why(e));
  arm();
};
process.on('uncaughtException', oops('uncaught'));
process.on('unhandledRejection', oops('rejected'));
const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const headersOf = (h) => {
  const o = {};
  if (!h) return o;
  if (typeof h.forEach === 'function' && !Array.isArray(h)) { h.forEach((v, k) => { o[k] = v; }); return o; }
  if (Array.isArray(h)) { for (const [k, v] of h) o[k] = v; return o; }
  for (const k of Object.keys(h)) o[k] = text(h[k]);
  return o;
};
const record = (url, init) => {
  init = init || {};
  out.push({ url: text(url), method: text(init.method || 'GET').toUpperCase(), headers: headersOf(init.headers), body: init.body == null ? null : text(init.body) });
  arm();
  noteTarget(url, init.method);
};
const response = () => ({ ok: true, status: 200, headers: { get: () => null, forEach: () => {} }, body: streamOf('{}'), bodyUsed: false, text: async () => '{}', json: async () => ({}), clone() { return this; } });
class XHR {
  constructor() { this._h = {}; this._rh = []; this._u = ''; this._m = 'GET'; this._b = null; this.readyState = 0; this.status = 200; this.statusText = ''; this.responseText = '{}'; this.response = '{}'; this.responseType = ''; this.responseURL = ''; this.timeout = 0; this.withCredentials = false; this.upload = { addEventListener() {}, removeEventListener() {} }; this.onreadystatechange = null; this.onload = null; this.onerror = null; this.onabort = null; this.ontimeout = null; this.onprogress = null; }
  open(m, u) { this._m = m; this._u = u; }
  setRequestHeader(k, v) { this._h[k] = v; }
  send(b) {
    this._b = b == null ? null : b;
    record(this._u, { method: this._m, headers: this._h, body: this._b });
    // The same data layer a fetch sees: an answer the walk recorded is the answer this call already has.
    let abs = String(this._u);
    try { abs = new URL(abs, spec.pageUrl).href; } catch (e) {}
    const said = answered(abs);
    if (said) { this.status = said.status; this.responseText = said.body; this.response = said.body; this._rh = [['content-type', said.mime || 'application/json']]; }
    else if (net) {
      const self = this;
      if (settleTimer) clearTimeout(settleTimer);
      bridge({ method: text(this._m || 'GET').toUpperCase(), url: abs, headers: this._h, body: this._b })
        .then((r) => { if (r && r.status) { self.status = r.status; self.responseText = r.body || ''; self.response = r.body || ''; self._rh = (r.headers || []).slice(); } })
        .finally(() => { arm(); self.readyState = 4; if (self.onreadystatechange) self.onreadystatechange(); if (self.onload) self.onload(); });
      return;
    }
    this.readyState = 4;
    if (this.onreadystatechange) this.onreadystatechange();
    if (this.onload) this.onload();
  }
  // What a page reads off the answer itself: a tracker's id header, a request it aborts.
  getResponseHeader(k) { const n = String(k).toLowerCase(); const h = this._rh.find(([a]) => String(a).toLowerCase() === n); return h ? h[1] : null; }
  getAllResponseHeaders() { return this._rh.map(([a, b]) => a + ': ' + b).join('\r\n'); }
  abort() { this._aborted = true; }
  addEventListener(t, f) { if (t === 'readystatechange') this.onreadystatechange = f; if (t === 'load') this.onload = f; if (t === 'error') this.onerror = f; }
}
// A page's interceptor wraps the answer's properties by descriptor (`Object.getOwnPropertyDescriptor(XMLHttpRequest
// .prototype, 'response').get`), which finds nothing when they are plain fields on each instance — and the tracker
// throws before the page's own modules run. They are accessors on the prototype here, over the same fields.
for (const name of ['readyState', 'status', 'statusText', 'responseText', 'response', 'responseURL', 'responseType', 'timeout', 'withCredentials', 'upload', 'onreadystatechange', 'onload', 'onerror', 'onabort', 'ontimeout', 'onprogress']) {
  if (Object.getOwnPropertyDescriptor(XHR.prototype, name)) continue;
  Object.defineProperty(XHR.prototype, name, {
    configurable: true,
    enumerable: true,
    get() { return this['_' + name]; },
    set(v) { this['_' + name] = v; },
  });
}
const F = spec.fingerprint || {};
// A page's code often starts its work on the page events, not at parse: keep the listeners and fire them, in the
// order a browser does (DOMContentLoaded, then load).
const listeners = {};
const fire = (type) => {
  const e = { type };
  const l = listeners[type];
  if (l) for (const f of l.slice()) { try { f(e); } catch (_) {} }
};
// The page's own network: a fetch it makes while signing is answered by the node (its session, its transport, its
// rule), never by this process, which has no network of its own. A request goes out as one line and its answer comes
// back as one; the node decides whether it is made at all.
const net = spec.net ? true : null;
const bridge = (r) => new Promise((resolve) => {
  if (!net) { resolve(null); return; }
  let line;
  try { line = JSON.stringify(r); } catch (e) { resolve(null); return; }
  H.bridge(line, (said) => { let v = null; try { v = JSON.parse(said); } catch (e) {} resolve(v); });
});
// A response a page's streaming reader can read: the body as a ReadableStream of one chunk, as a fetch's response is.
// A server-sent-events call (`FlightListSearchSSE`) reads `response.body.getReader()`; without a body the page stops at
// the stream and never makes the call that follows it (the middle search built from the stream).
const streamOf = (text) => {
  try {
    const bytes = new TextEncoder().encode(String(text == null ? '' : text));
    return new ReadableStream({ start(c) { try { c.enqueue(bytes); } catch (e) {} c.close(); } });
  } catch (e) { return null; }
};
const responseOf = (r) => {
  const h = new Map((r && r.headers) || []);
  const body = (r && r.body) || '';
  // A response that carries an event stream says so: a page's SSE reader checks the content-type before it reads, and a
  // bridge answer that lost the header would stop it at the stream. The body says what it is.
  if (!h.has('content-type')) {
    const t = String(body).replace(/^\s+/, '');
    h.set('content-type', /^(data|event|id|retry):/m.test(t) || /\n\ndata:/.test(t) ? 'text/event-stream' : (t.startsWith('{') || t.startsWith('[') ? 'application/json' : 'text/plain'));
  }
  return { ok: !!(r && r.status >= 200 && r.status < 300), status: (r && r.status) || 0,
    headers: { get: (k) => (h.has(String(k).toLowerCase()) ? h.get(String(k).toLowerCase()) : null), forEach: (f) => h.forEach((v, k) => f(v, k)) },
    body: streamOf(body), bodyUsed: false,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    text: async () => body, json: async () => JSON.parse(body || '{}'), clone() { return this; } };
};
// A bundle's lazily loaded chunk: fetched from the node (the same line as its fetch), run in this context, and its
// new globals handed back as the module's namespace. A chunk written as a browser script (webpack, UMD, a vite
// classic chunk) registers what it exports on `self`; this is the loader for those. While a chunk is in flight the
// answer stays open: a slow chunk is not a page that said nothing.
const doImport = async (what) => {
  try { noteUsed(String(what)); } catch (e) {}
  if (settleTimer) clearTimeout(settleTimer);
  try { return await chunk(what); } finally { arm(); }
};
const chunk = async (what) => {
  let abs = String(what);
  try { abs = new URL(abs, spec.pageUrl).href; } catch (e) {}
  noteUsed(abs);
  let src = carried.get(abs);
  if (src == null) {
    const r = await bridge({ method: 'GET', url: abs, headers: {}, body: null });
    if (!r || !r.status) {
      try { console.error('unbrowse: chunk ' + abs + ' failed: ' + ((r && r.error) || 'no answer')); } catch (e) {}
      throw new Error('import failed: ' + what);
    }
    src = String(r.body || '');
  }
  const before = {};
  for (const k of Object.keys(g)) before[k] = true;
  try {
    const body = src.replace(/\bimport\s*\(/g, '__ubImport(').replace(/\bimport\.meta\b/g, '__ubMeta');
    vm.runInContext(body, g, { filename: abs, timeout: spec.scriptMs });
  } catch (e) {
    try { console.error('unbrowse: chunk threw ' + abs + ': ' + ((e && e.message) || e)); } catch (_) {}
    // An ES module cannot run as a script; evaluate it as one, its dependencies linked through the same line.
    if (!/export|import|module/i.test(String(e && e.message))) throw new Error('import: ' + (e && e.message ? e.message : e));
    const mod = await loadModule(abs, src);
    return mod.namespace;
  }
  const ns = {};
  for (const k of Object.keys(g)) if (!before[k]) ns[k] = g[k];
  return ns;
};
// An ES module chunk: fetched the same way, evaluated as a module with its own dependencies linked through the line.
const moduleCache = new Map();
const loadModule = async (abs, src) => {
  noteUsed(abs);
  if (moduleCache.has(abs)) return moduleCache.get(abs);
  // A module graph's side-effect import of a chunk that declares no import or export is a classic script: a bundler's
  // shared vendor chunk keeps its bindings as globals, and running it with a module's own scope leaves them undefined
  // (Etsy's jQuery read its document alias as `p` where the chunk expected the shared global). A real module — one
  // with a static import or export — keeps its own scope.
  const realModule = /(^|[;}])\s*(import\s*[\{\(]|import\s+[A-Za-z_$]|export\s*[\{\(]|export\s+[A-Za-z_$])/.test(String(src));
  if (!realModule) {
    vm.runInContext(String(src), g, { filename: abs, timeout: spec.scriptMs });
    const seen = { namespace: {} };
    moduleCache.set(abs, seen);
    arm();
    return seen;
  }
  if (settleTimer) clearTimeout(settleTimer);
  if (typeof vm.SourceTextModule !== 'function') throw new Error('import: this runtime has no module support');
  // A module's dependency is the route's own script when the route carries it: the linker asks for it by name, and a
  // carried body answers without a line to the site. Fetching each one over the bridge made a hundred-chunk graph
  // take longer to link than the answer's whole budget (Etsy's boot never finished).
  const heldModule = async (specifier, base) => {
    let dep = String(specifier);
    try { dep = new URL(specifier, base).href; } catch (e) {}
    const held = carried.get(dep);
    if (held != null) return loadModule(dep, held);
    // A module the route does not carry is asked of the site. When that answer is not a file, the specifier and the
    // base that resolved to it are the only way to tell a stale carried page from a wrong resolution.
    if (process.env.UNBROWSE_SIGN_DEBUG) {
      try {
        const pb = carried.get(String(base));
        process.stderr.write('[module] ' + String(specifier) + ' from ' + String(base) + (pb != null ? ' [carried]' : ' [asked]') + ' -> ' + dep + (held != null ? ' (carried)' : ' (asked)') + '\n');
      } catch (e) {}
    }
    const r = await bridge({ method: 'GET', url: dep, headers: {}, body: null });
    if (!r || !r.status) throw new Error('import: ' + dep);
    return loadModule(dep, r.body);
  };
  // A specifier is resolved against the module that declared it. `link` and `importModuleDynamically` both say which
  // module that is (the referencing module); the captured `abs` is the module being loaded, which is the same thing
  // only while one module links at a time. Etsy's ESM graph asked for a chunk under a sibling's path because a
  // concurrently linking module's specifier was resolved against this one.
  const referrer = (r) => (typeof r === 'string' && r) || (r && typeof r === 'object' && r.identifier) || abs;
  const mod = new vm.SourceTextModule(src, {
    identifier: abs,
    context: g,
    initializeImportMeta: (meta) => { meta.url = abs; },
    importModuleDynamically: async (specifier, r) => heldModule(specifier, referrer(r)),
  });
  moduleCache.set(abs, mod);
  await mod.link((specifier, r) => heldModule(specifier, referrer(r)));
  await mod.evaluate();
  arm();
  return mod;
};

// A worker: its own global (no DOM, its own messages), the same line to the node, so the calls it makes are the
// page's. Messages wait until it has loaded.
class UbWorker {
  constructor(url) {
    let abs = String(url && url.href ? url.href : url);
    try { abs = new URL(abs, spec.pageUrl).href; } catch (e) {}
    this._onmessage = null;
    this._mainQueue = [];
    this._queue = [];
    this._ctx = null;
    this._dead = false;
    this.onerror = null;
    // A shared worker's half is its `port`: the same messages, the same way, so code that waits on `port.onmessage`
    // works as it would in a browser.
    const w = this;
    this.port = {
      postMessage: (m) => w.postMessage(m),
      start: noop,
      close: () => w.terminate(),
      get onmessage() { return w._onmessage; },
      set onmessage(f) { w._onmessage = f; const q = w._mainQueue; w._mainQueue = []; for (const m of q) w._deliverMain(m); },
      addEventListener: (t, f) => { if (t === 'message') this.onmessage = f; },
    };
    this._load(abs);
  }
  get onmessage() { return this._onmessage; }
  set onmessage(f) {
    this._onmessage = f;
    const q = this._mainQueue; this._mainQueue = [];
    for (const m of q) this._deliverMain(m);
  }
  async _load(abs) {
    // A worker's own script is in flight: the page is working, not quiet.
    if (settleTimer) clearTimeout(settleTimer);
    let r = null;
    try { r = await bridge({ method: 'GET', url: abs, headers: {}, body: null }); } finally { arm(); }
    if (!r || !r.status) { this._dead = true; return; }
    const ctx = Object.create(null);
    Object.assign(ctx, {
      self: null, console: g.console, setTimeout, clearTimeout, setInterval: g.setInterval, clearInterval,
      queueMicrotask, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, Buffer, crypto: g.crypto,
      performance: g.performance, navigator: g.navigator, location: g.location, fetch: doFetch,
      XMLHttpRequest: g.XMLHttpRequest, WebAssembly, OffscreenCanvas: g.OffscreenCanvas, Intl,
      postMessage: (m) => this._toMain(m), onmessage: null,
      addEventListener: (t, f) => { if (t === 'message') ctx.onmessage = (e) => f(e); },
    });
    ctx.self = ctx; ctx.globalThis = ctx;
    vm.createContext(ctx);
    this._ctx = ctx;
    // A worker's other half is importScripts, which is synchronous while the line to the node is not. So the scripts a
    // worker names — the literals its body passes — are fetched before the body runs, and run at the moment it calls
    // for them, once each, in the order it asks. A URL the page computes rather than writes is the one case this
    // cannot serve, and it says so by name instead of failing anonymously.
    const imports = new Map();
    const ran = new Set();
    // The literal URLs a script names to importScripts: the shape a worker's loader is written in.
    const named = (src) => {
      const out = [];
      const call = /importScripts\s*\(([^)]*)\)/g;
      let m;
      while ((m = call.exec(src))) {
        const lit = /(['"])((?:(?!\1).)*)\1/g;
        let a;
        while ((a = lit.exec(m[1]))) out.push(a[2]);
      }
      return out;
    };
    // Fetch what the body names, and what those name, so the synchronous calls have somewhere to read from.
    const fetchNamed = async (src, base, depth) => {
      for (const u of named(src)) {
        let dep = String(u);
        try { dep = new URL(dep, base).href; } catch (e) { continue; }
        if (imports.has(dep)) continue;
        let rr = null;
        if (settleTimer) clearTimeout(settleTimer);
        try { rr = await bridge({ method: 'GET', url: dep, headers: {}, body: null }); } finally { arm(); }
        if (!rr || !rr.status) { imports.set(dep, null); continue; }
        const body = String(rr.body || '');
        imports.set(dep, body);
        if (depth > 0 && body.indexOf('importScripts') >= 0) await fetchNamed(body, dep, depth - 1);
      }
    };
    const runImport = (dep) => {
      const src = imports.get(dep);
      if (src == null) throw new Error('importScripts: ' + dep);
      if (ran.has(dep)) return;
      ran.add(dep);
      vm.runInContext(src, ctx, { filename: dep, timeout: spec.scriptMs });
    };
    ctx.importScripts = (...urls) => {
      for (const u of urls) {
        let dep = String(u && u.href ? u.href : u);
        try { dep = new URL(dep, abs).href; } catch (e) {}
        if (!imports.has(dep)) throw new Error('importScripts: ' + dep + ' is not a literal this worker named');
        runImport(dep);
      }
    };
    const body = String(r.body || '');
    try { await fetchNamed(body, abs, 3); } catch (e) { this._dead = true; return; }
    try { vm.runInContext(body, ctx, { filename: abs, timeout: spec.scriptMs }); }
    catch (e) { this._dead = true; return; }
    const q = this._queue; this._queue = [];
    for (const m of q) this._deliver(m);
  }
  _deliver(m) { if (!this._dead && this._ctx && typeof this._ctx.onmessage === 'function') this._ctx.onmessage({ data: m }); }
  _deliverMain(m) { if (typeof this._onmessage === 'function') this._onmessage({ data: m }); }
  _toMain(m) { if (typeof this._onmessage === 'function') this._deliverMain(m); else this._mainQueue.push(m); }
  postMessage(m) { if (this._ctx) this._deliver(m); else this._queue.push(m); }
  terminate() { this._dead = true; this._ctx = null; }
}

// The answers the walk's page read: its own config, a locale table, a bootstrap. A bundle's start-up asks for them
// again, and the route already holds what the site said — so the data layer answers first, with no network and no page,
// and a host the walk never answered goes on to the line (or nowhere, when this run has no line).
const answers = spec.answers || [];
const answered = (abs) => {
  const exact = answers.find((a) => a.url === abs);
  if (exact) return exact;
  let p = abs, q = abs;
  try { const u = new URL(abs); p = u.pathname; q = u.pathname + u.search; } catch (e) {}
  return answers.find((a) => { try { const u = new URL(a.url); return u.pathname + u.search === q; } catch (e) { return false; } })
    || answers.find((a) => { try { return new URL(a.url).pathname === p; } catch (e) { return false; } });
};
const doFetch = async (input, init) => {
  const url = typeof input === 'object' && input && input.url ? input.url : input;
  const i = init || (typeof input === 'object' ? { method: input.method, headers: input.headers, body: input.body } : {});
  record(url, i);
  let abs = String(url);
  try { abs = new URL(String(url), spec.pageUrl).href; } catch (e) {}
  const said = answered(abs);
  if (said) return responseOf({ status: said.status, body: said.body, headers: [['content-type', said.mime || 'application/json']] });
  if (net) {
    // A call in flight is a page still working: the answer stays open until the node has answered it.
    if (settleTimer) clearTimeout(settleTimer);
    const r = await bridge({ method: text(i.method || 'GET').toUpperCase(), url: abs, headers: headersOf(i.headers), body: i.body == null ? null : text(i.body) });
    arm();
    if (r && r.status) return responseOf(r);
  }
  return response();
};
const store = (seed) => {
  const m = new Map(Object.entries(seed || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, text(v)), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: (i) => Array.from(m.keys())[i] ?? null, get length() { return m.size; } };
};
const loc = (u) => { const x = new URL(u); return { href: x.href, origin: x.origin, protocol: x.protocol, host: x.host, hostname: x.hostname, port: x.port, pathname: x.pathname, search: x.search, hash: x.hash, toString() { return x.href; } }; };
const noop = () => {};
// The page's own cookie jar: what it was sent, and whatever it writes back (a nonce a bundle keeps there).
const jar = new Map();
String(spec.cookies || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); });
const cookieOf = (d) => ({
  get cookie() { return Array.from(jar.entries()).map(([k, v]) => k + '=' + v).join('; '); },
  set cookie(v) { const s = String(v).split(';')[0]; const i = s.indexOf('='); if (i > 0) jar.set(s.slice(0, i).trim(), s.slice(i + 1).trim()); },
});
const nudge = (d) => Object.defineProperty(d, 'cookie', { configurable: true, get: () => cookieOf(d).cookie, set: (v) => { cookieOf(d).cookie = v; } });
// The page as the walk saw it: enough of a DOM for a bundle that reads a `<meta>` token, a config `<script>`, or an
// input's value to find what the page had. Tags and attributes only; nothing renders. A selector names a tag, an id,
// or an attribute — the shapes a page's own signing code uses to fetch what it signs with.
const tags = [];
// Elements the page's own code creates and inserts, findable as a browser's would be: a framework's mount node is
// made at run time (`createElement('div'); id='root'; appendChild`), so it is in no markup the walk carried, and a
// lookup by id must still find it. These are the shim's own realm-isolated nodes, not a real DOM's.
const created = [];
const parseTags = (src) => {
  let i = 0;
  const lower = src.toLowerCase();
  while (i < src.length) {
    const at = src.indexOf('<', i);
    if (at < 0) break;
    if (src.startsWith('<!--', at)) { const e = src.indexOf('-->', at); i = e < 0 ? src.length : e + 3; continue; }
    const c = src[at + 1] || '';
    if (c === '!' || c === '?' || c === '/') { const e = src.indexOf('>', at); i = e < 0 ? src.length : e + 1; continue; }
    const e = src.indexOf('>', at);
    if (e < 0) break;
    const inner = src.slice(at + 1, e);
    const m = inner.match(/^([a-zA-Z][-a-zA-Z0-9]*)/);
    if (!m) { i = e + 1; continue; }
    const tag = m[1].toLowerCase();
    const attrs = {};
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let a;
    while ((a = re.exec(inner))) attrs[a[1].toLowerCase()] = a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : a[5];
    if (tag === 'script' || tag === 'style') {
      const close = lower.indexOf('</' + tag, e + 1);
      tags.push({ tag, attrs, end: e + 1, close: close < 0 ? src.length : close });
      i = close < 0 ? src.length : close;
      continue;
    }
    tags.push({ tag, attrs, end: e + 1, close: -1 });
    i = e + 1;
  }
};
parseTags(spec.html || '');
const matches = (el, sel) => {
  sel = String(sel || '').trim();
  let m = sel.match(/^([a-zA-Z][-a-zA-Z0-9]*)$/);
  if (m) return el.tag === m[1].toLowerCase();
  m = sel.match(/^#([\w-]+)$/);
  if (m) return el.attrs.id === m[1];
  m = sel.match(/^(?:([a-zA-Z][-a-zA-Z0-9]*))?\[([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\]$/);
  if (!m) return false;
  const want = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
  return (!m[1] || el.tag === m[1].toLowerCase()) && el.attrs[m[2].toLowerCase()] === want;
};
const elementOf = (el) => {
  const src = spec.html || '';
  // A parsed element is an element to a page's own framework too: React's `createRoot` refuses anything whose
  // `nodeType` is not 1 (error #299), and the mount node is one of these.
  const out = { tagName: el.tag.toUpperCase(), nodeName: el.tag.toUpperCase(), nodeType: 1, id: el.attrs.id || '', attributes: el.attrs, getAttribute: (k) => (String(k).toLowerCase() in el.attrs ? el.attrs[String(k).toLowerCase()] : null), hasAttribute: (k) => String(k).toLowerCase() in el.attrs };
  for (const k of Object.keys(el.attrs)) out[k] = el.attrs[k];
  if ('value' in el.attrs) out.value = el.attrs.value;
  if ('content' in el.attrs) out.content = el.attrs.content;
  const close = el.close < 0 ? src.toLowerCase().indexOf('</' + el.tag, el.end) : el.close;
  out.textContent = close < 0 ? '' : src.slice(el.end, close).replace(/<[^>]*>/g, '');
  out.innerText = out.textContent;
  out.innerHTML = close < 0 ? '' : src.slice(el.end, close);
  // A tag script inserts its own script beside the first one of its kind (`n.parentNode.insertBefore`): a parsed
  // element has a parent that can take it, as a browser's document does. The inserted script is the page's own; the
  // harness's loader runs it when it is a harness node, and a third-party tag's no-op keeps the boot going.
  out.parentNode = out.parentNode || { insertBefore: (n) => n, appendChild: (n) => n, removeChild: (n) => n, replaceChild: (n) => n, childNodes: [], removeChildNode: noop };
  const merged = Object.assign(out, dom(), out);
  // `dom()` holds ownerDocument as a non-enumerable getter, so the copy above drops it; a framework's `createRoot`
  // reads `node.ownerDocument` on the mount node it looked up by id, and the read of undefined stops the render.
  // Re-hold it here as a getter (not evaluated now: the document is still being built when the first tags are parsed).
  Object.defineProperty(merged, 'ownerDocument', { configurable: true, get: () => (typeof g !== 'undefined' ? g.document : null) });
  return merged;
};
// A selector read on a live node the page created (its id and attributes are its own, set after it was made), the
// same shapes `matches` reads on a parsed tag.
const matchesNode = (n, sel) => {
  sel = String(sel || '').trim();
  let m = sel.match(/^([a-zA-Z][-a-zA-Z0-9]*)$/);
  if (m) return String(n.tagName || '').toLowerCase() === m[1].toLowerCase();
  m = sel.match(/^#([\w-]+)$/);
  if (m) return n.id === m[1];
  m = sel.match(/^(?:([a-zA-Z][-a-zA-Z0-9]*))?\[([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\]$/);
  if (!m) return false;
  const want = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
  const key = m[2].toLowerCase();
  const val = key === 'id' ? n.id : (n.getAttribute ? n.getAttribute(m[2]) : null);
  return (!m[1] || String(n.tagName || '').toLowerCase() === m[1].toLowerCase()) && val === want;
};
const q = (sel) => { const el = tags.find((t) => matches(t, sel)); if (el) return elementOf(el); return created.find((n) => matchesNode(n, sel)) || null; };
const qa = (sel) => tags.filter((t) => matches(t, sel)).map(elementOf).concat(created.filter((n) => matchesNode(n, sel)));
// What any node a page touches can do: a script it inserts, a node it removes, a listener it adds. A page's boot code
// appends its own `<script>` and would otherwise die on a stub that only looks like an element.
// A bundle's own loader: it builds a `<script>`, sets `src`, and appends it. A browser fetches and runs it; so does
// this, over the same line as its fetches, in the page's own context.
const runScript = async (node) => {
  const src = node && (node.src || node.getAttribute && node.getAttribute('src'));
  const text = node ? String(node.textContent != null ? node.textContent : (node.text != null ? node.text : '')) : '';
  if (!src && !text) return;
  try {
    if (src) {
      await doImport(src);
    } else {
      // A script the page's code writes itself (a JSONP-style boot, a module it builds): its text is the program.
      const body = text.replace(/\bimport\s*\(/g, '__ubImport(').replace(/\bimport\.meta\b/g, '__ubMeta');
      vm.runInContext(body, g, { filename: String(node.id || 'inline:script'), timeout: spec.scriptMs });
    }
    try { node.readyState = 'complete'; } catch (_) {}
    const load = { type: 'load', target: node };
    if (typeof node.onload === 'function') { try { node.onload(load); } catch (_) {} }
    // A real DOM's `dispatchEvent` wants its own Event; the page's loader may listen either way.
    try { node.dispatchEvent(new g.Event('load')); } catch (_) { try { node.dispatchEvent(load); } catch (__) {} }
  } catch (e) {
    if (typeof node.onerror === 'function') { try { node.onerror({ type: 'error', target: node, message: String((e && e.message) || e) }); } catch (_) {} }
  }
};
const inserted = (c) => {
  if (!c) return c;
  const tag = String(c.tagName || '').toUpperCase();
  if (tag === 'SCRIPT') { setTimeout(() => runScript(c), 0); return c; }
  // A stylesheet is a chunk of its own to a bundler, and the chunk's `load` is what the page waits on before it
  // renders the next thing. This sandbox loads no CSS, so the event is answered here (trip.com's flight list stopped on
  // `ChunkLoadError: Loading CSS chunk list-csr-gateway-flight-list failed`, 2026-11-11).
  if (tag === 'LINK' || tag === 'STYLE') {
    setTimeout(() => { try { if (typeof c.onload === 'function') c.onload({ type: 'load', target: c }); if (c.dispatchEvent) c.dispatchEvent({ type: 'load', target: c }); } catch (e) {} }, 0);
  }
  // A node the page made and inserted is findable from now on: a mount node a framework creates and appends, then
  // asks for by id, is in the searchable DOM as a browser's would be (the lookup that came back empty is what stopped
  // a React app from rendering its first call).
  if (c.nodeType === 1 && created.indexOf(c) < 0) created.push(c);
  return c;
};
const textNode = (t) => ({ nodeType: 3, textContent: text(t), data: text(t) });
// An element the page creates holds a text child once its `innerHTML` is set: a CSS-in-JS library (goober, and the
// styled components built on it) appends a `<style>`, writes `innerHTML`, and keeps the CSS text on `firstChild.data`.
// Without the child that read is `undefined.data`, and the page stops there. `firstChild` is non-enumerable so a tag
// built from the page's markup keeps its own children rather than a copy of this getter's.
const withText = (o) => {
  // The document a node belongs to: a framework that builds nodes from a node (`ownerDocument.createElement`) finds
  // the page's document, as in a browser, instead of null. Non-enumerable: `elementOf` copies `dom()` with
  // `Object.assign`, which would evaluate an enumerable getter while the document itself is still being built.
  Object.defineProperty(o, 'ownerDocument', { configurable: true, get: () => (typeof g !== 'undefined' ? g.document : null) });
  Object.defineProperty(o, 'firstChild', {
    configurable: true,
    get() {
      const t = this.innerHTML != null && this.innerHTML !== '' ? String(this.innerHTML) : String(this.textContent || '');
      return textNode(t);
    },
  });
  // No `textContent` here: `elementOf` copies `dom()` over an element parsed from the page, and an empty default
  // would overwrite the block's own text (a JSON state block read by id came back empty).
  return o;
};
const dom = () => withText({
  style: {}, dataset: {}, setAttribute: noop, getAttribute: () => null, removeAttribute: noop, hasAttribute: () => false,
  appendChild: (c) => inserted(c), insertBefore: (c) => inserted(c), append: (c) => void inserted(c), prepend: noop, removeChild: (c) => c, remove: noop,
  addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
  querySelector: (s) => q(s), querySelectorAll: (s) => qa(s), getElementsByTagName: (t) => qa(t),
  contains: () => false, cloneNode: () => el(), getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
  children: [], childNodes: [], parentNode: null, focus: noop, click: noop, offsetWidth: 0, offsetHeight: 0,
});
const el = () => dom();
// A canvas is what the page's own code saw it draw: its output is the strings the walk's probe recorded, and a WebGL
// parameter answers what the browser answered. A producer that hashes the drawing gets the browser's hash back.
const webglOf = () => ({
  getParameter: (n) => (F.webgl && F.webgl[String(n)] !== undefined ? F.webgl[String(n)] : null),
  getExtension: () => null,
  getSupportedExtensions: () => [],
  getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
});
const ctx2d = () => ({
  fillRect: noop, fillText: noop, strokeText: noop, clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, fill: noop, arc: noop,
  measureText: (t) => ({ width: text(t).length * 7 }),
  getImageData: () => ({ data: new Uint8ClampedArray(F.pixels || []), width: (F.pixelsAt && F.pixelsAt[0]) || 0, height: (F.pixelsAt && F.pixelsAt[1]) || 0 }),
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
});
const canvasEl = () => {
  const c = el();
  c.width = 300; c.height = 150;
  c.getContext = (k) => (String(k).toLowerCase().indexOf('webgl') === 0 ? webglOf() : ctx2d());
  c.toDataURL = () => (F.canvas && F.canvas[0]) || 'data:,';
  c.toBlob = (f) => { try { f(null); } catch (_) {} };
  return c;
};
const create = (tag) => {
  const name = String(tag).toUpperCase();
  const e = String(tag).toLowerCase() === 'canvas' ? canvasEl() : el();
  e.tagName = name; e.nodeName = name; e.nodeType = 1;
  return e;
};
let g = {
  // The page's own console, forwarded only under debug: an app that catches its error still says why on its console,
  // and that is the one place a sandbox failure explains itself.
  console: (() => {
    const say = (tag) => (m) => { try { if (process.env.UNBROWSE_SIGN_DEBUG) process.stderr.write('[page ' + tag + '] ' + String(m) + '\n'); } catch (e) {} };
    return { log: noop, info: noop, debug: noop, warn: say('warn'), error: say('error') };
  })(),
  Buffer,
  setTimeout: (f, ms) => setTimeout(f, Math.min(Number(ms) || 0, spec.settleMs)), clearTimeout, setInterval: () => 0, clearInterval: noop, queueMicrotask,
  URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa, Buffer, process: { env: {}, nextTick: (f) => setTimeout(f, 0) },
  // The platform a bundle may reach for: a wasm module it compiles, an offscreen canvas it draws. Both are the real
  // runtime's (the engine's), not a stub: a producer that lives in wasm runs.
  WebAssembly,
  OffscreenCanvas: function (w, h) { const c = canvasEl(); if (w) c.width = w; if (h) c.height = h; return c; },
  // The browser's WebCrypto, plus the runtime's hashes: a program written for the standalone sandbox may call
  // createHash/createHmac, and the page's own code never does. The capability is the runtime's, not a site's.
  crypto: webCrypto,
  performance: { now: () => Date.now(), timeOrigin: Date.now() },
  location: loc(spec.pageUrl), document: { title: '', referrer: '', readyState: 'loading', location: loc(spec.pageUrl), dispatchEvent: (e) => { const l = listeners[e && e.type]; if (l) for (const f of l.slice()) { try { f(e); } catch (_) {} } return true; }, createElement: create, createTextNode: (t) => ({ nodeType: 3, textContent: text(t) }), createDocumentFragment: () => el(), head: q('head') || el(), body: q('body') || el(), documentElement: q('html') || el(), addEventListener: (t, f) => { (listeners[t] || (listeners[t] = [])).push(f); }, removeEventListener: noop, querySelector: q, querySelectorAll: qa,       getElementById: (id) => { const e = q('#' + id); if (lookups.length < 24) lookups.push([String(id), !!e, e ? String(e.textContent || '').length : -1]); return e; }, getElementsByTagName: (t) => qa(t), getElementsByName: (n) => qa('[name="' + n + '"]'), scripts: tags.filter((t) => t.tag === 'script').map(elementOf), cookie: spec.cookies || '', writes: [],
    // The implementation a page's code asks the document for (`new DOMImplementation().createHTMLDocument`): a
    // document of its own, so a script that builds one to parse or to measure finds something that behaves.
    implementation: { createHTMLDocument: (t) => ({ title: t || '', body: el(), documentElement: el(), querySelector: q, querySelectorAll: qa, createElement: create }) } },
  navigator: { userAgent: F.ua || spec.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36', language: F.lang || 'en-SG', languages: F.langs || ['en-SG', 'en'], platform: F.platform || 'MacIntel', vendor: F.vendor || 'Google Inc.', webdriver: false, cookieEnabled: true, hardwareConcurrency: F.cores || 8, maxTouchPoints: F.touch || 0, plugins: [], mimeTypes: [], connection: { effectiveType: '4g', rtt: 50, downlink: 10 },
    // The client hints the browser reported: a producer that reads the platform or the brand list from the high-
    // entropy API gets the walk's own answer, not a made-up one.
    userAgentData: (function () {
      const d = F.uaData || {};
      const brands = d.brands || [];
      const mobile = !!d.mobile;
      const platform = d.platform || F.platform || 'macOS';
      return { brands, mobile, platform, getHighEntropyValues: async () => ({ brands, mobile, platform, architecture: F.arch || 'x86', bitness: F.bitness || '64', model: '', platformVersion: F.platformVersion || '15.0.0', uaFullVersion: (F.ua || '').split('Chrome/')[1] || '', fullVersionList: brands }) };
    })() },
  screen: { width: (F.screen && F.screen.width) || 1920, height: (F.screen && F.screen.height) || 1080, availWidth: (F.screen && F.screen.availWidth) || 1920, availHeight: (F.screen && F.screen.availHeight) || 1055, colorDepth: (F.screen && F.screen.colorDepth) || 24, pixelDepth: (F.screen && F.screen.pixelDepth) || 24 },
  innerWidth: 1280, innerHeight: 720, outerWidth: 1280, outerHeight: 800, devicePixelRatio: F.dpr || 2, screenX: 0, screenY: 0,
  chrome: { runtime: {}, loadTimes: noop, csi: noop, app: { isInstalled: false } },
  history: { length: 1, state: null, pushState: noop, replaceState: noop, back: noop, forward: noop, go: noop },
  localStorage: store(spec.localStorage), sessionStorage: store(spec.sessionStorage),
  // The web storage interface itself: a bundle feature-detects it (`typeof Storage !== 'undefined'`) and reaches its
  // `prototype`; the stores above are the page's own, read back from the walk.
  Storage: function Storage() {},
  fetch: doFetch,
  XMLHttpRequest: XHR,
  addEventListener: (t, f) => { (listeners[t] || (listeners[t] = [])).push(f); },
  removeEventListener: (t, f) => { const l = listeners[t]; if (l) { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); } },
  dispatchEvent: (e) => { const l = listeners[e && e.type]; if (l) for (const f of l.slice()) { try { f(e); } catch (_) {} } return true; },
  requestAnimationFrame: (f) => setTimeout(() => f(Date.now()), 16), cancelAnimationFrame: noop,
  requestIdleCallback: (f) => setTimeout(() => f({ timeRemaining: () => 50, didTimeout: false }), 1), cancelIdleCallback: noop,
  // What a page's code measures and watches: a computed style, an observer it starts. A stub that answers '' keeps the
  // code running; the values that matter are the ones the page records in its own state, which the sandbox carries.
  getComputedStyle: () => ({ getPropertyValue: () => '', ...{} }),
  // The platform's own data types come from the runtime: a bundle builds a Blob, a FormData, a Request, and reads
  // them the way a browser would.
  Blob, File: typeof File === 'function' ? File : undefined, FormData, Headers, Request, Response, AbortController,
  // An image the page's code waits on: the address it was given, and the event it expects (a check that an image
  // loads is answered as loads, the walk having seen it load).
  Image: function (w, h) { const i = el(); i.width = w || 0; i.height = h || 0; i.complete = true; i.naturalWidth = w || 0; i.naturalHeight = h || 0;
    try { setTimeout(() => { if (typeof i.onload === 'function') i.onload({ type: 'load', target: i }); }, 0); } catch (e) {}
    return i; },
  Audio: function (src) { const a = el(); a.src = src || ''; a.play = () => Promise.resolve(); a.pause = noop; return a; },
  Event: function (t, o) { Object.assign(this, { type: t }, o || {}); },
  CustomEvent: function (t, o) { Object.assign(this, { type: t, detail: (o || {}).detail }, o || {}); },
  EventTarget: function () {},
  Node: function () {}, Element: function () {}, HTMLElement: function () {},
  // The element and event interfaces a page's own framework checks a node with (`t instanceof window.HTMLIFrameElement`,
  // `e instanceof MouseEvent`). Each is the constructor its name promises: a value that is not one is not, and the
  // code that only branches on the answer runs instead of stopping on a name that is not there.
  ...[
    'HTMLIFrameElement', 'HTMLCanvasElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
    'HTMLFormElement', 'HTMLScriptElement', 'HTMLStyleElement', 'HTMLLinkElement', 'HTMLMetaElement', 'HTMLDivElement',
    'HTMLSpanElement', 'HTMLAnchorElement', 'HTMLButtonElement', 'HTMLImageElement', 'HTMLVideoElement',
    'HTMLAudioElement', 'HTMLBodyElement', 'HTMLHeadElement', 'HTMLHtmlElement', 'HTMLTableElement',
    'HTMLTemplateElement', 'HTMLUnknownElement', 'SVGElement', 'ShadowRoot', 'Document', 'HTMLDocument',
    'CanvasRenderingContext2D', 'WebGLRenderingContext', 'AudioContext', 'OfflineAudioContext',
    'DocumentFragment', 'Text', 'Comment', 'CharacterData', 'NodeList', 'HTMLCollection', 'Window', 'Location',
    'History', 'MessagePort', 'AbortSignal', 'DOMException', 'MouseEvent', 'KeyboardEvent',
    'PointerEvent', 'TouchEvent', 'InputEvent', 'UIEvent', 'FocusEvent', 'WheelEvent', 'AnimationEvent',
    'TransitionEvent', 'CompositionEvent', 'DragEvent', 'ClipboardEvent', 'ErrorEvent', 'ProgressEvent',
    'PerformanceEntry', 'IntersectionObserverEntry', 'ResizeObserverEntry', 'TaskAttributionTiming',
  ].reduce((o, n) => { const f = function () {}; Object.defineProperty(f, 'name', { value: n }); o[n] = f; return o; }, {}),
  // Two ports that hand a message to the other's `onmessage` on the next turn, the way a browser does: a scheduler
  // (React's) builds one and waits on `port1.onmessage`, and a stub without ports stops the page there.
  MessageChannel: function () {
    const after = (f, m) => setTimeout(() => { if (typeof f === 'function') f({ data: m }); }, 0);
    const a = { onmessage: null, postMessage: (m) => after(b.onmessage, m) };
    const b = { onmessage: null, postMessage: (m) => after(a.onmessage, m) };
    this.port1 = a; this.port2 = b;
  },
  MutationObserver: function () { this.observe = noop; this.disconnect = noop; this.takeRecords = () => []; },
  IntersectionObserver: function (f) { this.observe = (e) => { try { f([{ target: e, isIntersecting: true, intersectionRatio: 1 }]); } catch (_) {} }; this.unobserve = noop; this.disconnect = noop; this.takeRecords = () => []; },
  ResizeObserver: function () { this.observe = noop; this.unobserve = noop; this.disconnect = noop; },
  PerformanceObserver: function () { this.observe = noop; this.disconnect = noop; this.takeRecords = () => []; },
  matchMedia: () => ({ matches: false, addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop }),
};
g.window = g; g.self = g; g.globalThis = g; g.top = g; g.parent = g; g.frames = g; g.document.defaultView = g;
g.Storage.prototype = { getItem: () => null, setItem: noop, removeItem: noop, clear: noop, key: () => null, length: 0 };
// The DOM constructors a page's polyfills feature-detect (`DOMTokenList.prototype.@@iterator`, `AbortController`, a
// stream): the prelude has the platform ones, made in this realm, and a missing name is at least a constructor
// with a prototype, so the polyfill installs instead of throwing before the page's own scripts run.
for (const name of ['DOMTokenList', 'AbortController', 'AbortSignal', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File', 'DOMParser', 'XMLSerializer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'ReadableStream', 'WritableStream', 'TransformStream', 'EventTarget', 'CustomEvent', 'Event', 'DOMException']) {
  try { if (typeof g[name] === 'undefined') g[name] = web[name] || function () {}; } catch (e) {}
}
// A DOM library may have the object and not the constructor that names it: happy-dom 21 answers
// `document.implementation` and leaves `DOMImplementation` undefined, and a page's consent or polyfill script that
// asks `new DOMImplementation()` throws "DOMImplementation is not defined" — which aborts the script before the page's
// own module graph does anything (etsy.com's airgap.js, 2026-11-11). The document's own implementation answers, so the
// constructor is the instance's own, with its prototype.
try {
  if (typeof g.DOMImplementation === 'undefined' && g.document && g.document.implementation) {
    const impl = g.document.implementation;
    const DOMImplementation = function DOMImplementation() { return impl; };
    DOMImplementation.prototype = Object.getPrototypeOf(impl) || Object.prototype;
    g.DOMImplementation = DOMImplementation;
  }
} catch (e) {}
// A vendor script that reads a DOM property through its descriptor — `Object.getOwnPropertyDescriptor(Document.prototype,
// 'implementation').get`, which is how a consent SDK wraps the property — assumes it is on the prototype it names. A
// library may hold the getter on an *ancestor* instead (happy-dom answers `implementation`, `readyState`, `cookie`,
// `defaultView` and `currentScript` from `Document.prototype`, while the document's own prototype is
// `HTMLDocument.prototype`), so the read finds `undefined` and the script throws before the page's own modules run
// (etsy.com's airgap.js reads them this way, and Node's `ownerDocument` the same). Every prototype the document and an
// element are made of gets its ancestors' descriptors as its own, each still answered by the ancestor's getter, so the
// values stay live rather than snapshot.
try {
  const doc = g.document;
  const impl = doc && doc.implementation;
  const put = (proto, name, value) => {
    if (!proto || Object.getOwnPropertyDescriptor(proto, name)) return;
    Object.defineProperty(proto, name, { configurable: true, enumerable: true, get: () => value });
  };
  put(g.Document && g.Document.prototype, 'implementation', impl || { createHTMLDocument: (t) => ({ title: t || '', createElement: create }) });
  put(g.Document && g.Document.prototype, 'cookie', String((doc && doc.cookie) || spec.cookies || ''));
  const protos = new Set();
  const el = doc && doc.createElement ? doc.createElement('div') : null;
  for (const start of [doc, el]) {
    for (let o = start && Object.getPrototypeOf(start); o && o !== Object.prototype; o = Object.getPrototypeOf(o)) protos.add(o);
  }
  for (const proto of protos) {
    for (let up = Object.getPrototypeOf(proto); up && up !== Object.prototype; up = Object.getPrototypeOf(up)) {
      for (const name of Object.getOwnPropertyNames(up)) {
        if (name === 'constructor' || Object.getOwnPropertyDescriptor(proto, name)) continue;
        const d = Object.getOwnPropertyDescriptor(up, name);
        try {
          if (d.get || d.set) {
            // Both halves: a property the page may write (`element.innerHTML = …`) must stay writable, or the page's own
            // code throws on a descriptor this harness made.
            Object.defineProperty(proto, name, {
              configurable: true,
              enumerable: d.enumerable,
              get: d.get && function () { return d.get.call(this); },
              set: d.set && function (v) { return d.set.call(this, v); },
            });
          } else if (d.value !== undefined) {
            Object.defineProperty(proto, name, { configurable: true, enumerable: d.enumerable, get: () => d.value });
          }
        } catch (e) {}
      }
    }
  }
} catch (e) {}
try { g.ReadableStream = ReadableStream; g.TextDecoder = TextDecoder; g.TextEncoder = TextEncoder; } catch (e) {}
g.__ubImport = doImport; g.__ubMeta = { url: spec.pageUrl };
g.Worker = UbWorker; g.SharedWorker = UbWorker;
nudge(g.document);
// A bundle keeps its module graph behind a closure, but a chunk's push hands it out: webpack replaces the chunk
// array's `push` with a callback, and every factory it copies is called with `(module, exports, require)`. Watching
// that push (any global array whose `push` is not the array's own) gives the harness each chunk's module ids, their
// factories, and — through a probe payload with an executor — the runtime's own `require`. No site is named.
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// A chunk payload is one argument: `[[chunkNames], {moduleId: factory}]`. The same array may also carry an app's own
// events (a metric, a status), so only a payload of that shape is a chunk.
const chunkOf = (entry) => {
  const ids = Array.isArray(entry) && Array.isArray(entry[0]) ? entry[0] : null;
  const mods = ids && entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1]) ? entry[1] : null;
  return mods ? { ids, mods } : null;
};
const captureRequire = (arr, push) => {
  if (arr.__ub_require) return;
  // The runtime's `require` is handed to a chunk's executor. A chunk id it has not installed makes its callback take
  // the branch that calls one, so a probe payload captures the runtime this array belongs to.
  try { push.call(arr, [['__ub_probe__'], {}, function (r) { arr.__ub_require = r; }]); } catch (e) {}
};
const recordChunk = (arr, ids, mods) => {
  (arr.__ub_chunks || (arr.__ub_chunks = [])).push({ names: ids.map((x) => String(x)), ids: Object.keys(mods) });
  if (process.env.UNBROWSE_SIGN_DEBUG) { try { process.stderr.write('[mods] ' + ids.map(String).join(',') + ': ' + Object.keys(mods).length + ' modules\n'); } catch (e) {} }
  for (const id of Object.keys(mods)) {
    const f = mods[id];
    if (typeof f !== 'function') continue;
    const wrapped = function (module, exports, require) { return f.call(this, module, exports, require); };
    wrapped.__ub_wrapped = true;
    wrapped.__ub_src = String(f);
    mods[id] = wrapped;
  }
};
const watchChunks = () => {
  try {
    for (const k of Object.keys(g)) {
      let arr;
      try { arr = g[k]; } catch (e) { continue; }
      if (!Array.isArray(arr) || !arr.push || arr.__ub_watched) continue;
      // A webpack runtime replaces the chunk array's push with its own callback; an ordinary array still has the
      // built-in. That difference is the seam, whatever the site names the array.
      if (arr.push === Array.prototype.push) continue;
      arr.__ub_watched = true;
      arr.__ub_name = k;
      const push = arr.push;
      arr.push = function () {
        try {
          const chunk = chunkOf(arguments[0]);
          if (!chunk) return push.apply(this, arguments);
          captureRequire(arr, push);
          recordChunk(arr, chunk.ids, chunk.mods);
        } catch (e) {}
        return push.apply(this, arguments);
      };
      // A runtime that creates its array and pushes its first chunk in the same script is watched after that push:
      // read what the array already holds. Only a real chunk array is probed, so an app's own event array is untouched.
      const existing = Array.prototype.slice.call(arr).map(chunkOf).filter(Boolean);
      if (existing.length) {
        captureRequire(arr, push);
        for (const c of existing) recordChunk(arr, c.ids, c.mods);
      }
    }
  } catch (e) {}
};
watchChunks();
// The page runs its scripts in document order, and its own inline ones first: the config a bundle reads
// (`window._white_config`, `__NEXT_DATA__`, a boot flag) is written by a `<script>` in the page, not by a bundle. A
// script the page's cap cut in half is not a script, so it is not run.
// A page that declares initial chunks (`__LOADABLE_REQUIRED_CHUNKS__`, loadable's contract) expects their components
// to be available synchronously on the first render, i.e. their module factories already evaluated. A browser gets
// there because its entry reaches them in its own order; a harness that registered the chunks but has not evaluated
// them yet meets a module mid-cycle, and a circular import reads a binding before initialization. Evaluate the
// declared initial chunks here, dependencies first, before the page's events — the runtime's own graph, no module id
// hard-coded.
const warmInitial = () => {
  if (spec.bootAll) return;
  const warmStarted = Date.now();
  let want = [];
  try { want = JSON.parse(String(g.__LOADABLE_REQUIRED_CHUNKS__ || '[]')); } catch (e) { want = []; }
  // Loadable's client reads the same list from the page's data block; take it the same way when the global is unset.
  if (!want || !want.length) {
    try {
      const m = /<script[^>]+id=["']__LOADABLE_REQUIRED_CHUNKS__["'][^>]*>([\s\S]*?)<\/script>/i.exec(spec.html || '');
      if (m) want = JSON.parse(m[1]);
    } catch (e) { want = []; }
  }
  const names = new Set((want || []).map(String));
  if (!names.size) return;
  const groups = [];
  const factories = new Map();
  for (const k of Object.keys(g)) {
    let arr; try { arr = g[k]; } catch (e) { continue; }
    if (!arr || !arr.__ub_chunks || !arr.__ub_require) continue;
    for (const c of arr.__ub_chunks) {
      if (!c.names.some((n) => names.has(n))) continue;
      groups.push({ ids: c.ids, req: arr.__ub_require });
      for (const id of c.ids) { const f = arr.__ub_require.m && arr.__ub_require.m[id]; if (f) factories.set(String(id), f); }
    }
  }
  if (!groups.length) return;
  const deps = (f) => {
    const out = new Set();
    const src = f && (f.__ub_src || String(f));
    if (!src) return [];
    const head = /^\s*(?:async\s*)?(?:function\s*)?\(([^)]*)\)/.exec(src);
    const params = head ? head[1].split(',') : [];
    const rn = String(params[2] || '').trim();
    const scan = (re) => { let m; while ((m = re.exec(src))) out.add(m[1]); };
    if (/^[A-Za-z_$][\w$]*$/.test(rn)) { try { scan(new RegExp('\\b' + rn.replace(/\$/g, '\\$') + '\\(\\s*(\\d{1,7})\\s*\\)', 'g')); } catch (e) {} }
    try { scan(/\b__webpack_require__\(\s*(\d{1,7})\s*\)/g); } catch (e) {}
    return Array.from(out);
  };
  const state = new Map();
  const order = [];
  const visit = (id, f) => {
    if (state.get(id)) return;
    state.set(id, 1);
    for (const d of deps(f)) { if (factories.has(String(d))) visit(String(d), factories.get(String(d))); }
    state.set(id, 2);
    order.push(String(id));
  };
  for (const c of groups) for (const id of c.ids) { if (factories.has(String(id))) visit(String(id), factories.get(String(id))); }
  const owner = new Map();
  for (const c of groups) for (const id of c.ids) if (!owner.has(String(id))) owner.set(String(id), c.req);
  let ok = 0, bad = 0, first = '';
  for (const id of order) {
    const r = owner.get(String(id));
    if (!r || !r.m || !has(r.m, id) || (r.c && has(r.c, id))) continue;
    try { r(id); ok += 1; }
    catch (e) { bad += 1; if (!first) first = id + ': ' + String((e && e.message) || e); }
  }
  if (process.env.UNBROWSE_SIGN_DEBUG) { try { process.stderr.write('[mods] warm ok=' + ok + ' bad=' + bad + ' in ' + (Date.now() - warmStarted) + ' ms' + (first ? ' first=' + first.slice(0, 160) : '') + '\n'); } catch (e) {} }
};
const bootOrder = () => {
  const byUrl = new Map();
  for (const s of scripts) { try { byUrl.set(new URL(s.url, spec.pageUrl).href, s.body); } catch (e) { byUrl.set(s.url, s.body); } }
  const list = [];
  const seen = new Set();
  let named = false;
  for (const t of tags) {
    if (t.tag !== 'script') continue;
    // A block the page carries as data (`application/json`, `application/ld+json`, a template) is not executed by a
    // browser, and its text is what the page's code reads from the element: run, it is only a syntax error.
    const type = String(t.attrs.type || '').toLowerCase().split(';')[0].trim();
    const runs = !type || /javascript|ecmascript|module/.test(type);
    if (!runs) continue;
    // A `<script type="module">` runs as a module, with its own scope and its imports linked: a bundler's shared
    // vendor chunk is a module with no `export` of its own, and running it as a classic script puts its bindings in
    // the page's global where they are undefined (Etsy's `chunk-a-vendor` read `p.createElement` and stopped the app).
    const asModule = /module/.test(type);
    if (t.attrs.src) {
      let abs = String(t.attrs.src);
      try { abs = new URL(abs, spec.pageUrl).href; } catch (e) {}
      if (byUrl.has(abs) && !seen.has(abs)) { seen.add(abs); named = true; list.push({ url: abs, body: byUrl.get(abs), module: asModule }); }
    } else if (t.close < spec.html.length && spec.html.slice(t.end, t.close).trim()) {
      const url = asModule ? spec.pageUrl + '#inline-' + list.length : 'inline:' + list.length;
      list.push({ url, body: spec.html.slice(t.end, t.close), module: asModule });
    }
  }
  // A script the document does not name is a lazy chunk, and a browser runs it only when the page asks for it. Run it
  // at boot and the page's own router finds it already registered, resolves it synchronously, and evaluates a module
  // out of its dependency order (a circular import then reads a binding before initialization). The page's loader
  // asks for it through `runScript` when it needs it. A program-shaped run is the exception: its scripts are the
  // evidence it was built from (`bootAll`), not a page's live chunk graph, so every one of them runs.
  // A document that names none of the bundle's scripts is the bundle itself (a test's page, a program's evidence):
  // there is nothing else to run, so run all of it. A document that names some is a live page, and the rest is its
  // own lazy graph, which its loader asks for when it needs it.
  if (spec.bootAll || !named) for (const [url, body] of byUrl) if (!seen.has(url)) list.push({ url, body });
  return list;
};
vm.createContext(g);
// What a page's script asks of a prototype it cannot see the property on: `Object.getOwnPropertyDescriptor(Proto, 'x')`
// answering undefined. A DOM library may hold the accessor one prototype up (happy-dom keeps `currentScript` on
// `Document.prototype` while the document's own prototype is `HTMLDocument.prototype`), and a vendor that wraps a
// property reads the descriptor rather than the value — so it throws on the first one and the page's own modules never
// run. Wrapped inside the page's own realm (its `Object` is not this one), one run names every such read and answers it
// from the prototype it lives on, so the page keeps going instead of stopping at the first.
let descMissing = [];
try {
  const seen = vm.runInContext(`(() => {
    const gopd = Object.getOwnPropertyDescriptor;
    const missing = [];
    Object.getOwnPropertyDescriptor = function (obj, name) {
      const d = gopd.call(Object, obj, name);
      if (d !== undefined) return d;
      const who = String((obj && obj.constructor && obj.constructor.name) || typeof obj);
      // A page that instruments DOM *constructors* asks the constructor for a property its instances have
      // (Object.getOwnPropertyDescriptor(HTMLDocument, 'currentScript')): the answer is on the constructor's
      // prototype, so that is searched too, before the read is given up on.
      const holders = [];
      for (let p = obj && Object.getPrototypeOf(obj); p; p = Object.getPrototypeOf(p)) holders.push(p);
      try { if (typeof obj === 'function' && obj.prototype) for (let p = obj.prototype; p; p = Object.getPrototypeOf(p)) holders.push(p); } catch (e) {}
      for (const p of holders) {
        const up = gopd.call(Object, p, name);
        if (up !== undefined) { missing.push(who + '.' + String(name)); return up; }
      }
      if (obj && typeof obj === 'object' && name in obj) missing.push(who + '.' + String(name) + '(inherited)');
      return undefined;
    };
    return missing;
  })()`, g);
  descMissing = seen || [];
} catch (e) {}
// The answer is written on the clock, not after the scripts finish: a chunk that never loads must not cost the call
// its output (what the page did say so far is the answer). The window slides with each call, up to the hard cap —
// and it starts after the page has booted, so a slow boot (a page with a hundred chunks) is not cut off mid-way.
// A backstop covers a boot that hangs (a consent iframe that never answers): the partial page is still an answer.
const backstop = setTimeout(done, spec.settleMs + 64000);
(async () => {
  const bootStarted = Date.now();
  let bootRan = 0;
  for (const s of bootOrder()) {
    bootRan += 1;
    try {
      if (process.env.UNBROWSE_SIGN_DEBUG) { try { process.stderr.write('[boot] ' + s.url + '\n'); } catch (e) {} }
      noteUsed(s.url);
      // The page is still booting: keep the answer's quiet window from firing in the middle of its own scripts.
      if (settleTimer) clearTimeout(settleTimer);
      if (s.module) {
        // A module's scope is its own; its imports link through the same line as the page's fetches.
        await loadModule(String(s.url), String(s.body));
        watchChunks();
        continue;
      }
      // `import()` is a keyword a script cannot be parsed with, and `import.meta` a module's. Both become calls this
      // harness answers: the chunk comes over the same line as a fetch, and runs here.
      const body = String(s.body).replace(/\bimport\s*\(/g, '__ubImport(').replace(/\bimport\.meta\b/g, '__ubMeta');
      vm.runInContext(body, g, { filename: s.url, timeout: spec.scriptMs });
      watchChunks();
    } catch (e) {
      try {
        // A classic run fails on a module (`export`, `import`, `import.meta`), and also on a bundle whose syntax only
        // a module grammar accepts (`Invalid or unexpected token` from a top-level `import`). Try it as one.
        const said = String((e && e.message) || e);
        if (!/export|import|module|Invalid or unexpected token|Unexpected token/i.test(said)) {
          // A page's own script threw at runtime — a tag's `insertBefore`, a missing global: that is the page's
          // business, not the end of the answer. Record it and let the rest of the page boot; a single third-party
          // tag must not take the app's own scripts with it.
          errors += 1;
          if (errs.length < 8) errs.push(s.url + ' :: ' + why(e));
          continue;
        }
        await loadModule(s.url, String(s.body));
      } catch (e2) { errors += 1; if (errs.length < 8) errs.push(s.url + ' :: ' + why(e2)); }
    }
  }
  // The document is ready, and then loaded: the events a page's own start-up listens for.
  if (process.env.UNBROWSE_SIGN_DEBUG) { try { process.stderr.write('[boot] ran ' + bootRan + ' scripts in ' + (Date.now() - bootStarted) + ' ms\n'); } catch (e) {} }
  // The page has booted: the quiet window starts now, and a hard cap after it, so a slow boot is answered, not cut off.
  clearTimeout(backstop);
  arm();
  setTimeout(done, spec.settleMs + 4000);
  // The page's first render assumes its declared initial chunks are evaluated: hand it that state, in its own graph's
  // order, before its events run.
  if (!spec.bootAll) warmInitial();
  if (process.env.UNBROWSE_SIGN_DEBUG) { try { process.stderr.write('[boot] DOMContentLoaded\n'); } catch (e) {} }
  g.document.readyState = 'complete';
  fire('DOMContentLoaded');
  if (typeof g.onload === 'function') { try { g.onload({ type: 'load' }); } catch (e) { errors += 1; } }
  fire('load');
  if (typeof g.document.onload === 'function') { try { g.document.onload({ type: 'load' }); } catch (e) { errors += 1; } }
  // The page has booted and its load event has fired: nudge it once now and once after a tick, as a reader scrolling
  // into view would. A page that fetches on scroll makes its call; the settle window waits for it.
  readerNudge();
  setTimeout(readerNudge, 150);
  // A page in a browser is visible and focused: a data layer gated on visibility or focus runs then, and this page is
  // as visible as a headless browser's own.
  try { Object.defineProperty(g.document, 'visibilityState', { get: () => 'visible', configurable: true }); g.document.hidden = false; } catch (e) {}
  try { if (typeof g.document.hasFocus === 'function') g.document.hasFocus = () => true; } catch (e) {}
  try { if (typeof g.focus === 'function') g.focus(); } catch (e) {}
  try {
    const FocusEvent = g.Event || function (type) { return { type: type }; };
    g.document.dispatchEvent(new FocusEvent('visibilitychange'));
    g.dispatchEvent(new FocusEvent('focus'));
  } catch (e) {}
  // A standard consent surface: a page gated on a CMP's callback waits for `__tcfapi`/`__gpp`. Report the consent the
  // walk already had — the cookies the browser's page held — never a new grant: the owner's consent is the walk's, and
  // a page that was denied stays denied.
  try {
    const consentPairs = () => String((g.document && g.document.cookie) || '').split(';').map((p) => { const i = p.indexOf('='); return i > 0 ? [p.slice(0, i).trim(), p.slice(i + 1).trim()] : null; }).filter(Boolean);
    const consentCookie = (names) => { for (const [k, v] of consentPairs()) { if (names.some((n) => k.toLowerCase().indexOf(n) >= 0)) return v; } return ''; };
    if (typeof g.__tcfapi !== 'function') {
      g.__tcfapi = (command, version, callback) => {
        try {
          const tc = consentCookie(['euconsent', 'consent', 'optanonconsent']);
          if (typeof callback === 'function') callback({ cmpStatus: 'loaded', tcString: tc, eventStatus: 'tcloaded', gdprApplies: true, purpose: { consents: {} }, vendor: { consents: {} } }, true);
        } catch (e) {}
      };
    }
    if (typeof g.__gpp !== 'function') {
      g.__gpp = (command, callback) => {
        try {
          const gpp = consentCookie(['gpp', 'gppstring', 'usnat']);
          if (typeof callback === 'function') callback({ gppString: gpp, gppVersion: '1.1', gppsid: [], apiVersion: '1.1', eventName: 'signalstatus', data: {}, applicableSections: [] }, true);
        } catch (e) {}
      };
    }
  } catch (e) {}
  // A consent manager registers the page's callbacks on `ready(fn)` and runs them when its own third-party bundle
  // answers, usually through an iframe this sandbox has no channel to. The queue then waits forever, and a data layer
  // that only fetches once consent is up never fetches (Etsy's search: one callback queued, none run). Running them is
  // what `ready` means — the CMP is up — not a grant: the consent reported beside it is still the walk's own, and
  // nothing optional is set. A callback the page cannot take is swallowed, never counted as the page's error.
  const drainGates = () => {
    for (const k of Object.keys(g)) {
      if (!/consent|tcf|gpp|cmp|funding|airgap/i.test(k)) continue;
      let gate; try { gate = g[k]; } catch (e) { continue; }
      if (!gate || typeof gate.ready !== 'function') continue;
      let q; try { q = gate.readyQueue || gate.queue || gate.waiting; } catch (e) { continue; }
      if (!Array.isArray(q) || !q.length) continue;
      const waiting = q.splice(0, q.length);
      for (const f of waiting) { try { f(); } catch (e) { if (process.env.UNBROWSE_SIGN_DEBUG) { try { process.stderr.write('[gate] ' + k + ' callback threw: ' + String((e && e.message) || e) + '\n'); } catch (_) {} } } }
      if (process.env.UNBROWSE_SIGN_DEBUG) { try { process.stderr.write('[gate] ran ' + waiting.length + ' callback(s) queued on ' + k + '\n'); } catch (e) {} }
    }
  };
  drainGates();
  setTimeout(drainGates, 50);
  setTimeout(drainGates, 400);
  // What the page is waiting on, when the caller asks: a bounded summary of its own state, for a gate that is not a
  // missing API but a flag, a root, or a consent string.
  if (process.env.UNBROWSE_SIGN_DEBUG) {
    try {
      const storeKeys = (store) => { const out = []; try { const n = store && store.length || 0; for (let i = 0; i < Math.min(n, 40); i++) { const k = store.key(i); if (k) out.push(k); } } catch (e) {} return out; };
      // What the page has and what it is waiting on: the elements at the top of the body, and the consent globals a
      // gate registers (one that exposes `ready` is where a page's boot waits for a third party). The body's shape says
      // whether the carried markup kept the mount the page's app renders into; nothing here names a site.
      const gated = Object.keys(g).filter((k) => /consent|tcf|gpp|cmp|funding|airgap/i.test(k)).slice(0, 20);
      const kids = [];
      try {
        const body = g.document.body;
        const first = body && body.children;
        const n = first && first.length || 0;
        for (let i = 0; i < Math.min(n, 12); i++) { const el = first[i]; if (el) kids.push(String(el.tagName || '?').toLowerCase() + (el.id ? '#' + el.id : '')); }
      } catch (e) {}
      const summary = {
        url: (g.location && g.location.href) || '',
        visibility: (g.document && g.document.visibilityState) || '',
        cookies: String((g.document && g.document.cookie) || '').split(';').map((p) => p.split('=')[0].trim()).filter(Boolean).slice(0, 40),
        local: storeKeys(g.localStorage),
        session: storeKeys(g.sessionStorage),
        root: !!(g.document && g.document.getElementById && g.document.getElementById('root')),
        bodyKids: kids,
        consent: gated,
        // A gate that takes callbacks and has not run them: the page's boot is waiting on a third party (a consent
        // iframe, a challenge widget) that this sandbox has no way to answer. The count is what tells a queued boot
        // from a page that simply has the global.
        waitingOn: gated.filter((k) => { try { return typeof g[k].ready === 'function'; } catch (e) { return false; } })
          .map((k) => {
            try {
              const q = g[k] && (g[k].readyQueue || g[k].queue || g[k].waiting);
              return Array.isArray(q) ? k + ':' + q.length : k + ':?';
            } catch (e) { return k + ':?'; }
          }),
      };
      process.stderr.write('[page-state] ' + JSON.stringify(summary) + '\n');
    } catch (e) {}
  }
})();

"#;

pub(crate) fn runtime() -> Option<String> {
    std::env::var("SIGNING_PROGRAM").ok().filter(|p| !p.trim().is_empty()).or_else(|| {
        // The owner's own JS runtime, when it is on the path: the same arrangement as the browser program.
        node_on_path(&std::env::var_os("PATH")?)
    })
}

/// The first `node` (`node.exe` on Windows) in the folders `path` lists, read straight from the folders. A Unix shell
/// was asked before (`sh -c 'command -v node'`): Windows has none, or Git's, which answers `/c/...`, a path no Windows
/// program opens, so the sandbox never ran there and the page's values came from the browser instead.
fn node_on_path(path: &std::ffi::OsStr) -> Option<String> {
    std::env::split_paths(path)
        .filter(|d| !d.as_os_str().is_empty())
        .flat_map(|d| [d.join("node.exe"), d.join("node")])
        .find(|c| c.is_file())
        .map(|c| c.to_string_lossy().into_owned())
}

/// Whether this machine can run a bundle at all: a runtime, and one it can confine.
pub fn available() -> bool {
    runtime().is_some_and(|p| confined(&p).is_some())
}

/// Why this machine runs no page's code, where it runs none, as the confinement probe found it ([`confined`]): no
/// runtime at all; a runtime that lacks what its own layer needs (a permission model, a realm of its own, modules, or
/// any answer when started under them); or a layer that did not hold, named as the probe named it. What a learn's note
/// and a call's fallback say, so neither tells an owner with a runtime that it has none, nor names a version the probe
/// never checked. It reads the probe's refusal; what runs is decided by [`confined`] alone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unheld {
    NoRuntime,
    /// The runtime lacks what its own layer needs: what the probe found missing.
    Lacks(String),
    /// A layer the node relies on did not hold here: which, and how, as the probe said ([`layers_hold`]).
    NotConfined(String),
}

impl Unheld {
    /// The reason, as a node says it to an agent and in its log.
    pub fn said(&self) -> String {
        match self {
            Unheld::NoRuntime => "this machine has no JavaScript runtime to run the page's code in".to_string(),
            Unheld::Lacks(what) => format!("this machine's JavaScript runtime can't be held to the page's code: it {what}"),
            Unheld::NotConfined(why) => format!("this machine can't hold the page's code: {why}"),
        }
    }
}

/// Why no page's code is run here ([`Unheld`]), or None where it can be ([`available`]).
pub fn unheld() -> Option<Unheld> {
    unheld_for(runtime().as_deref())
}

fn unheld_for(runtime: Option<&str>) -> Option<Unheld> {
    let Some(runtime) = runtime.filter(|r| resolve(r).is_some()) else { return Some(Unheld::NoRuntime) };
    if confined(runtime).is_some() {
        return None;
    }
    let refused = REFUSED.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|r| r.get(runtime).cloned());
    Some(refused.unwrap_or_else(|| Unheld::NotConfined("its confinement could not be shown".to_string())))
}

/// What the probe of each runtime refused it for, by the name it was probed under: read by [`unheld`], never by
/// [`confined`].
static REFUSED: std::sync::Mutex<Option<HashMap<String, Unheld>>> = std::sync::Mutex::new(None);

/// The reason a probe's refusal ([`layers_hold`]) stands for, or None where every layer held. A runtime that answered
/// under no layer it was started with, or whose answer lacks the permission model, a realm or modules, lacks what its
/// own layer needs; anything else is a layer that did not hold, said as the probe said it.
fn refusal_of(p: &Probed, held: &Result<(), String>) -> Option<Unheld> {
    let why = held.as_ref().err()?;
    let is = |v: &serde_json::Value, k: &str, want: &str| v.get(k).and_then(|x| x.as_str()) == Some(want);
    let Some(all) = p.all.as_ref() else {
        // Started under its own permission model alone it answered: what stopped it was the other layer.
        if p.runtime_alone.is_some() {
            return Some(Unheld::NotConfined(why.clone()));
        }
        return Some(Unheld::Lacks("gave no answer when started under its own permission model's flags".to_string()));
    };
    let lacks = if all.get("perm").and_then(|x| x.as_bool()) != Some(true) {
        Some("has no permission model (process.permission)")
    } else if !is(all, "realm", "symbol") {
        Some("has no realm of its own (vm.constants.DONT_CONTEXTIFY)")
    } else if !is(all, "modules", "function") {
        Some("has no modules for a realm (vm.SourceTextModule)")
    } else {
        None
    };
    Some(match lacks {
        Some(what) => Unheld::Lacks(format!("{what}; a newer Node has it")),
        None => Unheld::NotConfined(why.clone()),
    })
}

// ---- the confined runtime ----
//
// The page's code and a generated program are adversarial input, and so is everything they say back. They run in a
// child process that can do nothing by itself, each layer denying on its own:
// - the runtime's own permission model: no file read past the run's own folder, no write, no child process, no worker,
//   no addon, no inspector;
// - the operating system's sandbox where there is one: on macOS a profile that denies by default (no network, no
//   process, no file outside the runtime's own and the run's), on Linux a network namespace (or a filter refusing
//   internet sockets where namespaces are off);
// - an empty environment, a private folder made fresh for the run (0700, files 0600) and removed after it;
// - limits the node enforces by killing the child: wall time, CPU time, resident memory.
// Inside it, the page's realm holds nothing of the runtime's (`BOOT`, `PRELUDE`). The only way out is a line to the
// node, which decides what is fetched ([`answer`]). A runtime whose layers do not hold, checked by trying them
// ([`probe`]), runs no page code at all: the call goes to the browser, as it does on a machine with no runtime.

/// The most resident memory one run may hold, in MiB: `UNBROWSE_SANDBOX_MB`, else 1024. Past it the run is killed.
fn memory_mb() -> u64 {
    std::env::var("UNBROWSE_SANDBOX_MB").ok().and_then(|v| v.trim().parse().ok()).filter(|n: &u64| *n >= 64).unwrap_or(1024)
}

/// What one run may take: time to start, time to answer once started, and memory.
#[derive(Clone, Copy, Debug)]
struct Limits {
    ready: std::time::Duration,
    wall: std::time::Duration,
    memory_mb: u64,
    /// The most a run may say to the node in all, every line counted: past it the run is cut.
    said_bytes: usize,
}

impl Limits {
    fn new(wall: std::time::Duration) -> Self {
        Self { ready: std::time::Duration::from_secs(20), wall, memory_mb: memory_mb(), said_bytes: RUN_SAID_MAX }
    }
}

/// A run's own folder: a name nobody can guess, made fresh (an existing one is never used), readable by the owner
/// only, and removed with everything in it when the run ends.
struct RunDir {
    path: std::path::PathBuf,
}

impl RunDir {
    fn new(kind: &str) -> Option<Self> {
        Self::new_in(&std::env::temp_dir(), kind)
    }

    /// The same under `base`: a socket's address has a short length limit, which a deep temporary folder can pass.
    fn new_in(base: &std::path::Path, kind: &str) -> Option<Self> {
        use std::hash::BuildHasher;
        static RUNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        for _ in 0..8 {
            let n = RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let a = std::collections::hash_map::RandomState::new().hash_one((std::process::id(), n, std::time::SystemTime::now()));
            let b = std::collections::hash_map::RandomState::new().hash_one((a, n));
            let path = base.join(format!("unbrowse-{kind}-{a:016x}{b:016x}"));
            #[cfg(unix)]
            let made = {
                use std::os::unix::fs::DirBuilderExt;
                std::fs::DirBuilder::new().mode(0o700).create(&path)
            };
            #[cfg(not(unix))]
            let made = std::fs::create_dir(&path);
            match made {
                Ok(()) => {
                    // The runtime and the sandbox read the folder by its real name (`/tmp` is `/private/tmp` on macOS).
                    return match path.canonicalize() {
                        Ok(real) => Some(Self { path: real }),
                        Err(_) => {
                            let _ = std::fs::remove_dir(&path);
                            None
                        }
                    };
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return None,
            }
        }
        None
    }

    /// Writes a new file in the folder, readable by the owner only. A file already there is never written through.
    fn write(&self, name: &str, bytes: &[u8]) -> Option<std::path::PathBuf> {
        use std::io::Write;
        let path = self.path.join(name);
        let mut open = std::fs::OpenOptions::new();
        open.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            open.mode(0o600);
        }
        let mut file = open.open(&path).ok()?;
        file.write_all(bytes).ok()?;
        Some(path)
    }
}

impl Drop for RunDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// A runtime whose layers held when it was tried: its real path, and the shared libraries it loads (the operating
/// system's layer lets it read those and nothing else of the machine's own).
#[derive(Clone, Debug)]
struct Confined {
    node: std::path::PathBuf,
    #[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
    libraries: Vec<std::path::PathBuf>,
}

/// The program named, found the way a shell finds it, by its real path.
fn resolve(program: &str) -> Option<std::path::PathBuf> {
    let named = std::path::Path::new(program);
    let found = if named.is_absolute() || named.components().count() > 1 {
        Some(named.to_path_buf())
    } else {
        let paths = std::env::var_os("PATH")?;
        std::env::split_paths(&paths).flat_map(|d| [d.join(program), d.join(format!("{program}.exe"))]).find(|c| c.is_file())
    };
    found?.canonicalize().ok()
}

/// The runtime `program` names, confined, or None when it can't be: page code then never runs on this machine.
fn confined(program: &str) -> Option<Confined> {
    static PROBED: std::sync::Mutex<Option<HashMap<String, Option<Confined>>>> = std::sync::Mutex::new(None);
    let mut held = PROBED.lock().unwrap_or_else(|e| e.into_inner());
    let known = held.get_or_insert_with(HashMap::new);
    if let Some(c) = known.get(program) {
        return c.clone();
    }
    let c = probe(program);
    if c.is_none() && resolve(program).is_some() {
        eprintln!("   [sign] {program} can't be confined on this machine (a layer that denies files, processes and network didn't hold): page code is not run here, and a page that signs goes to the browser");
    }
    known.insert(program.to_string(), c.clone());
    c
}

/// The probe a runtime is tried with: everything a page's code must not do, tried for real, from inside whichever
/// layers it is started under. Each line says `denied` or `allowed`; `n/a` where the platform has no such thing.
const PROBE: &str = r#"'use strict';
const fs = require('fs'), path = require('path'), net = require('net'), vm = require('vm');
const [secret, port, home, unixPath, abstractName] = process.argv.slice(2);
const r = { perm: !!process.permission, realm: typeof (vm.constants && vm.constants.DONT_CONTEXTIFY), modules: typeof vm.SourceTextModule };
const denied = (f) => { try { f(); return 'allowed'; } catch (e) { return 'denied'; } };
r.read = denied(() => fs.readFileSync(secret));
r.home = denied(() => fs.readdirSync(home));
r.write = denied(() => fs.writeFileSync(secret + '.w', 'x'));
r.writeHere = denied(() => fs.writeFileSync(path.join(__dirname, 'w'), 'x'));
r.writeHome = denied(() => fs.writeFileSync(path.join(home, '.unbrowse-sandbox-probe'), 'x'));
r.exec = denied(() => require('child_process').execFileSync(process.execPath, ['-e', '0'], { stdio: 'ignore' }));
r.shell = denied(() => require('child_process').execFileSync('/bin/sh', ['-c', 'true'], { stdio: 'ignore' }));
r.worker = denied(() => new (require('worker_threads').Worker)('0', { eval: true }));
r.env = Object.keys(process.env).filter((k) => k !== '__CF_USER_TEXT_ENCODING').length;
const waits = [['net', { port: Number(port), host: '127.0.0.1' }], ['unix', { path: unixPath }]];
if (abstractName) waits.push(['abstract', { path: '\0' + abstractName }]); else r.abstract = 'n/a';
let left = waits.length;
const end = () => { if (--left === 0) { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(0); } };
for (const [k, opts] of waits) {
  let said = false;
  const f = (v) => { if (!said) { said = true; r[k] = v; end(); } };
  try {
    const s = net.connect(opts);
    s.on('connect', () => { f('allowed'); try { s.destroy(); } catch (e) {} });
    s.on('error', () => f('denied'));
    setTimeout(() => f('denied'), 3000);
  } catch (e) { f('denied'); }
}
"#;

/// Which of a confined command's layers it runs under: all of them, as page code does, or one alone, as the probe
/// runs each to show it denies by itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Layers {
    All,
    /// The operating system's layer, with the runtime's permission model off.
    OsAlone,
    /// The runtime's permission model, with the operating system's layer off.
    RuntimeAlone,
}

/// Whether the operating system refused a mach service lookup from inside the profile (macOS); `Absent` where the
/// platform has none, `Unknown` where the probe could not tell.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mach {
    // Built only by the macOS probe (`probe_mach`); elsewhere only `Absent` is.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Denied,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Allowed,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Unknown,
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Absent,
}

/// What every probe of a runtime said: under all its layers, under each alone, and whether a socket the node held open
/// heard from it under a layer the node relies on to keep it off the network (all of them, or the operating system's
/// alone; the runtime's permission model is not relied on for the network).
#[derive(Clone, Debug, Default)]
struct Probed {
    all: Option<serde_json::Value>,
    os_alone: Option<serde_json::Value>,
    runtime_alone: Option<serde_json::Value>,
    mach: Option<Mach>,
    heard: bool,
}

/// Whether every layer the node relies on was shown to deny by itself (and all of them together), the one decision
/// the node runs page code on. A platform where the operating system's layer can't be shown to hold alone, the
/// runtime's alone, or the two together, runs no page code: the step goes to the browser.
fn layers_hold(p: &Probed) -> Result<(), String> {
    let is = |v: &serde_json::Value, k: &str, want: &str| v.get(k).and_then(|x| x.as_str()) == Some(want);
    let denies = |v: &serde_json::Value, keys: &[&str]| -> Result<(), String> {
        match keys.iter().find(|k| !is(v, k, "denied") && !(**k == "abstract" && is(v, k, "n/a"))) {
            Some(k) => Err(format!("`{k}` was not denied")),
            None => Ok(()),
        }
    };
    if p.heard {
        return Err("a socket the node held open heard from the probe under a layer relied on to keep it off the network".into());
    }
    let all = p.all.as_ref().ok_or("the runtime gave no answer under all its layers")?;
    if !(all.get("perm").and_then(|x| x.as_bool()) == Some(true) && is(all, "realm", "symbol") && is(all, "modules", "function")) {
        return Err("the runtime has no permission model, no realm of its own or no modules".into());
    }
    if all.get("env").and_then(|e| e.as_u64()) != Some(0) {
        return Err("the runtime saw the node's environment".into());
    }
    denies(all, &["read", "home", "write", "writeHere", "writeHome", "exec", "shell", "worker", "net", "unix", "abstract"]).map_err(|e| format!("under all layers, {e}"))?;
    let os = p.os_alone.as_ref().ok_or("this platform has no operating-system layer that can be shown to hold by itself")?;
    if os.get("perm").and_then(|x| x.as_bool()) != Some(false) {
        return Err("the operating system's layer was not probed alone".into());
    }
    denies(os, &["read", "home", "write", "writeHere", "writeHome", "exec", "shell", "net", "unix", "abstract"]).map_err(|e| format!("under the operating system's layer alone, {e}"))?;
    match p.mach {
        Some(Mach::Denied) | Some(Mach::Absent) => {}
        Some(Mach::Allowed) => return Err("under the operating system's layer alone, a mach service lookup was not denied".into()),
        _ => return Err("whether the operating system's layer denies a mach service lookup could not be shown".into()),
    }
    let rt = p.runtime_alone.as_ref().ok_or("the runtime's permission model was not probed alone")?;
    if rt.get("perm").and_then(|x| x.as_bool()) != Some(true) {
        return Err("the runtime's permission model was off when it was probed alone".into());
    }
    denies(rt, &["read", "home", "write", "writeHere", "writeHome", "exec", "shell", "worker"]).map_err(|e| format!("under the runtime's permission model alone, {e}"))
}

/// Runs the probe under `layers` and answers what it said, and whether the node's sockets heard from it.
fn probe_under(c: &Confined, layers: Layers, home: &std::path::Path) -> Option<(serde_json::Value, bool)> {
    use std::io::Read;
    let dir = RunDir::new("probe")?;
    let outside = RunDir::new("probe-outside")?;
    let secret = outside.write("secret", b"the node's own")?;
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
    listener.set_nonblocking(true).ok()?;
    let port = listener.local_addr().ok()?.port();
    // A Unix socket's address is short (104 bytes on macOS): it is made in a fresh private folder under `/tmp`.
    #[cfg(unix)]
    let sockets = RunDir::new_in(std::path::Path::new("/tmp"), "s")?;
    #[cfg(unix)]
    let unix_path = sockets.path.join("s");
    #[cfg(unix)]
    let unix = std::os::unix::net::UnixListener::bind(&unix_path).ok()?;
    #[cfg(unix)]
    unix.set_nonblocking(true).ok()?;
    #[cfg(not(unix))]
    let unix_path = outside.path.join("s");
    // An abstract socket (Linux): one the owner's own programs might listen on, with no file a folder rule covers.
    #[cfg(target_os = "linux")]
    let abstract_name = format!("unbrowse-probe-{}", outside.path.file_name()?.to_string_lossy());
    #[cfg(target_os = "linux")]
    let abstract_listener = {
        use std::os::linux::net::SocketAddrExt;
        let addr = std::os::unix::net::SocketAddr::from_abstract_name(abstract_name.as_bytes()).ok()?;
        let l = std::os::unix::net::UnixListener::bind_addr(&addr).ok()?;
        l.set_nonblocking(true).ok()?;
        l
    };
    #[cfg(not(target_os = "linux"))]
    let abstract_name = String::new();
    let script = dir.write("probe.js", PROBE.as_bytes())?;
    let mut cmd = c.command_with(&dir, std::time::Duration::from_secs(15), layers);
    cmd.arg(&script).arg(&secret).arg(port.to_string()).arg(home).arg(&unix_path);
    if !abstract_name.is_empty() {
        cmd.arg(&abstract_name);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let read = std::thread::spawn(move || {
        let mut said = String::new();
        let _ = std::io::BufReader::new(stdout).take(1 << 16).read_line(&mut said);
        said
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while child.try_wait().ok().flatten().is_none() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let _ = child.kill();
    let _ = child.wait();
    let said = read.join().ok()?;
    // What a probe left behind where it should have been denied goes: the owner's home keeps nothing of it.
    let _ = std::fs::remove_file(home.join(".unbrowse-sandbox-probe"));
    #[allow(unused_mut)]
    let mut heard = listener.accept().is_ok();
    #[cfg(unix)]
    {
        heard |= unix.accept().is_ok();
    }
    #[cfg(target_os = "linux")]
    {
        heard |= abstract_listener.accept().is_ok();
    }
    Some((serde_json::from_str(said.trim()).ok()?, heard))
}

/// Whether the macOS profile, by itself, refuses a mach service lookup: a system tool that answers a user lookup only
/// through the directory service's mach port is run under the profile (allowed to start, nothing else added) and must
/// fail, where the same tool outside it answers. Absent on any other platform.
fn mach_probe(c: &Confined) -> Mach {
    #[cfg(target_os = "macos")]
    {
        let tool = std::path::Path::new("/usr/bin/id");
        let Some(dir) = RunDir::new("probe-mach") else { return Mach::Unknown };
        let ask = |cmd: &mut Command| -> Option<String> {
            let out = cmd.args(["-un", "0"]).env_clear().stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
        };
        let Some(outside) = ask(&mut Command::new(tool)) else { return Mach::Unknown };
        if outside.is_empty() {
            return Mach::Unknown;
        }
        let mut inside = Command::new("/usr/bin/sandbox-exec");
        inside.arg("-p").arg(macos_profile(c, &dir.path, Some(tool))).arg(tool);
        match ask(&mut inside) {
            Some(said) if said == outside => Mach::Allowed,
            Some(_) => Mach::Denied,
            None => Mach::Unknown,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = c;
        Mach::Absent
    }
}

/// Tries every layer for real, together and each by itself: the runtime is started and asked to read a file outside
/// its folder and the owner's home, write anywhere, start a process, connect to a socket the node holds open (TCP, a
/// Unix socket, an abstract one on Linux) and read the node's environment; on macOS a mach service lookup is tried
/// under the profile alone. A runtime is used only when [`layers_hold`] says every layer held by itself.
fn probe(program: &str) -> Option<Confined> {
    let node = resolve(program)?;
    let libraries = libraries_of(&node);
    let c = Confined { node, libraries };
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(std::path::PathBuf::from).unwrap_or_else(|| "/".into());
    let mut p = Probed::default();
    let mut heard = false;
    for layers in [Layers::All, Layers::OsAlone, Layers::RuntimeAlone] {
        // A platform with no operating-system layer has nothing to run alone.
        if layers == Layers::OsAlone && !os_layer_exists() {
            continue;
        }
        let Some((said, h)) = probe_under(&c, layers, &home) else { continue };
        heard |= h && layers != Layers::RuntimeAlone;
        match layers {
            Layers::All => p.all = Some(said),
            Layers::OsAlone => p.os_alone = Some(said),
            Layers::RuntimeAlone => p.runtime_alone = Some(said),
        }
    }
    p.heard = heard;
    p.mach = Some(mach_probe(&c));
    let held = layers_hold(&p);
    if let Some(why) = refusal_of(&p, &held) {
        REFUSED.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(program.to_string(), why);
    }
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() || held.is_err() {
        eprintln!("   [sign] confinement probe of {}: all {:?}; os alone {:?}; runtime alone {:?}; mach {:?} -> {}", c.node.display(), p.all, p.os_alone, p.runtime_alone, p.mach, match &held {
            Ok(()) => "every layer held".to_string(),
            Err(why) => format!("refused: {why}"),
        });
    }
    held.ok().map(|()| c)
}

/// Whether this platform has an operating-system layer the node can put a runtime under.
fn os_layer_exists() -> bool {
    os_layer_on(std::env::consts::OS, std::path::Path::new("/usr/bin/sandbox-exec").is_file())
}

/// The platforms with an operating-system layer: macOS (with `sandbox-exec`) and Linux (landlock with a seccomp
/// filter). Anywhere else, Windows included, there is none to show holding, no hard CPU or memory limit either, and
/// page code doesn't run: the step goes to the browser, however well the runtime's own model holds there.
fn os_layer_on(platform: &str, sandbox_exec: bool) -> bool {
    match platform {
        "macos" => sandbox_exec,
        "linux" => true,
        _ => false,
    }
}

/// The shared libraries the runtime loads, as it reports them itself (no page code runs for this): a runtime a
/// package manager installed links libraries from beside it, and the operating system's layer lets it read those.
fn libraries_of(node: &std::path::Path) -> Vec<std::path::PathBuf> {
    if !cfg!(any(target_os = "macos", target_os = "linux")) {
        return Vec::new();
    }
    let said = Command::new(node)
        .args(["-e", "process.stdout.write(JSON.stringify(process.report.getReport().sharedObjects || []))"])
        .env_clear()
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let Ok(said) = said else { return Vec::new() };
    serde_json::from_slice::<Vec<String>>(&said.stdout).unwrap_or_default().into_iter().map(std::path::PathBuf::from).filter(|p| p.is_absolute()).collect()
}

/// A path as a string in a sandbox profile.
#[cfg(target_os = "macos")]
fn profile_string(p: &std::path::Path) -> String {
    format!("\"{}\"", p.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\""))
}

/// The macOS profile: nothing is allowed but starting the runtime, reading what it is made of (itself, its libraries,
/// the system's) and the run's own folder, and writing to nowhere. No network, no other process, no mach service, no
/// other file. `also_exec` lets one more program start (and be read), for the probe's mach test only.
#[cfg(target_os = "macos")]
fn macos_profile(c: &Confined, dir: &std::path::Path, also_exec: Option<&std::path::Path>) -> String {
    let mut reads = vec![profile_string(&c.node), profile_string(dir)];
    reads.extend(c.libraries.iter().map(|l| profile_string(l)));
    let literal = |s: &String| format!("(literal {s})");
    let extra = also_exec.map(|p| format!("(allow process-exec (literal {0}))\n(allow file-read* (literal {0}))\n", profile_string(p))).unwrap_or_default();
    format!(
        "(version 1)\n(deny default)\n(allow process-exec (literal {node}))\n{extra}(allow file-read* (literal \"/\") {libs} (subpath {dir}) (subpath \"/usr/lib\") (subpath \"/System\") (subpath \"/private/var/db/dyld\") (subpath \"/Library/Apple/System\") (subpath \"/usr/share/zoneinfo\") (subpath \"/private/var/db/timezone\") (literal \"/dev/urandom\") (literal \"/dev/random\") (literal \"/dev/null\"))\n(allow file-read-metadata)\n(allow file-write-data (literal \"/dev/null\"))\n(allow sysctl-read)\n(allow process-info* (target self))\n(allow signal (target self))\n",
        node = reads[0],
        dir = reads[1],
        libs = reads[2..].iter().map(literal).collect::<Vec<_>>().join(" "),
    )
}

impl Confined {
    /// The runtime started confined in `dir` under every layer, its CPU time held to `cpu`: arguments after this are
    /// the script's.
    fn command(&self, dir: &RunDir, cpu: std::time::Duration) -> Command {
        self.command_with(dir, cpu, Layers::All)
    }

    /// The same under the layers named: the probe runs each alone to show it denies by itself.
    fn command_with(&self, dir: &RunDir, cpu: std::time::Duration, layers: Layers) -> Command {
        let os = layers != Layers::RuntimeAlone;
        #[cfg(target_os = "macos")]
        let mut cmd = if os {
            let mut c = Command::new("/usr/bin/sandbox-exec");
            c.arg("-p").arg(macos_profile(self, &dir.path, None)).arg(&self.node);
            c
        } else {
            Command::new(&self.node)
        };
        #[cfg(not(target_os = "macos"))]
        let mut cmd = Command::new(&self.node);
        if layers != Layers::OsAlone {
            cmd.arg("--permission").arg(format!("--allow-fs-read={}", dir.path.display()));
        }
        // The runtime's OpenSSL reads the system's configuration at start (`/etc/ssl/openssl.cnf` on Linux) and fails
        // to start when it is refused: it is given an empty one instead, so the layer reaches no more of `/etc`.
        #[cfg(unix)]
        cmd.arg("--openssl-config=/dev/null");
        cmd.arg("--experimental-vm-modules")
            .arg(format!("--max-old-space-size={}", (memory_mb() / 2).max(64)))
            .env_clear()
            .current_dir(&dir.path);
        #[cfg(unix)]
        hold_to_limits(&mut cmd, cpu, os.then(|| os_rules(self, &dir.path)));
        #[cfg(not(unix))]
        let _ = (cpu, os);
        cmd
    }
}

/// What the Linux layer lets the runtime touch: read the runtime's own file, the libraries it reports loading and the
/// system's libraries (and run them, for the runtime to start), read the run's folder and the few files a runtime
/// reads at start, write only `/dev/null`. Nothing else of the machine is reachable: not the folder the runtime was
/// installed in (a runtime in `~/.local/bin` would otherwise open `~/.local` to the page), and not the owner's home.
#[cfg(unix)]
#[derive(Default)]
struct OsRules {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    paths: Vec<(std::ffi::CString, u64)>,
}

#[cfg(unix)]
fn os_rules(c: &Confined, dir: &std::path::Path) -> OsRules {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;
        const EXECUTE: u64 = 1;
        const WRITE_FILE: u64 = 2;
        const READ_FILE: u64 = 4;
        const READ_DIR: u64 = 8;
        let mut paths: Vec<(std::path::PathBuf, u64)> = vec![(c.node.clone(), EXECUTE | READ_FILE), (dir.to_path_buf(), READ_FILE | READ_DIR)];
        paths.extend(c.libraries.iter().map(|l| (l.clone(), EXECUTE | READ_FILE)));
        for lib in ["/lib", "/lib64", "/usr/lib", "/usr/lib64", "/usr/local/lib"] {
            paths.push((lib.into(), EXECUTE | READ_FILE | READ_DIR));
        }
        for data in ["/etc/ld.so.cache", "/etc/localtime", "/usr/share/zoneinfo", "/dev/urandom", "/dev/random"] {
            paths.push((data.into(), READ_FILE | READ_DIR));
        }
        paths.push(("/dev/null".into(), READ_FILE | WRITE_FILE));
        OsRules { paths: paths.into_iter().filter_map(|(p, a)| Some((std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?, a))).collect() }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (c, dir);
        OsRules::default()
    }
}

/// CPU time, core files and file sizes held to nothing past what a run needs, set in the child before it starts. With
/// `os` (Linux), the child also loses the machine: a landlock ruleset holds its files to [`os_rules`], and a seccomp
/// filter refuses every socket and every new process.
#[cfg(unix)]
fn hold_to_limits(cmd: &mut Command, cpu: std::time::Duration, os: Option<OsRules>) {
    use std::os::unix::process::CommandExt;
    let secs = cpu.as_secs().max(1) as libc::rlim_t;
    #[cfg(target_os = "linux")]
    let filter = os.as_ref().map(|_| process_and_socket_filter());
    #[cfg(not(target_os = "linux"))]
    let _ = os;
    // SAFETY: the closure runs in the forked child before exec and calls only async-signal-safe system calls
    // (setrlimit, prctl, open, close, the landlock calls) on values built before the fork.
    unsafe {
        cmd.pre_exec(move || {
            let cpu = libc::rlimit { rlim_cur: secs, rlim_max: secs + 1 };
            let none = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
            if libc::setrlimit(libc::RLIMIT_CPU, &cpu) != 0 || libc::setrlimit(libc::RLIMIT_CORE, &none) != 0 || libc::setrlimit(libc::RLIMIT_FSIZE, &none) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            #[cfg(target_os = "linux")]
            if let (Some(rules), Some(filter)) = (os.as_ref(), filter.as_ref()) {
                let Some(filter) = filter.as_ref() else { return Err(std::io::Error::from_raw_os_error(libc::ENOSYS)) };
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                landlock(rules)?;
                let prog = libc::sock_fprog { len: filter.len() as libc::c_ushort, filter: filter.as_ptr() as *mut libc::sock_filter };
                if libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &prog as *const libc::sock_fprog) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
}

/// Holds the calling process (the child, before exec) to `rules` with landlock (ABI 1, every file right handled): a
/// kernel without landlock fails the start, and the probe then finds no layer.
#[cfg(target_os = "linux")]
unsafe fn landlock(rules: &OsRules) -> std::io::Result<()> {
    #[repr(C)]
    struct RulesetAttr {
        handled_access_fs: u64,
    }
    #[repr(C, packed)]
    struct PathBeneath {
        allowed_access: u64,
        parent_fd: i32,
    }
    const HANDLED: u64 = (1 << 13) - 1;
    const RULE_PATH_BENEATH: libc::c_long = 1;
    let attr = RulesetAttr { handled_access_fs: HANDLED };
    // SAFETY: the landlock system calls read only the structs given, of the sizes given.
    let ruleset = unsafe { libc::syscall(libc::SYS_landlock_create_ruleset, &attr as *const RulesetAttr, std::mem::size_of::<RulesetAttr>(), 0u32) };
    if ruleset < 0 {
        return Err(std::io::Error::last_os_error());
    }
    for (path, access) in &rules.paths {
        // SAFETY: `path` is a NUL-terminated string built before the fork.
        let fd = unsafe { libc::open(path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
        if fd < 0 {
            continue; // a path this machine doesn't have needs no rule
        }
        let beneath = PathBeneath { allowed_access: *access, parent_fd: fd };
        // SAFETY: as above; the fd is ours and closed after.
        let added = unsafe { libc::syscall(libc::SYS_landlock_add_rule, ruleset as libc::c_int, RULE_PATH_BENEATH, &beneath as *const PathBeneath, 0u32) };
        unsafe { libc::close(fd) };
        if added < 0 {
            // A file (not a folder) takes only file rights: the folder rights are dropped and the rule tried again.
            let file_only = PathBeneath { allowed_access: *access & !8, parent_fd: unsafe { libc::open(path.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) } };
            let fd = file_only.parent_fd;
            let again = unsafe { libc::syscall(libc::SYS_landlock_add_rule, ruleset as libc::c_int, RULE_PATH_BENEATH, &file_only as *const PathBeneath, 0u32) };
            unsafe { libc::close(fd) };
            if again < 0 {
                unsafe { libc::close(ruleset as libc::c_int) };
                return Err(std::io::Error::last_os_error());
            }
        }
    }
    let restricted = unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset as libc::c_int, 0u32) };
    unsafe { libc::close(ruleset as libc::c_int) };
    if restricted < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// The seccomp filter of the Linux layer: no socket of any family (so no network and no connection to any of the
/// owner's local sockets, abstract ones included; a connected pair the runtime makes for itself is still allowed), no
/// `io_uring` (which could open one without the call), and no new process (a `clone` that isn't a thread, `fork`,
/// `vfork`; `clone3` answers as absent so the C library falls back to `clone`). A system call from another
/// architecture than the node's kills the child. None on an architecture this doesn't know: the start then fails,
/// and page code doesn't run.
#[cfg(target_os = "linux")]
fn process_and_socket_filter() -> Option<Vec<libc::sock_filter>> {
    let arch: u32 = if cfg!(target_arch = "x86_64") {
        0xc000_003e
    } else if cfg!(target_arch = "aarch64") {
        0xc000_00b7
    } else {
        return None;
    };
    const LD: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
    const JEQ: u16 = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
    const JSET: u16 = 0x45; // BPF_JMP | BPF_JSET | BPF_K
    const RET: u16 = 0x06; // BPF_RET | BPF_K
    const ALLOW: u32 = 0x7fff_0000;
    const KILL: u32 = 0x8000_0000;
    let eperm: u32 = 0x0005_0000 | libc::EPERM as u32;
    let enosys: u32 = 0x0005_0000 | libc::ENOSYS as u32;
    // Calls refused outright, and calls answered as absent.
    #[allow(unused_mut)]
    let mut refused: Vec<u32> = vec![libc::SYS_io_uring_setup as u32, libc::SYS_socket as u32];
    #[cfg(target_arch = "x86_64")]
    refused.extend([libc::SYS_fork as u32, libc::SYS_vfork as u32]);
    let absent = [libc::SYS_clone3 as u32];
    let op = |code: u16, jt: u8, jf: u8, k: u32| libc::sock_filter { code, jt, jf, k };
    let mut f = vec![op(LD, 0, 0, 4), op(JEQ, 1, 0, arch), op(RET, 0, 0, KILL), op(LD, 0, 0, 0)];
    // Laid out: [checks...] JEQ clone; RET ALLOW; LD flags; JSET thread; RET EPERM; RET ALLOW; RET EPERM; RET ENOSYS.
    let checks = refused.len() + absent.len();
    let eperm_at = f.len() + checks + 6;
    let enosys_at = eperm_at + 1;
    for nr in &refused {
        let at = f.len();
        f.push(op(JEQ, (eperm_at - at - 1) as u8, 0, *nr));
    }
    for nr in &absent {
        let at = f.len();
        f.push(op(JEQ, (enosys_at - at - 1) as u8, 0, *nr));
    }
    f.push(op(JEQ, 1, 0, libc::SYS_clone as u32));
    f.push(op(RET, 0, 0, ALLOW));
    f.push(op(LD, 0, 0, 16)); // the low word of the first argument: clone's flags
    f.push(op(JSET, 1, 0, libc::CLONE_THREAD as u32));
    f.push(op(RET, 0, 0, eperm));
    f.push(op(RET, 0, 0, ALLOW));
    debug_assert_eq!(f.len(), eperm_at);
    f.push(op(RET, 0, 0, eperm));
    f.push(op(RET, 0, 0, enosys));
    Some(f)
}

/// The child's resident memory, in MiB, where the system says.
fn resident_mb(pid: u32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let statm = std::fs::read_to_string(format!("/proc/{pid}/statm")).ok()?;
        let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
        // SAFETY: sysconf reads a constant of the system.
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) }.max(4096) as u64;
        Some((pages * page) >> 20)
    }
    #[cfg(target_os = "macos")]
    {
        // SAFETY: proc_pidinfo writes at most `size` bytes into the zeroed struct it is given.
        let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
        let n = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTASKINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
        (n == size).then_some(info.pti_resident_size >> 20)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

/// The most one line from a run may be, the most calls one run may make through the node, and the most a request
/// body from the page may be.
const LINE_MAX: usize = 64 << 20;
/// The most a run may say in all, its answer and every request counted together.
const RUN_SAID_MAX: usize = 128 << 20;
/// How many lines the reader holds for the node at once: a run that says more waits for the node to take them, so
/// what it says is never queued in the node's memory faster than the node reads it.
const LINES_HELD: usize = 1;
const PAGE_CALLS_MAX: usize = 256;
const PAGE_BODY_MAX: usize = 1 << 20;

/// Runs the confined child to its answer: the line it writes when it is done. Each request it makes on the way is
/// answered by `net` when the node allows it ([`answer`]), else refused. The child is killed at its deadline, past
/// its memory, or when it says something that isn't a line; what it said by then is not an answer.
fn converse(child: &mut std::process::Child, mut net: Option<&mut Net<'_>>, page: Option<&url::Url>, limits: Limits) -> Option<String> {
    use std::io::{Read, Write};
    let stdout = child.stdout.take()?;
    let mut stdin = child.stdin.take();
    let (tx, rx) = std::sync::mpsc::sync_channel::<Option<String>>(LINES_HELD);
    let budget = limits.said_bytes;
    let reader = std::thread::spawn(move || {
        let mut r = std::io::BufReader::new(stdout);
        let mut said = 0usize;
        loop {
            let mut buf = Vec::new();
            let got = (&mut r).take(LINE_MAX.min(budget.saturating_sub(said)) as u64 + 1).read_until(b'\n', &mut buf);
            said += buf.len();
            match got {
                Ok(n) if n > 0 && buf.len() <= LINE_MAX && said <= budget && buf.ends_with(b"\n") => {
                    if tx.send(Some(String::from_utf8_lossy(&buf).into_owned())).is_err() {
                        return;
                    }
                }
                _ => {
                    let _ = tx.send(None);
                    return;
                }
            }
        }
    });
    let mut deadline = std::time::Instant::now() + limits.ready;
    let mut ready = false;
    let mut calls = 0usize;
    let mut done = None;
    let debug = std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some();
    loop {
        if std::time::Instant::now() >= deadline {
            if debug {
                eprintln!("   [sign] the sandbox ran past its time and was killed");
            }
            break;
        }
        if resident_mb(child.id()).is_some_and(|mb| mb > limits.memory_mb) {
            eprintln!("   [sign] the sandbox held more than {} MiB and was killed", limits.memory_mb);
            break;
        }
        let line = match rx.recv_timeout(std::time::Duration::from_millis(20)) {
            Ok(Some(line)) => line,
            Ok(None) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
        };
        let Ok(said) = serde_json::from_str::<serde_json::Value>(&line) else { break };
        match said.get("t").and_then(|t| t.as_str()) {
            Some("ready") if !ready => {
                ready = true;
                deadline = std::time::Instant::now() + limits.wall;
            }
            Some("net") => {
                calls += 1;
                let id = said.get("id").and_then(|i| i.as_u64()).unwrap_or(0);
                let req = said.get("req").cloned().unwrap_or_default();
                let mut reply = match net.as_deref_mut() {
                    Some(_) if calls > PAGE_CALLS_MAX => refused(&format!("the page made more than {PAGE_CALLS_MAX} calls in one run")),
                    Some(n) => answer(&req, n, page, deadline),
                    None => refused("this run has no line to the node"),
                };
                reply["id"] = serde_json::Value::from(id);
                if let Some(s) = stdin.as_mut() {
                    let mut text = reply.to_string();
                    text.push('\n');
                    if s.write_all(text.as_bytes()).and_then(|_| s.flush()).is_err() {
                        stdin = None;
                    }
                }
            }
            Some("done") => {
                done = said.get("out").and_then(|o| o.as_str()).map(String::from);
                break;
            }
            _ => {}
        }
    }
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    // A reader still holding lines the run said is waiting to hand one over: let it go before waiting for it.
    drop(rx);
    let _ = reader.join();
    done
}

/// A request the node didn't make, said to the page the way a failed fetch is.
fn refused(why: &str) -> serde_json::Value {
    serde_json::json!({ "status": 0, "headers": [], "body": "", "error": why })
}

/// Whether the page's own code may have the node fetch `url`: the page's own site, over HTTPS, at an address on the
/// public internet (the transport checks the address it connects to, every redirect hop of it). The node's own
/// machine, its network and another site are never the page's to reach, whoever's route it is. This is the loosest
/// bound: the node's bridge holds a route that came from another node to the exact origins its graph names
/// (`client::Runner::page_asks`).
fn page_may_ask(page: Option<&url::Url>, url: &url::Url) -> Result<(), String> {
    crate::egress::Egress::Foreign.request(url)?;
    let page = page.ok_or("the run has no page")?;
    match (page.host_str(), url.host_str()) {
        (Some(p), Some(h)) if crate::identity::same_site(p, h) => Ok(()),
        (_, Some(h)) => Err(format!("{h} is not the page's own site")),
        _ => Err("the request names no host".into()),
    }
}

/// A header a browser never lets a page's script set (Fetch §2.2.2, forbidden request-header names): the transport,
/// the cookie jar and the browser fill them, and the page's word on them is not taken.
pub fn forbidden_header(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.starts_with("proxy-")
        || n.starts_with("sec-")
        || [
            "accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method", "connection", "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host",
            "keep-alive", "origin", "referer", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "via",
        ]
        .contains(&n.as_str())
}

/// One request from the page: the node decides whether it is made ([`page_may_ask`]), makes it with `net` (the
/// caller's session and transport), and answers with what came back. Everything the page sent is checked as hostile
/// input: the method is a word, a header is a token with a value on one line, the body is bounded, and a header the
/// browser keeps for itself is dropped. The answer never carries the cookies the site set: a page's script never reads
/// them in a browser either.
fn answer(v: &serde_json::Value, net: &mut Net<'_>, page: Option<&url::Url>, deadline: std::time::Instant) -> serde_json::Value {
    if std::time::Instant::now() >= deadline {
        return refused("the run's time is up");
    }
    let debug = std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some();
    let Some(url) = v.get("url").and_then(|u| u.as_str()).and_then(|u| url::Url::parse(u).ok()) else { return refused("not a web address") };
    if let Err(why) = page_may_ask(page, &url) {
        if debug {
            eprintln!("   [sign] the page asked {url}: refused ({why})");
        }
        return refused(&why);
    }
    let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("GET").to_ascii_uppercase();
    if method.is_empty() || method.len() > 16 || !method.bytes().all(|b| b.is_ascii_alphabetic()) {
        return refused("not a method");
    }
    let mut headers = Vec::new();
    if let Some(o) = v.get("headers").and_then(|h| h.as_object()) {
        for (k, val) in o.iter().take(64) {
            let val = val.as_str().unwrap_or_default();
            let token = !k.is_empty() && k.len() <= 256 && k.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b));
            if !token || val.len() > 8192 || val.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0) || forbidden_header(k) {
                continue;
            }
            headers.push((k.clone(), val.to_string()));
        }
    }
    let body = v.get("body").and_then(|b| b.as_str()).map(|b| b.as_bytes().to_vec());
    if body.as_ref().is_some_and(|b| b.len() > PAGE_BODY_MAX) {
        return refused("the page's request body is larger than the node sends for it");
    }
    let req = Request { method, url, exchange: usize::MAX, headers, body };
    let asked_at = std::time::Instant::now();
    match net(&req, deadline) {
        Ok(ex) => {
            if debug {
                eprintln!("   [sign] page call {} {} -> {} in {} ms", req.method, req.url, ex.status, asked_at.elapsed().as_millis());
            }
            let body = ex.response_body.unwrap_or_default();
            if body.len() > crate::egress::FOREIGN_ANSWER_MAX {
                return refused("the answer is larger than the page is handed");
            }
            serde_json::json!({
                "status": ex.status,
                "headers": ex.response_headers.iter().filter(|(k, _)| !k.eq_ignore_ascii_case("set-cookie") && !k.eq_ignore_ascii_case("set-cookie2")).map(|(k, v)| [k.to_ascii_lowercase(), v.clone()]).collect::<Vec<_>>(),
                "body": body,
            })
        }
        Err(why) => {
            if debug {
                eprintln!("   [sign] the page asked {}: {why}", req.url);
            }
            refused(&why)
        }
    }
}

/// One confined run of `shim` (the prelude and a harness): its spec and its input (the page's scripts, or a program)
/// beside it in a fresh private folder, the line to the node answered by `net`. The text the shim wrote when it was
/// done, or None.
fn run_confined(program: &str, kind: &str, shim: &str, spec: &serde_json::Value, input: &str, net: Option<&mut Net<'_>>, page: Option<&url::Url>, limits: Limits) -> Option<String> {
    let c = confined(program)?;
    let dir = RunDir::new(kind)?;
    let boot = dir.write("boot.js", BOOT.as_bytes())?;
    // An arrow, not a function: it has no `arguments` or `caller` a page could read the host's functions off while
    // it is still on the stack. The shim's own code inside it stays as it was written.
    let shim = dir.write("shim.js", format!("((H) => {{\n{PRELUDE}\n{shim}\n}})").as_bytes())?;
    let spec_path = dir.write("spec.json", spec.to_string().as_bytes())?;
    let input_path = dir.write("input", input.as_bytes())?;
    let mut cmd = c.command(&dir, limits.ready + limits.wall + std::time::Duration::from_secs(5));
    cmd.arg(&boot)
        .arg(&shim)
        .arg(&spec_path)
        .arg(&input_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() { Stdio::inherit() } else { Stdio::null() });
    let mut child = cmd.spawn().ok()?;
    converse(&mut child, net, page, limits)
}

/// Runs one of the node's own helper scripts (the slicer's parser) on adversarial input, in the same confined runtime
/// page code runs in: `files` written into a fresh private run folder (never an existing path, never through a file
/// already there), `script` started from it with `args` (names in that folder), the operating system's layers, an
/// empty environment and the runtime's permission model, and killed past `wall` or its memory. What it wrote to its
/// standard output is the answer, up to [`LINE_MAX`]; None when the runtime can't be confined, the run fails, or it
/// is killed.
pub(crate) fn run_helper(kind: &str, files: &[(&str, &[u8])], script: &str, args: &[&str], wall: std::time::Duration) -> Option<Vec<u8>> {
    use std::io::Read;
    let c = confined(&runtime()?)?;
    let dir = RunDir::new(kind)?;
    for (name, bytes) in files {
        dir.write(name, bytes)?;
    }
    let limits = Limits::new(wall);
    let mut cmd = c.command(&dir, wall + std::time::Duration::from_secs(1));
    cmd.arg(dir.path.join(script));
    for a in args {
        cmd.arg(dir.path.join(a));
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = Vec::new();
        let read = stdout.take(LINE_MAX as u64 + 1).read_to_end(&mut out);
        (read.is_ok() && out.len() <= LINE_MAX).then_some(out)
    });
    let deadline = std::time::Instant::now() + limits.wall;
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) => {}
            Err(_) => break false,
        }
        if std::time::Instant::now() >= deadline || resident_mb(child.id()).is_some_and(|mb| mb > limits.memory_mb) {
            break false;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    let _ = child.kill();
    let _ = child.wait();
    let out = reader.join().ok().flatten();
    if ok { out } else { None }
}

/// Whether a door's own page may be run by the node on its own: a site's code, run on this machine with nobody
/// asking. Off unless the owner turns it on (`UNBROWSE_DOOR_PASS=1`).
pub(crate) fn door_pass_enabled() -> bool {
    #[cfg(test)]
    if let Some(on) = DOOR_PASS_IN_TEST.with(|t| t.get()) {
        return on;
    }
    door_pass_on(std::env::var("UNBROWSE_DOOR_PASS").ok().as_deref())
}

/// The setting's rule: on at `1`, off at anything else and when unset.
pub(crate) fn door_pass_on(flag: Option<&str>) -> bool {
    flag.map(str::trim) == Some("1")
}

#[cfg(test)]
thread_local! {
    /// A test's own answer to `door_pass_enabled`, so none has to change the process's environment under another.
    pub(crate) static DOOR_PASS_IN_TEST: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

/// Runs a generated program in the page-shaped runtime: the same harness the page's own scripts run in (document,
/// window, storage, the recorded fingerprint and the answers the page read), with the program as the only script. A
/// program that copies a page's module gets the environment that module read, so a lifted computation answers what the
/// page answered. Answers the value the program wrote into its synthetic request, or why it didn't.
#[allow(clippy::too_many_arguments)]
pub fn run_program_on_page(program: &str, ctx: &serde_json::Value, fingerprint: &serde_json::Value, storage: &Storage, page_url: &str, html: &str, answers: &[crate::signing::Answer], scripts: &[(String, String)]) -> Result<String, String> {
    run_program_on_page_many(program, std::slice::from_ref(ctx), fingerprint, storage, page_url, html, answers, scripts)
        .and_then(|values| values.into_iter().next().filter(|v| !v.is_empty()).ok_or_else(|| "the program answered no value".to_string()))
}

/// The same, for every sample at once: the page's scripts boot **once**, and the program is called for each context in
/// that one runtime. This is the shape the verifier uses — a page boot per sighting was the cost that made a pick take
/// minutes. Answers one value per sample; a sample the program threw on is an empty string.
#[allow(clippy::too_many_arguments)]
pub fn run_program_on_page_many(program: &str, samples: &[serde_json::Value], fingerprint: &serde_json::Value, storage: &Storage, page_url: &str, html: &str, answers: &[crate::signing::Answer], scripts: &[(String, String)]) -> Result<Vec<String>, String> {
    let runtime = runtime().ok_or_else(|| "no signing runtime on this machine".to_string())?;
    let page = url::Url::parse(page_url).map_err(|e| e.to_string())?;
    let origin = page.origin().ascii_serialization();
    let path = "/__unbrowse_generated";
    let samples_json = serde_json::to_string(samples).map_err(|e| e.to_string())?;
    // A CommonJS shim and the primitives only inside the program's own scope: the page-shaped runtime stays a browser,
    // and a program that answers through `module.exports` still works.
    let body = format!(
        ";(function(){{var module={{exports:{{}}}},exports=module.exports;var md5=function(v){{return crypto.createHash('md5').update(String(v)).digest('hex')}},sha1=function(v){{return crypto.createHash('sha1').update(String(v)).digest('hex')}},sha256=function(v){{return crypto.createHash('sha256').update(String(v)).digest('hex')}},sha512=function(v){{return crypto.createHash('sha512').update(String(v)).digest('hex')}},hmacSha256=function(k,v){{return crypto.createHmac('sha256',String(k)).update(String(v)).digest('hex')}},base64=function(v){{return Buffer.from(String(v),'utf8').toString('base64')}},base64url=function(v){{return Buffer.from(String(v),'utf8').toString('base64url')}},hex=function(v){{return Buffer.from(String(v),'utf8').toString('hex')}};{program}\n;window.__ub_values=[];var __ub_samples={samples_json};\nfor(var __ub_i=0;__ub_i<__ub_samples.length;__ub_i++){{try{{var __ub_v=(typeof sign==='function')?sign(__ub_samples[__ub_i]):((typeof module.exports==='function')?module.exports(__ub_samples[__ub_i]):undefined);window.__ub_values.push(String(__ub_v));}}catch(e){{window.__ub_values.push('');}}}}\nfetch('{path}',{{method:'POST',headers:{{'x-generated':String(window.__ub_values[0]||'')}}}});}})();"
    );
    // The page's own scripts first, in load order, then the program: a global the page defines (a class, its own
    // encoder) exists for a program that calls it. This is the page's runtime as an opaque leaf; the verifier decides.
    let mut bundle: Bundle = scripts.to_vec();
    bundle.push((format!("{origin}{path}"), body));
    let asked = Request { method: "POST".into(), url: format!("{origin}{path}").parse().map_err(|e: url::ParseError| e.to_string())?, exchange: 0, headers: vec![], body: None };
    let signed = sign_in(Some(&runtime), settle_ms(), &bundle, page_url, &asked, "", storage, html, fingerprint, answers, None, true)
        .ok_or_else(|| "the page sandbox made no generated call".to_string())?;
    if !signed.values.is_empty() {
        return Ok(signed.values);
    }
    signed
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("x-generated"))
        .map(|(_, v)| v.clone())
        .filter(|v| !v.is_empty() && v != "undefined")
        .map(|v| vec![v])
        .ok_or_else(|| "the program answered no value".to_string())
}

/// The harness a generated producer runs under: one standalone script, no page and no net. The program defines
/// `sign(ctx)` (or `module.exports = function (ctx)`) and answers one call's value from the context it is given.
/// Its capabilities are the arithmetic a signature needs — hashes, bytes, base64, URLs — and nothing else: no
/// network, no filesystem, no timers, no `require` beyond `crypto`/`buffer`, all made in its own realm. The page's own
/// code is adversarial input, so a program read from it runs in the same confined runtime a page does ([`run_confined`]),
/// where the worst it can do is answer wrongly (and be discarded).
const PROGRAM_HARNESS: &str = r#"
const program = H.input;
const spec = JSON.parse(H.spec);
const ctx = spec.ctx || {};
// The browser the page's own code saw, as the walk recorded it: a copied module reads the same navigator, screen,
// canvas and storage it read in the page, so its arithmetic is the page's. No site is named here; the walk is.
const F = spec.fingerprint || {};
const storage = spec.storage || {};
const crypto = webCrypto;
const safeCrypto = { createHash: crypto.createHash, createHmac: crypto.createHmac };
// The primitives a page's own module calls (`n.md5(x)`, `base64(x)`): a program can name them directly, with no
// bundler and no module graph. They are the runtime's, not a site's.
const md5 = (v) => crypto.createHash('md5').update(String(v)).digest('hex');
const sha1 = (v) => crypto.createHash('sha1').update(String(v)).digest('hex');
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const sha512 = (v) => crypto.createHash('sha512').update(String(v)).digest('hex');
const hmacSha256 = (k, v) => crypto.createHmac('sha256', String(k)).update(String(v)).digest('hex');
const base64 = (v) => Buffer.from(String(v), 'utf8').toString('base64');
const base64url = (v) => Buffer.from(String(v), 'utf8').toString('base64url');
const hex = (v) => Buffer.from(String(v), 'utf8').toString('hex');
const quiet = () => {};
// Every read the program makes of the world outside its own arithmetic goes through here: the clock, randomness,
// the page's cookies and storage, the browser it runs in, the document. What it read is said back with its answer,
// and a read nothing here could answer is named, so a value that comes out wrong says what it was missing.
const reads = [];
const unanswered = [];
const read = (what, answered) => {
  if (reads.length < 60 && !reads.includes(what)) reads.push(what);
  if (!answered && unanswered.length < 30 && !unanswered.includes(what)) unanswered.push(what);
};
const el = () => ({ style: {}, setAttribute() {}, getAttribute() { return null; }, appendChild() {}, removeChild() {}, addEventListener() {}, removeEventListener() {}, getContext() { return null; }, innerHTML: '', textContent: '' });
const webglOf = () => ({
  getParameter: (n) => (F.webgl && F.webgl[String(n)] !== undefined ? F.webgl[String(n)] : null),
  getExtension: () => null, getSupportedExtensions: () => [], getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
});
const ctx2d = () => ({
  fillRect: quiet, fillText: quiet, strokeText: quiet, clearRect: quiet, beginPath: quiet, moveTo: quiet, lineTo: quiet, stroke: quiet, fill: quiet, arc: quiet,
  measureText: (t) => ({ width: String(t).length * 7 }),
  getImageData: () => ({ data: new Uint8ClampedArray(F.pixels || []), width: (F.pixelsAt && F.pixelsAt[0]) || 0, height: (F.pixelsAt && F.pixelsAt[1]) || 0 }),
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
});
const canvasEl = () => { const c = el(); c.width = 300; c.height = 150; c.getContext = (k) => (String(k).toLowerCase().indexOf('webgl') === 0 ? webglOf() : ctx2d()); c.toDataURL = () => (F.canvas && F.canvas[0]) || 'data:,'; c.toBlob = (f) => { try { f(null); } catch (e) {} }; return c; };
const create = (tag) => { const e = String(tag).toLowerCase() === 'canvas' ? canvasEl() : el(); e.tagName = String(tag).toUpperCase(); e.nodeName = e.tagName; e.nodeType = 1; return e; };
const storeOf = (seed, kind) => ({ getItem: (k) => { read(kind + ' ' + String(k), seed[String(k)] !== undefined); return seed[String(k)] === undefined ? null : String(seed[String(k)]); }, setItem: (k, v) => { seed[String(k)] = String(v); }, removeItem: (k) => { delete seed[String(k)]; }, clear: () => { for (const k of Object.keys(seed)) delete seed[k]; }, key: () => null, length: 0 });
const out = { ok: false, value: null, error: '', reads, unanswered };
let g = {
  ctx,
  crypto: safeCrypto,
  require: (name) => {
    if (name === 'crypto') return safeCrypto;
    if (name === 'buffer') return { Buffer };
    throw new Error('the program may not require ' + name);
  },
  Buffer, TextEncoder, TextDecoder, atob, btoa, URL, URLSearchParams,
  md5, sha1, sha256, sha512, hmacSha256, base64, base64url, hex,
  console: { log: quiet, warn: quiet, error: quiet, info: quiet, debug: quiet },
  module: { exports: {} },
  exports: {},
};
Object.assign(g, {
  self: g, globalThis: g,
  document: { cookie: '', createElement: create, createElementNS: create, getElementsByTagName: () => [], getElementsByClassName: () => [], querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, documentElement: el(), head: el(), body: el(), readyState: 'complete' },
  screen: { width: (F.screen && F.screen.width) || 1920, height: (F.screen && F.screen.height) || 1080, availWidth: (F.screen && F.screen.availWidth) || 1920, availHeight: (F.screen && F.screen.availHeight) || 1080, colorDepth: (F.screen && F.screen.colorDepth) || 24, pixelDepth: (F.screen && F.screen.pixelDepth) || 24, orientation: { type: 'landscape-primary' } },
  navigator: {
    userAgent: F.ua || 'Mozilla/5.0', language: F.lang || 'en', languages: F.langs || ['en'], platform: F.platform || 'MacIntel',
    vendor: F.vendor || 'Google Inc.', webdriver: false, cookieEnabled: true, hardwareConcurrency: F.cores || 8, maxTouchPoints: F.touch || 0, plugins: [], mimeTypes: [],
    connection: { effectiveType: '4g', rtt: 50, downlink: 10 },
    userAgentData: (() => { const d = F.uaData || {}; const brands = d.brands || []; const mobile = !!d.mobile; const platform = d.platform || F.platform || 'macOS'; return { brands, mobile, platform, getHighEntropyValues: async () => ({ brands, mobile, platform, architecture: 'x86', bitness: '64', model: '', platformVersion: '15.0.0', uaFullVersion: (F.ua || '').split('Chrome/')[1] || '', fullVersionList: brands }) }; })(),
  },
  location: { href: ctx.url || '', protocol: 'https:', host: ctx.host || '', hostname: ctx.host || '', pathname: ctx.path || '/', search: ctx.search || '', hash: '' },
  innerWidth: 1280, innerHeight: 720, outerWidth: 1280, outerHeight: 800, devicePixelRatio: F.dpr || 2, screenX: 0, screenY: 0,
  chrome: { runtime: {}, loadTimes: quiet, csi: quiet, app: { isInstalled: false } },
  history: { length: 1, state: null, pushState: quiet, replaceState: quiet, back: quiet, forward: quiet, go: quiet },
  localStorage: storeOf(storage.local || {}, 'localStorage'),
  sessionStorage: storeOf(storage.session || {}, 'sessionStorage'),
  Storage: function Storage() {},
  performance: { now: () => Date.now(), timeOrigin: Date.now() },
});
const classes = ['HTMLElement','Element','HTMLCanvasElement','HTMLDivElement','HTMLSpanElement','HTMLIFrameElement','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement','HTMLFormElement','HTMLScriptElement','HTMLStyleElement','HTMLDivElement','HTMLCollection','NodeList','DocumentFragment','CanvasRenderingContext2D','WebGLRenderingContext','AudioContext','OfflineAudioContext','Image','Document','HTMLDocument','Window','Location','History','MouseEvent','KeyboardEvent','Event','CustomEvent','MutationObserver','IntersectionObserver','ResizeObserver','Storage'];
for (const name of classes) { const f = function () {}; Object.defineProperty(f, 'name', { value: name }); g[name] = f; }
g.document.defaultView = g;
// The clock and randomness are the engine's own and fresh on every run; that the program read them is what a
// reader needs to know of a value that differs from the walk's.
// A request that says when it was made (`ctx.sent_at`) is run at that time; any other at the engine's own.
const sentAt = Number(ctx.sent_at) || 0;
g.Date = new Proxy(Date, {
  construct(target, args) { if (!args.length) { read('the clock', true); return sentAt ? new target(sentAt) : new target(); } return new target(...args); },
  apply(target, _, args) { read('the clock', true); return sentAt ? new target(sentAt).toString() : target(...args); },
  get(target, key) { if (key === 'now') return () => { read('the clock', true); return sentAt || target.now(); }; return target[key]; },
});
g.Math = new Proxy(Math, { get(target, key) { if (key === 'random') return () => { read('randomness', true); return target.random(); }; return target[key]; } });
g.navigator = new Proxy(g.navigator, { get(target, key) { if (typeof key === 'string') read('navigator.' + key, target[key] !== undefined); return target[key]; } });
{
  const doc = g.document;
  for (const find of ['querySelector', 'querySelectorAll', 'getElementById', 'getElementsByName']) {
    const was = doc[find];
    doc[find] = (sel) => { read('document.' + find + ' ' + String(sel).slice(0, 60), false); return typeof was === 'function' ? was(sel) : null; };
  }
  // The page's cookies are the ones the request carried.
  let cookie = Object.entries(ctx.cookies || {}).map(([k, v]) => k + '=' + v).join('; ');
  Object.defineProperty(doc, 'cookie', { get() { read('document.cookie', cookie !== ''); return cookie; }, set(v) { cookie = String(v); }, configurable: true });
}
g.window = g;
try {
  vm.createContext(g);
  vm.runInContext(program, g, { filename: 'program.js', timeout: 2000 });
  const expr = "(typeof sign === 'function') ? sign(ctx) : (module.exports && typeof module.exports === 'function' ? module.exports(ctx) : undefined)";
  const v = vm.runInContext(expr, g, { timeout: 2000 });
  if (v && typeof v.then === 'function') throw new Error('sign(ctx) must answer synchronously');
  if (v === undefined || v === null) throw new Error('sign(ctx) answered nothing');
  if (typeof v !== 'string' && typeof v !== 'number') throw new Error('sign(ctx) must answer a string');
  out.ok = true;
  out.value = String(v);
  if (out.value.length > 65536) { out.ok = false; out.error = 'sign(ctx) answered more than 64 KiB'; }
} catch (e) {
  out.ok = false;
  out.error = String((e && e.message) || e).slice(0, 500);
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
"#;

/// How long a generated program gets to answer one call, in milliseconds.
fn program_budget_ms() -> u64 {
    std::env::var("UNBROWSE_PROGRAM_MS").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(15_000)
}

/// Runs a generated producer on one call's context (`ctx`) and answers the value it returns, or why it didn't.
/// The program is the route's own artifact: it is run as a standalone script in the restricted runtime above, not
/// against a page and not over the signing bridge. A machine without a runtime answers so, and a call that needs
/// the value falls back to the browser.
pub fn run_program(program: &str, ctx: &serde_json::Value, fingerprint: &serde_json::Value, storage: &Storage) -> Result<String, String> {
    let (answer, read) = run_program_read(program, ctx, fingerprint, storage);
    // A program that failed says what it read that nothing here answered: the missing piece, by name.
    answer.map_err(|why| if read.unanswered.is_empty() { why } else { format!("{why}; it read what nothing here answers: {}", read.unanswered.join(", ")) })
}

/// What a program read of the world outside its own arithmetic while it ran: the clock, randomness, cookies,
/// storage, the browser, the document. `unanswered` are the reads the engine had nothing to answer with.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Reads {
    pub read: Vec<String>,
    pub unanswered: Vec<String>,
}

/// `run_program`, with what the program read beside its answer.
pub fn run_program_read(program: &str, ctx: &serde_json::Value, fingerprint: &serde_json::Value, storage: &Storage) -> (Result<String, String>, Reads) {
    let mut read = Reads::default();
    let answer = run_program_in(program, ctx, fingerprint, storage, &mut read);
    (answer, read)
}

fn run_program_in(program: &str, ctx: &serde_json::Value, fingerprint: &serde_json::Value, storage: &Storage, read: &mut Reads) -> Result<String, String> {
    let runtime = runtime().ok_or_else(|| "no signing runtime on this machine".to_string())?;
    let spec = serde_json::json!({ "ctx": ctx, "fingerprint": fingerprint, "storage": storage, "debug": std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() });
    // A program that never answers is killed, not waited on: a call can fall back to the browser, but it can't hang on
    // a generated leaf.
    let limits = Limits::new(std::time::Duration::from_millis(program_budget_ms()));
    let said = run_confined(&runtime, "program", PROGRAM_HARNESS, &spec, program, None, None, limits)
        .ok_or_else(|| "the program gave no answer: it ran past its time or its memory, or this machine can't confine its runtime".to_string())?;
    let said: serde_json::Value = serde_json::from_str(&said).map_err(|e| e.to_string())?;
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        eprintln!("   [program] {:?}", said);
    }
    // What the program read of the world outside its own arithmetic, and which reads nothing here answered.
    let names = |key: &str| said.get(key).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<_>>()).unwrap_or_default();
    *read = Reads { read: names("reads"), unanswered: names("unanswered") };
    if said.get("ok").and_then(|o| o.as_bool()) == Some(true) {
        said.get("value").and_then(|v| v.as_str()).map(String::from).ok_or_else(|| "the program answered no value".into())
    } else {
        Err(said.get("error").and_then(|e| e.as_str()).unwrap_or("the program failed").to_string())
    }
}

/// The request a page's own code would send: what a signing bridge answers with. Its URL, headers and body are the
/// page's, so a signature computed over its body travels with the request it signs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Signed {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    /// The scripts the page's runtime resolved for this signing: the boot set, the chunks it loaded, the modules it
    /// linked. Empty when the runtime is too old to say.
    pub modules: Vec<String>,
    /// The values a generated program answered, one per sample it was given. Empty for a page that signs.
    pub values: Vec<String>,
    /// Which maker made it (`learn.rung`): the page's scripts booted here, or a page the browser kept open.
    pub by: crate::rung::Rung,
}

/// Every request one boot of the page made, and the values a generated program answered (empty for a page that signs).
/// One boot can sign several steps of a route when the page makes them all; the caller keys them by `METHOD path`.
struct Run {
    calls: Vec<Signed>,
    values: Vec<String>,
    /// A page global read after the boot, when the caller asked for one (`read_global`).
    global: Option<String>,
    /// The page's own cookie jar after the boot: what it was sent, and what it wrote (`document.cookie`). A challenge
    /// page earns its clearance here as likely as in a response header.
    cookies: Vec<(String, String)>,
}

/// The request the page's scripts make when booted at `page_url`, read as the answer to `asked`: the call at the same
/// method and path. Its body is the page's own (a signature is bound to it, and the page's ids are in it), so the
/// whole request travels back, not just its headers. None when the runtime is missing or no such call is made.
/// `storage` is what the page had in front of it when it signed (its `localStorage` and `sessionStorage`, carried on
/// the session): a bundle that keeps its key or a nonce there reads it back here.
/// A fetch a page's script makes while it signs, served by the caller: the node answers it with the call's session,
/// its transport and its rule, so the script's network is the client the token is bound to. A sandbox that fetched by
/// itself would leave from another address and without the jar.
///
/// The second argument is the run's deadline: the fetch is made by then or not at all, so a slow site never holds a
/// run past its time.
pub type Net<'a> = dyn FnMut(&Request, std::time::Instant) -> Result<crate::trace::Exchange, String> + 'a;

/// The request the page's scripts make when booted at `page_url`, read as the answer to `asked`: the call at the same
/// method and path. Its body is the page's own (a signature is bound to it, and the page's ids are in it), so the
/// whole request travels back, not just its headers. None when the runtime is missing or no such call is made.
/// `storage` is what the page had in front of it when it signed (its `localStorage` and `sessionStorage`, carried on
/// the session): a bundle that keeps its key or a nonce there reads it back here.
#[allow(clippy::too_many_arguments)]
pub fn sign(bundle: &Bundle, page_url: &str, asked: &Request, cookies: &str, storage: &Storage, html: &str, fingerprint: &serde_json::Value, answers: &[crate::signing::Answer], net: Option<&mut Net<'_>>) -> Option<Signed> {
    run(runtime().as_deref(), settle_ms(), bundle, page_url, asked, cookies, storage, html, fingerprint, answers, net, false)
}

/// The same, in a named runtime with the page's scripts given `settle_ms` to boot: the seam tests use it directly so
/// no test has to change the process's environment under another.
#[allow(clippy::too_many_arguments)]
pub fn sign_with(program: Option<&str>, settle_ms: u64, bundle: &Bundle, page_url: &str, asked: &Request, cookies: &str, storage: &Storage, html: &str, fingerprint: &serde_json::Value, net: Option<&mut Net<'_>>) -> Option<Signed> {
    sign_in(program, settle_ms, bundle, page_url, asked, cookies, storage, html, fingerprint, &[], net, false)
}

/// The same with the answers the walk's page read, so a bundle boots on its own data layer without a network: the
/// seam a route's compaction uses to boot a page the way a call would.
#[allow(clippy::too_many_arguments)]
pub(crate) fn sign_in(program: Option<&str>, settle_ms: u64, bundle: &Bundle, page_url: &str, asked: &Request, cookies: &str, storage: &Storage, html: &str, fingerprint: &serde_json::Value, answers: &[crate::signing::Answer], net: Option<&mut Net<'_>>, boot_all: bool) -> Option<Signed> {
    run(program, settle_ms, bundle, page_url, asked, cookies, storage, html, fingerprint, answers, net, boot_all)
}

/// The run itself: the page's scripts (and nothing else) see the state the walk left them, plus the answers the page
/// read, so its data path boots without a network or a rendered page.
#[allow(clippy::too_many_arguments)]
fn run_all(program: Option<&str>, settle_ms: u64, bundle: &Bundle, page_url: &str, cookies: &str, storage: &Storage, html: &str, fingerprint: &serde_json::Value, answers: &[crate::signing::Answer], net: Option<&mut Net<'_>>, boot_all: bool, targets: &[(String, String)], read_global: Option<&str>) -> Option<Run> {
    // The page's boot is part of the answer's budget: a page with a hundred chunks takes longer to boot than it takes
    // to settle, and the run's deadline must cover both, or the child is killed mid-boot.
    let limits = Limits::new(std::time::Duration::from_millis(settle_ms + 70_000));
    run_all_held(program, settle_ms, bundle, page_url, cookies, storage, html, fingerprint, answers, net, boot_all, targets, read_global, limits)
}

/// [`run_all`] under the given limits.
#[allow(clippy::too_many_arguments)]
fn run_all_held(program: Option<&str>, settle_ms: u64, bundle: &Bundle, page_url: &str, cookies: &str, storage: &Storage, html: &str, fingerprint: &serde_json::Value, answers: &[crate::signing::Answer], net: Option<&mut Net<'_>>, boot_all: bool, targets: &[(String, String)], read_global: Option<&str>, limits: Limits) -> Option<Run> {
    // A test process runs its sandboxes in parallel threads; one at a time keeps the suite from racing itself, and a
    // production call is one run anyway.
    #[cfg(test)]
    let _serial = {
        static L: std::sync::Mutex<()> = std::sync::Mutex::new(());
        L.lock().unwrap_or_else(|e| e.into_inner())
    };
    let program = program?;
    let spec = serde_json::json!({
        "pageUrl": page_url,
        "cookies": cookies,
        "localStorage": storage.local,
        "sessionStorage": storage.session,
        "html": html,
        "fingerprint": fingerprint,
        "net": net.is_some(),
        "answers": answers,
        "bootAll": boot_all,
        "targets": targets.iter().map(|(m, p)| serde_json::json!({ "method": m, "path": p })).collect::<Vec<_>>(),
        "readGlobal": read_global,
        "settleMs": settle_ms,
        "scriptMs": script_ms().min(settle_ms),
        "debug": std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some(),
    });
    let scripts: Vec<serde_json::Value> = bundle.iter().map(|(url, body)| serde_json::json!({ "url": url, "body": body })).collect();
    let page = url::Url::parse(page_url).ok();
    let boot_started = std::time::Instant::now();
    let said_out = run_confined(program, "sign", HARNESS, &spec, &serde_json::Value::Array(scripts).to_string(), net, page.as_ref(), limits);
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        eprintln!("   [sign] boot {} ms (settle {} ms)", boot_started.elapsed().as_millis(), settle_ms);
        eprintln!("   [sign] sandbox child output: {:?}", said_out.as_ref().map(String::len));
    }
    let said = said_out?;
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        let head: String = said.chars().take(240).collect();
        eprintln!("   [sign] sandbox raw {} bytes: {head:?}", said.len());
    }
    let said: serde_json::Value = serde_json::from_str(&said).ok()?;
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        let all: Vec<String> = said.get("requests").and_then(|r| r.as_array()).into_iter().flatten().map(|r| format!("{} {}", r.get("method").and_then(|m| m.as_str()).unwrap_or("?"), r.get("url").and_then(|u| u.as_str()).unwrap_or("?"))).collect();
        let n_all = all.len();
        let mut calls: Vec<String> = all.iter().take(6).cloned().collect();
        if n_all > 16 { calls.push(format!("… {} more …", n_all - 16)); }
        calls.extend(all.iter().skip(n_all.saturating_sub(10)).cloned());
        eprintln!("   [sign] calls[{}] {:?}", n_all, calls);
        eprintln!("   [sign] sandbox: {} errors {:?}; {} calls {:?}", said.get("errors").and_then(|e| e.as_u64()).unwrap_or(0), said.get("errs"), calls.len(), calls);
        eprintln!("   [sign] lookups {:?}", said.get("lookups"));
    }
    let modules: Vec<String> = said.get("modules").and_then(|m| m.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let values: Vec<String> = said.get("values").and_then(|m| m.as_array()).map(|a| a.iter().map(|x| x.as_str().unwrap_or_default().to_string()).collect()).unwrap_or_default();
    // A call the page made with an address of its own (`/api/search`) belongs to the page's origin.
    let base = url::Url::parse(page_url).ok();
    let mut calls = Vec::new();
    for r in said.get("requests")?.as_array()? {
        let raw = r.get("url").and_then(|u| u.as_str()).unwrap_or_default();
        let Some(url) = url::Url::parse(raw).ok().or_else(|| base.as_ref().and_then(|b| b.join(raw).ok())) else { continue };
        let Some(headers) = r.get("headers").and_then(|h| h.as_object()) else { continue };
        calls.push(Signed {
            method: r.get("method").and_then(|m| m.as_str()).unwrap_or("GET").to_uppercase(),
            url: url.to_string(),
            headers: headers.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect(),
            body: r.get("body").and_then(|b| b.as_str()).map(|b| b.as_bytes().to_vec()),
            modules: modules.clone(),
            values: values.clone(),
            by: crate::rung::Rung::Bundle,
        });
    }
    let global = said.get("global").and_then(|g| g.as_str()).map(String::from);
    let cookies = said.get("cookies").and_then(|c| c.as_array()).map(|a| {
        a.iter().filter_map(|p| Some((p.get(0)?.as_str()?.to_string(), p.get(1)?.as_str().unwrap_or_default().to_string()))).collect()
    }).unwrap_or_default();
    Some(Run { calls, values, global, cookies })
}

/// The one call `asked` names, from one boot of the page. The target is that call, so the harness stops shortly after
/// the page makes it instead of waiting out its quiet window.
fn run(program: Option<&str>, settle_ms: u64, bundle: &Bundle, page_url: &str, asked: &Request, cookies: &str, storage: &Storage, html: &str, fingerprint: &serde_json::Value, answers: &[crate::signing::Answer], net: Option<&mut Net<'_>>, boot_all: bool) -> Option<Signed> {
    let targets = vec![(asked.method.to_uppercase(), asked.url.path().to_string())];
    let out = run_all(program, settle_ms, bundle, page_url, cookies, storage, html, fingerprint, answers, net, boot_all, &targets, None)?;
    let made = match out.calls.iter().find(|c| c.method.eq_ignore_ascii_case(&asked.method) && url::Url::parse(&c.url).map(|u| u.path() == asked.url.path()).unwrap_or(false)) {
        Some(made) => made,
        None => { eprintln!("   [sign] no call for {} {}; got {:?}", asked.method, asked.url.path(), out.calls.iter().map(|c| format!("{} {}", c.method, url::Url::parse(&c.url).map(|u| u.path().to_string()).unwrap_or_default())).collect::<Vec<_>>()); return None }
    };
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        let names: Vec<&str> = made.headers.iter().map(|(k, _)| k.as_str()).collect();
        eprintln!("   [sign] matched {} {} with {} header(s): {:?}", made.method, asked.url.path(), names.len(), names);
    }
    Some(Signed { values: out.values, ..made.clone() })
}

/// One global the page's own code leaves behind, read after the boot: a value the page sets asynchronously (an
/// anti-bot proof, a session token) rather than writing into a request. `scripts` is the producer's own code, not the
/// whole page. None when the global never appears.
#[allow(clippy::too_many_arguments)]
#[allow(dead_code)] // the seam for a page-set value (an async anti-bot proof); measured, not yet a class
pub(crate) fn read_global(name: &str, scripts: &Bundle, page_url: &str, cookies: &str, storage: &Storage, html: &str, fingerprint: &serde_json::Value, answers: &[crate::signing::Answer], net: Option<&mut Net<'_>>) -> Option<String> {
    let program = runtime()?;
    run_all(Some(&program), settle_ms(), scripts, page_url, cookies, storage, html, fingerprint, answers, net, true, &[], Some(name))
        .and_then(|r| r.global)
        .filter(|v| !v.is_empty())
}

/// What one boot of a challenge page produced: every call it made, and the cookie jar it left (the session it was
/// given plus whatever it wrote). A door's clearance is a cookie the site issued in a response or the page wrote; the
/// caller installs it and the site's next answer decides whether it passed.
pub(crate) struct DoorRun {
    // The node acts on the cookies; the calls are the page's own account of what it sent, which the tests read.
    #[cfg_attr(not(test), allow(dead_code))]
    pub calls: Vec<Signed>,
    pub cookies: Vec<(String, String)>,
}

/// Boots a challenge page's own scripts, with the session the walk had and a line to the node for its calls, and
/// returns what it made and what it wrote. Not a route and not a site's data: the page's own proof, run in the
/// page-shaped sandbox so a clearance the page earns is the site's, honestly computed. A page that asks for a
/// person's act (a slider, a captcha) writes nothing here; the agent or the owner meets that door instead.
#[allow(clippy::too_many_arguments)]
pub(crate) fn door_pass(scripts: &Bundle, page_url: &str, cookies: &str, storage: &Storage, html: &str, fingerprint: &serde_json::Value, net: Option<&mut Net<'_>>) -> Option<DoorRun> {
    let program = runtime()?;
    let run = run_all(Some(&program), settle_ms(), scripts, page_url, cookies, storage, html, fingerprint, &[], net, true, &[], None)?;
    Some(DoorRun { calls: run.calls, cookies: run.cookies })
}

/// Every call one boot of the page makes: one boot signs every step of a route whose page makes it, so a call with
/// several signed steps is one page load, not one per step.
#[allow(clippy::too_many_arguments)]
pub(crate) fn sign_page(bundle: &Bundle, page_url: &str, cookies: &str, storage: &Storage, html: &str, fingerprint: &serde_json::Value, answers: &[crate::signing::Answer], net: Option<&mut Net<'_>>, targets: &[(String, String)]) -> Option<Vec<Signed>> {
    let program = runtime()?;
    run_all(Some(&program), settle_ms(), bundle, page_url, cookies, storage, html, fingerprint, answers, net, false, targets, None).map(|r| r.calls)
}

#[cfg(test)]
mod tests {

    /// Windows, 22 Nov 2026: no Unix shell to ask, so no runtime was found and two answers came out wrong. The runtime
    /// is read from the path's folders themselves: `node.exe` there, `node` elsewhere, the first folder that has one.
    #[test]
    fn the_runtime_is_found_in_the_paths_folders_with_no_shell() {
        let root = std::env::temp_dir().join(format!("sandbox-path-{}", std::process::id()));
        let (empty, win, unix) = (root.join("empty"), root.join("Program Files").join("nodejs"), root.join("bin"));
        for d in [&empty, &win, &unix] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(win.join("node.exe"), b"").unwrap();
        std::fs::write(unix.join("node"), b"").unwrap();
        let path = std::env::join_paths([empty.clone(), win.clone(), unix.clone()]).unwrap();
        let found = super::node_on_path(&path);
        let later = super::node_on_path(&std::env::join_paths([empty.clone(), unix.clone()]).unwrap());
        let none = super::node_on_path(&std::env::join_paths([empty]).unwrap());
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(found, Some(win.join("node.exe").to_string_lossy().into_owned()), "a folder with spaces, node.exe");
        assert_eq!(later, Some(unix.join("node").to_string_lossy().into_owned()));
        assert_eq!(none, None);
    }
    use super::*;

    fn request(method: &str, url: &str, body: Option<&str>) -> Request {
        Request { method: method.into(), url: url.parse().unwrap(), exchange: 0, headers: vec![], body: body.map(|b| b.as_bytes().to_vec()) }
    }

    /// A page whose own code asks for what it was asked (its query in the URL), signs that call, and sends it: the
    /// sandbox reads the signed call back. Nothing here knows the site — this is the page's scripts and its URL.
    #[test]
    fn a_bundles_own_signed_call_is_read_back() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (function () {
                var q = new URLSearchParams(location.search).get('q') || '';
                var body = JSON.stringify({ q: q });
                var sig = 'sig-' + btoa(body) + '-7';
                fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sig': sig }, body: body });
            })();
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some(r#"{"q":"kettle"}"#));
        let signed = sign_with(Some("node"), 200, &bundle, "https://shop.example.com/search?q=kettle", &asked, "", &Storage::default(), "", &serde_json::Value::Null, None).expect("the page's signed call");
        assert_eq!(signed.url, "https://shop.example.com/api/search");
        assert_eq!(signed.body.as_deref(), Some(&b"{\"q\":\"kettle\"}".to_vec()[..]));
        let sig = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-sig")).map(|(_, v)| v.as_str());
        assert_eq!(sig, Some("sig-eyJxIjoia2V0dGxlIn0=-7"), "{:?}", signed.headers);
        assert!(signed.headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("content-type") && v == "application/json"));
    }

    /// A bundle that reads what the page had in front of it — a key in `localStorage`, a nonce in the cookie — signs
    /// with them: the bridge puts the session's storage and the jar back before the page's code runs, because a
    /// signature over state the page never saw is a signature for another page.
    #[test]
    fn the_pages_own_storage_and_cookies_are_in_front_of_it_when_it_signs() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (function () {
                var key = localStorage.getItem('sign_key') || 'missing';
                var nonce = (document.cookie.split('; ').find(function (c) { return c.indexOf('nid=') === 0; }) || 'nid=none').slice(4);
                document.cookie = 'seen=1';
                fetch('/api/search', { method: 'POST', headers: { 'x-sig': key + ':' + nonce + ':' + document.cookie.indexOf('seen=1') }, body: '{}' });
            })();
        "#.into())];
        let storage = Storage { local: [("sign_key".to_string(), "k-9".to_string())].into(), session: Default::default() };
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let signed = sign_with(Some("node"), 200, &bundle, "https://shop.example.com/search", &asked, "sid=1; nid=n-7", &storage, "", &serde_json::Value::Null, None).expect("the page's signed call");
        let sig = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-sig")).map(|(_, v)| v.as_str()).unwrap_or_default();
        // The key and the nonce are what the page had in front of it; the last part says the page wrote a cookie of
        // its own and could read it back (an offset into the jar, never -1).
        let at = sig.strip_prefix("k-9:n-7:").unwrap_or_else(|| panic!("{sig}: {:?}", signed.headers));
        assert!(at.parse::<i64>().is_ok_and(|i| i >= 0), "the page's own cookie is writable: {sig}");
    }

    /// A bundle that reads the page itself (a `<meta>` token, a config `<script>` the page carried) signs with what it
    /// finds: the bridge gives the page's scripts the page the walk saw, not an empty document.
    #[test]
    fn the_page_the_walk_saw_is_in_front_of_the_scripts_when_they_sign() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (function () {
                var meta = document.querySelector('meta[name="csrf-token"]');
                var cfg = document.getElementById('cfg');
                var token = meta ? meta.content : 'none';
                var build = cfg ? JSON.parse(cfg.textContent).build : 'none';
                fetch('/api/search', { method: 'POST', headers: { 'x-token': token, 'x-build': build }, body: '{}' });
            })();
        "#.into())];
        let html = r#"<html><head><meta name="csrf-token" content="m-1"></head><body><script id="cfg" type="application/json">{"build":"b-2"}</script></body></html>"#;
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let signed = sign_with(Some("node"), 200, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), html, &serde_json::Value::Null, None).expect("the page's signed call");
        let got = |name: &str| signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str());
        assert_eq!(got("x-token"), Some("m-1"));
        assert_eq!(got("x-build"), Some("b-2"));
    }


    /// The page's own code reported the browser: a producer that hashes a canvas drawing, reads a WebGL parameter or
    /// asks the screen and navigator gets the walk's browser back, not a generic shim's, so the token it signs is
    /// consistent with the client that presents it.
    #[test]
    fn the_browser_the_page_saw_is_in_front_of_its_scripts() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (function () {
                var c = document.createElement('canvas'); var u = c.toDataURL();
                var gl = c.getContext('webgl'); var vendor = gl.getParameter(37445) || '';
                fetch('/api/search', { method: 'POST', headers: { 'x-fp': u + '|' + vendor + '|' + screen.width + '|' + navigator.hardwareConcurrency }, body: '{}' });
            })();
        "#.into())];
        let fp = serde_json::json!({
            "canvas": ["data:image/png;base64,AAAA"],
            "webgl": {"37445": "Apple GPU"},
            "screen": {"width": 1440, "height": 900},
            "cores": 10
        });
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let signed = sign_with(Some("node"), 200, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &fp, None).expect("the page's signed call");
        let sig = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-fp")).map(|(_, v)| v.as_str()).unwrap_or_default();
        assert_eq!(sig, "data:image/png;base64,AAAA|Apple GPU|1440|10", "{:?}", signed.headers);
    }

    /// The client hints the browser reported: a producer that reads the platform, the brand list, or awaits the
    /// high-entropy API signs with the walk's own answer — the same hints the transport sends on the wire.
    #[test]
    fn the_client_hints_a_browser_reports_are_the_walks() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (async function () {
                var d = navigator.userAgentData;
                var hi = await d.getHighEntropyValues(['architecture']);
                fetch('/api/search', { method: 'POST', headers: { 'x-hints': d.platform + '|' + d.brands.length + '|' + hi.architecture }, body: '{}' });
            })();
        "#.into())];
        let fp = serde_json::json!({ "uaData": { "brands": [{ "brand": "Chromium", "version": "156" }], "mobile": false, "platform": "macOS" } });
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let signed = sign_with(Some("node"), 12000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &fp, None).expect("the page's signed call");
        let got = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-hints")).map(|(_, v)| v.as_str());
        assert_eq!(got, Some("macOS|1|x86"), "{:?}", signed.headers);
    }


    /// A page's script fetches while it signs: the node answers it (the caller here), and the script signs with what
    /// came back. The sandbox never makes the request itself, so the fetch leaves as the client the token is bound to.
    #[test]
    fn a_script_that_fetches_while_it_signs_gets_the_nodes_answer() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (async function () {
                var r = await fetch('/api/config', { method: 'GET' });
                var c = await r.json();
                fetch('/api/search', { method: 'POST', headers: { 'x-key': c.key }, body: '{}' });
            })();
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let seen = std::cell::RefCell::new(Vec::new());
        let mut net = |r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            seen.borrow_mut().push(r.url.path().to_string());
            if r.url.path() == "/api/config" {
                Ok(crate::trace::Exchange {
                    method: "GET".into(),
                    url: r.url.clone(),
                    request_headers: vec![],
                    request_body: None,
                    status: 200,
                    response_headers: vec![("content-type".into(), "application/json".into())],
                    response_body: Some(r#"{"key":"K7"}"#.into()),
                    response_mime: "application/json".into(),
                    resource_type: None,
                    main_frame: None,
                })
            } else {
                Err("not asked".into())
            }
        };
        let signed = sign_with(Some("node"), 12000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &serde_json::Value::Null, Some(&mut net)).expect("the page's signed call");
        let key = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-key")).map(|(_, v)| v.as_str());
        assert_eq!(key, Some("K7"), "the script signed with what the node answered: {:?}", seen.borrow());
    }


    /// A chunk the page loads again that the route already carries runs from the route, not through the node: a
    /// browser reads its cache between calls, and a call reads its own code. Only a chunk the route lacks is fetched.
    #[test]
    fn a_chunk_the_route_carries_is_not_fetched_again() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![
            (
                "https://shop.example.com/boot.js".into(),
                r#"
                    const s = document.createElement('script');
                    s.src = '/lazy.js';
                    document.head.appendChild(s);
                "#.into(),
            ),
            (
                "https://shop.example.com/lazy.js".into(),
                r#"
                    setTimeout(function () {
                      const x = new XMLHttpRequest();
                      x.open('POST', '/api/search');
                      x.setRequestHeader('x-key', 'from-the-route');
                      x.send('{}');
                    }, 0);
                "#.into(),
            ),
        ];
        let html = r#"<html><head><script src="/boot.js"></script></head><body></body></html>"#;
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let seen = std::cell::RefCell::new(Vec::new());
        let mut net = |r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            seen.borrow_mut().push(r.url.path().to_string());
            Err("the route carries every chunk the page names".into())
        };
        let signed = sign_with(Some("node"), 12000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), html, &serde_json::Value::Null, Some(&mut net)).expect("the page's signed call");
        let key = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-key")).map(|(_, v)| v.as_str());
        assert_eq!(key, Some("from-the-route"));
        // The page's own call goes to the node, as every call does; its code does not.
        assert!(!seen.borrow().iter().any(|p| p.ends_with(".js")), "fetched a chunk the route carried: {:?}", seen.borrow());
    }

    /// The platform a page's producer may stand on is the engine's, not a stub: a wasm module compiles and an
    /// offscreen canvas is the one the page drew. A bundle that checks them signs with the truth.
    #[test]
    fn the_platform_a_bundle_reaches_for_is_there() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (function () {
                var wasm = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0]));
                var c = new OffscreenCanvas(2, 2);
                fetch('/api/search', { method: 'POST', headers: { 'x-wasm': String(wasm), 'x-canvas': c.toDataURL() }, body: '{}' });
            })();
        "#.into())];
        let fp = serde_json::json!({ "canvas": ["data:image/png;base64,ZZZ"] });
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let signed = sign_with(Some("node"), 200, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &fp, None).expect("the page's signed call");
        let got = |n: &str| signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.as_str());
        assert_eq!(got("x-wasm"), Some("true"));
        assert_eq!(got("x-canvas"), Some("data:image/png;base64,ZZZ"));
    }


    /// A bundle whose producer lives in a lazily loaded chunk: the import is fetched over the same line as a fetch,
    /// run in the sandbox, and its exports sign the call. This is the case that used to fall to the page bridge.
    #[test]
    fn a_chunk_loaded_lazily_is_fetched_and_run() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (async function () {
                var m = await import('/producer.js');
                fetch('/api/search', { method: 'POST', headers: { 'x-sig': m.sign('k'), 'x-meta': __ubMeta.url }, body: '{}' });
            })();
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let mut net = |r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            if r.url.path() == "/producer.js" {
                Ok(crate::trace::Exchange {
                    method: "GET".into(),
                    url: r.url.clone(),
                    request_headers: vec![],
                    request_body: None,
                    status: 200,
                    response_headers: vec![("content-type".into(), "text/javascript".into())],
                    response_body: Some("self.sign = function (v) { return 'sig-' + v; };".into()),
                    response_mime: "text/javascript".into(),
                    resource_type: None,
                    main_frame: None,
                })
            } else {
                Err("not asked".into())
            }
        };
        let signed = sign_with(Some("node"), 12000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &serde_json::Value::Null, Some(&mut net)).expect("the page's signed call");
        let got = |n: &str| signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.as_str());
        assert_eq!(got("x-sig"), Some("sig-k"), "{:?}", signed.headers);
        assert_eq!(got("x-meta"), Some("https://shop.example.com/search"));
        assert!(signed.modules.iter().any(|m| m.ends_with("/producer.js")), "the chunk is traced: {:?}", signed.modules);
    }

    /// A chunk bigger than the line's own buffer arrives whole: a page's entry bundle is megabytes, and one cut short
    /// reads to the page as a failed import, so it never reaches the call it signs.
    #[test]
    fn a_chunk_bigger_than_the_lines_buffer_arrives_whole() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (async function () {
                var m = await import('/producer.js');
                fetch('/api/search', { method: 'POST', headers: { 'x-sig': m.sign('k') }, body: '{}' });
            })();
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let chunk = format!("/* {} */ self.sign = function (v) {{ return 'sig-' + v; }};", "x".repeat(4 * 1024 * 1024));
        let mut net = |r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            if r.url.path() == "/producer.js" {
                Ok(crate::trace::Exchange {
                    method: "GET".into(),
                    url: r.url.clone(),
                    request_headers: vec![],
                    request_body: None,
                    status: 200,
                    response_headers: vec![("content-type".into(), "text/javascript".into())],
                    response_body: Some(chunk.clone()),
                    response_mime: "text/javascript".into(),
                    resource_type: None,
                    main_frame: None,
                })
            } else {
                Err("not asked".into())
            }
        };
        let signed = sign_with(Some("node"), 12000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &serde_json::Value::Null, Some(&mut net)).expect("the page's signed call");
        let got = |n: &str| signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.as_str());
        assert_eq!(got("x-sig"), Some("sig-k"), "{:?}", signed.headers);
    }


    /// An ES module chunk: evaluated as a module (its dependencies linked through the same line), and its exports sign
    /// the call. This is the other half of the lazily loaded chunk.
    #[test]
    fn an_es_module_chunk_is_evaluated_as_a_module() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (async function () {
                var m = await import('/producer.mjs');
                fetch('/api/search', { method: 'POST', headers: { 'x-sig': m.sign('k') }, body: '{}' });
            })();
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let mut net = |r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            if r.url.path() == "/producer.mjs" {
                Ok(crate::trace::Exchange {
                    method: "GET".into(), url: r.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    response_headers: vec![("content-type".into(), "text/javascript".into())],
                    response_body: Some("export function sign(v) { return 'esm-' + v; }".into()),
                    response_mime: "text/javascript".into(), resource_type: None, main_frame: None,
                })
            } else { Err("not asked".into()) }
        };
        let signed = sign_with(Some("node"), 12000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &serde_json::Value::Null, Some(&mut net)).expect("the page's signed call");
        let sig = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-sig")).map(|(_, v)| v.as_str());
        assert_eq!(sig, Some("esm-k"), "{:?}", signed.headers);
    }

    /// A page that declares its initial chunks (loadable's `__LOADABLE_REQUIRED_CHUNKS__`) expects their modules to be
    /// evaluated before the first render. Here the page's own callback only signs if the initial chunk's module has
    /// run, and the harness must have run it from the runtime's graph — not by name, and not after the event.
    #[test]
    fn a_declared_initial_chunk_is_evaluated_before_the_pages_events() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let html = r#"<html><head><script id="__LOADABLE_REQUIRED_CHUNKS__" type="application/json">["main"]</script></head><body>
            <script>
              (function () {
                var installed = {}, cache = {}, factories = {};
                function req(id) { if (cache[id]) return cache[id].exports; var m = cache[id] = { exports: {} }; factories[id](m, m.exports, req); return m.exports; }
                req.m = factories; req.c = cache; req.o = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
                var arr = self.__LOADABLE_LOADED_CHUNKS__ = [];
                var callback = function (prev, payload) {
                  var ids = payload[0] || [], mods = payload[1] || {}, run = payload[2];
                  if (ids.some(function (id) { return installed[id] !== 0; })) { for (var k in mods) if (req.o(mods, k)) factories[k] = mods[k]; if (run) run(req); }
                  for (var i = 0; i < ids.length; i++) installed[ids[i]] = 0;
                  if (prev) prev(payload);
                  return req;
                };
                arr.push = callback.bind(null, arr.push.bind(arr));
                arr.push([["main"], { 1: function (e, t, n) { window.__initialReady = true; } }]);
              })();
            </script>
            <script>
              document.addEventListener('DOMContentLoaded', function () {
                if (window.__initialReady) fetch('/api/search', { method: 'POST', headers: { 'x-warm': 'yes' }, body: '{}' });
              });
            </script>
        </body></html>"#;
        let bundle: Bundle = vec![];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let mut net = |_: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> { Err("not asked".into()) };
        let signed = sign_with(Some("node"), 12000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), html, &serde_json::Value::Null, Some(&mut net)).expect("the page's signed call");
        let warm = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-warm")).map(|(_, v)| v.as_str());
        assert_eq!(warm, Some("yes"), "{:?}", signed.headers);
    }

    /// One boot answers every signed step the page makes: the run returns all of the page's calls, so a route with
    /// two of them does not load the page twice.
    #[test]
    fn one_boot_returns_every_call_the_page_makes() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            fetch('/api/one', { method: 'POST', body: '{}' });
            fetch('/api/two', { method: 'POST', body: '{}' });
        "#.into())];
        let targets = vec![("POST".to_string(), "/api/one".to_string()), ("POST".to_string(), "/api/two".to_string())];
        let mut net = |_: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> { Err("not asked".into()) };
        let calls = sign_page(&bundle, "https://shop.example.com/search", "", &Storage::default(), "", &serde_json::Value::Null, &[], Some(&mut net), &targets).expect("one boot");
        let mut paths: Vec<&str> = calls.iter().map(|c| c.url.rsplit('/').next().unwrap_or_default()).collect();
        paths.sort();
        assert_eq!(paths, vec!["one", "two"], "both signed steps come from one boot: {:?}", calls.iter().map(|c| &c.url).collect::<Vec<_>>());
    }

    /// A `<script type="module">` runs as a module, not as a classic script: its top-level bindings are its own and
    /// its imports link through the page's line. A bundler's vendor chunk is a module with no exports of its own, and
    /// running it as a classic script leaves its bindings undefined (Etsy's vendor read a document alias it never got).
    #[test]
    fn a_module_script_runs_in_its_own_scope_and_links_its_imports() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://shop.example.com/one.js".into(), r#"
            import { x } from '/two.js';
            const document = undefined;
            fetch('/api/search', { method: 'POST', headers: { 'x-module': x }, body: '{}' });
        "#.into())];
        let html = r#"<html><head><script type="module" src="/one.js"></script></head><body>page</body></html>"#;
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let mut net = |r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            if r.url.path() == "/two.js" {
                Ok(crate::trace::Exchange {
                    method: "GET".into(), url: r.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    response_headers: vec![("content-type".into(), "text/javascript".into())],
                    response_body: Some("export const x = 'm';".into()), response_mime: "text/javascript".into(),
                    resource_type: None, main_frame: None,
                })
            } else {
                Err("not asked".into())
            }
        };
        let signed = sign_with(Some("node"), 12000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), html, &serde_json::Value::Null, Some(&mut net)).expect("the module's signed call");
        let got = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-module")).map(|(_, v)| v.as_str());
        assert_eq!(got, Some("m"), "{:?}", signed.headers);
    }

    /// A challenge page's own proof: its script computes a value, sends it, and writes the clearance the site answers
    /// with into its cookie jar. A door pass reads the page's scripts and hands back the cookie it earned.
    #[test]
    fn a_door_pass_returns_the_cookie_its_page_earned() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://shop.example.com/check.js".into(), r#"
            document.cookie = 'cf_clearance=earned; path=/';
            fetch('/verify', { method: 'POST', headers: { 'x-proof': 'p1' }, body: '{}' });
        "#.into())];
        let html = r#"<html><head><script src="/check.js"></script></head><body>Verifying you are human</body></html>"#;
        let mut asked = false;
        let mut net = |r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            if r.url.path() == "/verify" {
                asked = true;
                Ok(crate::trace::Exchange {
                    method: "POST".into(), url: r.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    response_headers: vec![("set-cookie".into(), "session=ok; Path=/".into())],
                    response_body: Some("{}".into()), response_mime: "application/json".into(), resource_type: None, main_frame: None,
                })
            } else {
                Err("not asked".into())
            }
        };
        let run = door_pass(&bundle, "https://shop.example.com/", "", &Storage::default(), html, &serde_json::Value::Null, Some(&mut net)).expect("the page ran");
        assert!(asked, "the page's proof was sent: {:?}", run.calls.iter().map(|c| c.url.clone()).collect::<Vec<_>>());
        assert!(run.cookies.iter().any(|(k, v)| k == "cf_clearance" && v == "earned"), "{:?}", run.cookies);
    }

    /// A stylesheet the page inserts answers its `load`: a bundler treats a CSS chunk like a script chunk and waits on
    /// it before rendering the next thing, so an unanswered `<link>` aborts the page's own data call (trip.com's
    /// flight list stopped on `ChunkLoadError: Loading CSS chunk list-csr-gateway-flight-list failed`, 2026-11-11).
    #[test]
    fn a_stylesheet_the_page_inserts_answers_its_load() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (function () {
                var link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = '/chunk.css';
                link.onload = function () {
                    fetch('/api/call', { method: 'POST', headers: { 'x-css': 'loaded' }, body: '{}' });
                };
                document.head.appendChild(link);
            })();
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/call", Some("{}"));
        let mut net = |_r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> { Err("not asked".into()) };
        let signed = sign_with(Some("node"), 12000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &serde_json::Value::Null, Some(&mut net)).expect("the page's signed call");
        let said = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-css")).map(|(_, v)| v.as_str());
        assert_eq!(said, Some("loaded"), "the stylesheet's load let the page go on: {:?}", signed.headers);
    }

    /// A tracker that wraps the XHR answer by descriptor (`Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype,
    /// 'response')`) finds both halves — and the page still works through them. Etsy's consent script stopped on
    /// exactly this read when the answer's fields were plain instance properties (2026-11-11).
    #[test]
    fn a_page_that_wraps_the_xhr_answer_finds_its_accessors() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (function () {
                var proto = XMLHttpRequest.prototype;
                ['readyState', 'status', 'responseText', 'response', 'responseType'].forEach(function (n) {
                    var d = Object.getOwnPropertyDescriptor(proto, n);
                    if (!d || typeof d.get !== 'function' || typeof d.set !== 'function') throw new Error(n + ' is not an accessor');
                });
                var x = new XMLHttpRequest();
                x.open('GET', '/warm');
                // The wrapper's own write path: a value set through the accessor reads back through it.
                x.responseType = 'json';
                if (x.responseType !== 'json') throw new Error('responseType did not round-trip: ' + x.responseType);
                x.send(null);
                fetch('/api/call', { method: 'POST', headers: { 'x-answer': String(x.responseType) }, body: '{}' });
            })();
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/call", Some("{}"));
        let mut net = |r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            if r.url.path() == "/warm" {
                Ok(crate::trace::Exchange {
                    method: "GET".into(), url: r.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    response_headers: vec![("content-type".into(), "application/json".into())],
                    response_body: Some("{\"warm\":true}".into()), response_mime: "application/json".into(),
                    resource_type: None, main_frame: None,
                })
            } else {
                Err("not asked".into())
            }
        };
        let signed = sign_with(Some("node"), 12000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &serde_json::Value::Null, Some(&mut net)).expect("the page's signed call");
        let said = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-answer")).map(|(_, v)| v.as_str());
        assert_eq!(said, Some("json"), "the wrapper wrote and read the answer through its accessors: {:?}", signed.headers);
    }

    /// A page's script that asks for a document of its own (`new DOMImplementation().createHTMLDocument`) gets one and
    /// goes on to its call: a consent or polyfill script that throws on the constructor aborts the page's boot before
    /// its own module graph runs (etsy.com's airgap.js, 2026-11-11).
    #[test]
    fn a_page_that_asks_for_a_dom_implementation_gets_one() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (function () {
                var doc = new DOMImplementation().createHTMLDocument('probe');
                if (!doc || !doc.createElement) throw new Error('no document from the implementation');
                doc.createElement('div');
                fetch('/api/call', { method: 'POST', headers: { 'x-implementation': doc.title }, body: '{}' });
            })();
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/call", Some("{}"));
        let mut net = |_r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> { Err("not asked".into()) };
        let signed = sign_with(Some("node"), 12000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &serde_json::Value::Null, Some(&mut net)).expect("the page's signed call");
        let said = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-implementation")).map(|(_, v)| v.as_str());
        assert_eq!(said, Some("probe"), "the document the page made is a document: {:?}", signed.headers);
    }

    /// A page that reads a server-sent stream the way Trip's does (`response.body.getReader()`) and makes the call that
    /// follows it. The bridge answer may lose the content-type; the body says what it is, and the stream is readable.
    #[test]
    fn a_page_can_read_a_server_sent_stream_and_make_the_call_after_it() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (async function () {
                var r = await fetch('/sse', { method: 'GET' });
                if (!r.body || !r.body.getReader) throw new Error('no stream body');
                if (r.headers.get('content-type') !== 'text/event-stream') throw new Error('content-type ' + r.headers.get('content-type'));
                var reader = r.body.getReader(), text = '';
                for (;;) { var step = await reader.read(); if (step.done) break; text += new TextDecoder().decode(step.value); }
                fetch('/api/call', { method: 'POST', headers: { 'x-sse': text.trim() }, body: '{}' });
            })();
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/call", Some("{}"));
        let mut net = |r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            if r.url.path() == "/sse" {
                Ok(crate::trace::Exchange {
                    method: "GET".into(), url: r.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    // The header is missing on purpose: the body says it is an event stream.
                    response_headers: vec![],
                    response_body: Some("data: {\"a\":1}\n\n".into()), response_mime: String::new(),
                    resource_type: None, main_frame: None,
                })
            } else {
                Err("not asked".into())
            }
        };
        let signed = sign_with(Some("node"), 12000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &serde_json::Value::Null, Some(&mut net)).expect("the page's signed call");
        let sse = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-sse")).map(|(_, v)| v.as_str());
        assert_eq!(sse, Some("data: {\"a\":1}"), "the stream was read and the call after it made: {:?}", signed.headers);
    }

    /// A worker: its own script, its own global, the same line to the node; a message it posts back signs the call.
    #[test]
    fn a_workers_message_signs_the_call() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (function () {
                var w = new Worker('/worker.js');
                w.onmessage = function (e) {
                    fetch('/api/search', { method: 'POST', headers: { 'x-w': e.data }, body: '{}' });
                };
                w.postMessage('hello');
            })();
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let mut net = |r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            if r.url.path() == "/worker.js" {
                Ok(crate::trace::Exchange {
                    method: "GET".into(), url: r.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    response_headers: vec![("content-type".into(), "text/javascript".into())],
                    response_body: Some("self.onmessage = function (e) { self.postMessage('w-' + e.data); };".into()),
                    response_mime: "text/javascript".into(), resource_type: None, main_frame: None,
                })
            } else { Err("not asked".into()) }
        };
        let signed = sign_with(Some("node"), 12000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &serde_json::Value::Null, Some(&mut net)).expect("the page's signed call");
        let got = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-w")).map(|(_, v)| v.as_str());
        assert_eq!(got, Some("w-hello"), "{:?}", signed.headers);
    }

    /// A worker's `importScripts`: the scripts it names are fetched over the same line as its own, run in the order it
    /// calls them, and one of those scripts may name another — the loader a worker's bundle is written with.
    #[test]
    fn a_workers_import_scripts_ride_the_line_and_run_in_order() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (function () {
                var w = new Worker('/worker.js');
                w.onmessage = function (e) {
                    fetch('/api/search', { method: 'POST', headers: { 'x-imports': e.data }, body: '{}' });
                };
                w.postMessage('go');
            })();
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let mut net = |r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            let body = match r.url.path() {
                "/worker.js" => "importScripts('/lib-a.js', '/lib-b.js'); self.onmessage = function () { self.postMessage(self.order + '|' + self.extra); };",
                "/lib-a.js" => "self.order = 'a';",
                "/lib-b.js" => "importScripts('/lib-c.js'); self.order = (self.order || '') + 'b';",
                "/lib-c.js" => "self.extra = 'c';",
                _ => return Err("not asked".into()),
            };
            Ok(crate::trace::Exchange {
                method: "GET".into(), url: r.url.clone(), request_headers: vec![], request_body: None, status: 200,
                response_headers: vec![("content-type".into(), "text/javascript".into())],
                response_body: Some(body.into()), response_mime: "text/javascript".into(), resource_type: None, main_frame: None,
            })
        };
        let signed = sign_with(Some("node"), 12000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &serde_json::Value::Null, Some(&mut net)).expect("the page's signed call");
        let got = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-imports")).map(|(_, v)| v.as_str());
        assert_eq!(got, Some("ab|c"), "{:?}", signed.headers);
    }


    /// A page's code often starts on the page events: the sandbox fires DOMContentLoaded and load, so a producer that
    /// signs then does sign.
    #[test]
    fn a_producer_that_starts_on_page_events_still_signs() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            window.addEventListener('DOMContentLoaded', function () {
                fetch('/api/search', { method: 'POST', headers: { 'x-d': 'ready' }, body: '{}' });
            });
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let signed = sign_with(Some("node"), 400, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &serde_json::Value::Null, None).expect("the page's signed call");
        let got = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-d")).map(|(_, v)| v.as_str());
        assert_eq!(got, Some("ready"));
    }

    /// A mount node the page's own code creates and appends is findable by id, as a browser's would be: a framework
    /// that builds its root (`document.createElement('div'); root.id='root'; body.appendChild(root)`) and then asks
    /// `getElementById('root')` for it must find it, not null — the markup the walk carried has no such node (it is
    /// made at run time), and a React app whose mount lookup comes back empty never renders its first call.
    #[test]
    fn a_mount_node_the_page_creates_and_appends_is_findable_by_id() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            var root = document.createElement('div');
            root.id = 'root';
            document.body.appendChild(root);
            var found = document.getElementById('root');
            fetch('/api/search', { method: 'POST', headers: { 'x-mount': found ? 'found' : 'missing' }, body: '{}' });
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let signed = sign_with(Some("node"), 400, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "<html><body><div id='main'></div></body></html>", &serde_json::Value::Null, None).expect("the page's signed call");
        let got = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-mount")).map(|(_, v)| v.as_str());
        assert_eq!(got, Some("found"), "a mount node the page creates and appends must be findable by id");
    }

    /// A parsed element belongs to the document: a framework's `createRoot` reads `node.ownerDocument` (to listen for
    /// selectionchange on it), and a mount node read by id from the carried markup must answer the document, not
    /// undefined — the read of a property on undefined is what stopped the app from rendering its first call.
    #[test]
    fn a_parsed_element_belongs_to_the_document_a_framework_reads() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            var m = document.getElementById('main');
            var od = m && m.ownerDocument;
            fetch('/api/search', { method: 'POST', headers: { 'x-od': od ? 'present' : 'undefined' }, body: '{}' });
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let signed = sign_with(Some("node"), 400, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "<html><body><div id='main'></div></body></html>", &serde_json::Value::Null, None).expect("the page's signed call");
        let got = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-od")).map(|(_, v)| v.as_str());
        assert_eq!(got, Some("present"), "a parsed element's ownerDocument is the document, as a framework's createRoot reads it");
    }


    /// The data layer over the markup: the bundle's start-up asks its own config, the walk's answer is on the route, and
    /// the call is signed with what that answer said — with no line at all (a net that refuses everything).
    #[test]
    fn a_recorded_answer_boots_the_bundle_without_a_line() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (async function () {
                var r = await fetch('/restapi/getAppConfig.json', { method: 'POST', body: '{}' });
                var cfg = await r.json();
                fetch('/api/search', { method: 'POST', headers: { 'x-sig': cfg.sig, 'x-cid': cfg.head.ClientID }, body: '{}' });
            })();
        "#.into())];
        let answers = vec![crate::signing::Answer {
            url: "https://shop.example.com/restapi/getAppConfig.json".into(),
            status: 200,
            mime: "application/json".into(),
            body: r#"{"sig":"cfg-1","head":{"ClientID":"cid-9"}}"#.into(),
        }];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let mut net = |_r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> { Err("the line is not used".into()) };
        let signed = run(Some("node"), 600, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &serde_json::Value::Null, &answers, Some(&mut net), false).expect("the page's signed call");
        let got = |n: &str| signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.as_str());
        assert_eq!(got("x-sig"), Some("cfg-1"));
        assert_eq!(got("x-cid"), Some("cid-9"));
    }


    /// The page's own inline scripts run first, in document order, before the bundles the tags name: the config a
    /// bundle reads is written there, not in a script it loads.
    #[test]
    fn an_inline_script_the_page_carries_runs_before_the_bundles() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let html = r#"<html><head>
            <script>window.CFG = { sig: 'inline-1' };</script>
            <script src="https://cdn.shop.example.com/app.js"></script>
        </head></html>"#;
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            fetch('/api/search', { method: 'POST', headers: { 'x-sig': (window.CFG || {}).sig || 'none' }, body: '{}' });
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let signed = sign_with(Some("node"), 400, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), html, &serde_json::Value::Null, None).expect("the page's signed call");
        let got = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-sig")).map(|(_, v)| v.as_str());
        assert_eq!(got, Some("inline-1"));
    }

    /// A page that makes no call at the path asked for answers nothing: the call then goes to the browser, as it
    /// always has.
    #[test]
    fn a_page_that_makes_no_call_at_the_path_answers_nothing() {
        if !available() {
            eprintln!("no signing runtime: skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            fetch('/api/elsewhere', { method: 'POST', headers: { 'x-sig': 'other' }, body: '{}' });
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some(r#"{"q":"kettle"}"#));
        assert!(sign_with(Some("node"), 200, &bundle, "https://shop.example.com/search?q=kettle", &asked, "", &Storage::default(), "", &serde_json::Value::Null, None).is_none());
    }

    /// No runtime, no answer: the bridge says so rather than guessing, and the step keeps going to the browser.
    #[test]
    fn no_runtime_answers_nothing() {
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), "fetch('/api/search')".into())];
        let asked = request("GET", "https://shop.example.com/api/search", None);
        assert!(sign_with(None, 100, &bundle, "https://shop.example.com/", &asked, "", &Storage::default(), "", &serde_json::Value::Null, None).is_none());
        assert!(sign_with(Some("/nonexistent/signing-program"), 100, &bundle, "https://shop.example.com/", &asked, "", &Storage::default(), "", &serde_json::Value::Null, None).is_none());
    }

    // ---- what page code and a generated program cannot do ----

    /// Everything a page's script might try to reach the runtime with: every object it is handed and every error it
    /// is thrown, walked to its constructor's constructor; the stack frames under it; the callers above it; and the
    /// runtime's own names. Reports, in a header of its call, which of them reached a process (`none` when nothing did).
    const ESCAPES: &str = r#"
        (async function () {
            var reached = [];
            var isHost = function (p) { try { return !!(p && typeof p === 'object' && p.versions && p.versions.node) || (p && typeof p.mainModule === 'object'); } catch (e) { return false; } };
            var via = function (name, o) {
                try { var F = o.constructor.constructor; var P = F('return typeof process === "undefined" ? undefined : process')(); if (isHost(P)) reached.push(name); } catch (e) {}
                try { var G = Object.getPrototypeOf(o).constructor.constructor('return this')(); if (G && isHost(G.process)) reached.push(name + '-global'); } catch (e) {}
            };
            via('global', this); via('window', window); via('fetch', fetch); via('setTimeout', setTimeout); via('Buffer', typeof Buffer === 'undefined' ? {} : Buffer);
            via('URL', new URL('https://shop.example.com/')); via('document', document); via('xhr', new XMLHttpRequest()); via('crypto', crypto);
            via('subtle', crypto.subtle); via('digest', crypto.subtle.digest); via('storage', localStorage); via('wasm', WebAssembly);
            via('encoder', new TextEncoder()); via('stream', new ReadableStream({})); via('headers', new Headers()); via('blob', new Blob(['x']));
            // What the shim grew since: a DOM implementation, the XHR answer's accessors, the page's own descriptor reader.
            via('implementation', document.implementation); try { via('DOMImplementation', new DOMImplementation()); } catch (e) {}
            try { via('xhr-getter', Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response').get); } catch (e) {}
            via('gopd', Object.getOwnPropertyDescriptor); try { via('created', document.implementation.createHTMLDocument('t')); } catch (e) {}
            // A function the shim calls back (a chunk array's `push` it wraps): every caller above it, and what each was
            // called with.
            var walk = function (name, c) { for (var i = 0; c && i < 16; i++) { via(name, c); try { var a = c.arguments; if (a) for (var k = 0; k < a.length; k++) via(name + '-arg', a[k]); } catch (x) {} try { c = c.caller; } catch (x) { c = null; } } };
            window.webpackChunk = [];
            window.webpackChunk.push = function () { try { walk('push-caller', arguments.callee.caller); } catch (e) {} return Array.prototype.push.apply(this, arguments); };
            document.addEventListener('DOMContentLoaded', function loaded() { try { walk('event-caller', loaded.caller); } catch (e) {} });
            via('fetched', await fetch('/api/ping'));
            try { window.webpackChunk.push([['probe'], {}]); } catch (e) {}
            if (typeof require === 'function') reached.push('require');
            if (isHost(typeof process === 'undefined' ? undefined : process)) reached.push('process');
            try { await import('node:child_process'); reached.push('import'); } catch (e) { via('import-error', e); }
            try { new URL('::'); } catch (e) { via('url-error', e); }
            try { await crypto.subtle.digest('NO-SUCH-HASH', new Uint8Array(1)); } catch (e) { via('subtle-error', e); }
            try { atob('%%%'); } catch (e) { via('atob-error', e); }
            Error.prepareStackTrace = function (e, frames) {
                frames.forEach(function (f) { try { var fn = f.getFunction(); if (fn) via('frame', fn); var t = f.getThis(); if (t) via('frame-this', t); } catch (x) {} });
                return '';
            };
            setTimeout(function later() {
                try { new Error('x').stack; } catch (e) {}
                try { var c = later.caller; for (var i = 0; c && i < 16; i++) { via('caller', c); c = c.caller; } } catch (e) {}
                fetch('/api/search', { method: 'POST', headers: { 'x-escapes': reached.join(',') || 'none' }, body: '{}' });
            }, 0);
        })();
    "#;

    /// A page's script reaches no object of the runtime's, however it walks: constructors, errors, stack frames,
    /// callers, `require`, `process`, `import()`. The page's realm holds only what was made in it.
    #[test]
    fn a_page_cannot_reach_the_host_process_through_a_constructor_chain() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), ESCAPES.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let signed = sign_with(Some("node"), 2000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &serde_json::Value::Null, None).expect("the page ran its probes");
        let said = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-escapes")).map(|(_, v)| v.clone());
        assert_eq!(said.as_deref(), Some("none"), "the page reached the runtime through: {said:?}");
    }

    /// The same probes from a challenge page the door pass boots: it is a page like any other, and gets nothing more.
    #[test]
    fn a_door_pass_page_cannot_reach_the_host_process() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://shop.example.com/challenge.js".into(), ESCAPES.replace("fetch('/api/search', { method: 'POST', headers: { 'x-escapes': reached.join(',') || 'none' }, body: '{}' });", "document.cookie = 'escapes=' + (reached.join(',') || 'none');"))];
        let run = door_pass(&bundle, "https://shop.example.com/", "", &Storage::default(), "", &serde_json::Value::Null, None).expect("the page ran");
        let said = run.cookies.iter().find(|(k, _)| k == "escapes").map(|(_, v)| v.clone());
        assert_eq!(said.as_deref(), Some("none"), "the door's page reached the runtime through: {said:?}");
    }

    /// A generated program gets the arithmetic it was promised and no way past it: its `Buffer`, its hashes and its
    /// `require` are made in its own realm.
    #[test]
    fn a_generated_program_cannot_reach_the_host_process() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let program = r#"
            function sign(ctx) {
                var reached = [];
                var isHost = function (p) { try { return !!(p && typeof p === 'object' && p.versions && p.versions.node); } catch (e) { return false; } };
                var via = function (name, o) { try { if (isHost(o.constructor.constructor('return typeof process === "undefined" ? undefined : process')())) reached.push(name); } catch (e) {} };
                via('Buffer', Buffer); via('buffer', Buffer.from('x')); via('crypto', crypto); via('hash', crypto.createHash('sha256')); via('md5', md5);
                via('require', require); via('global', this); via('URL', URL);
                try { require('child_process'); reached.push('child_process'); } catch (e) { via('require-error', e); }
                try { require('fs'); reached.push('fs'); } catch (e) {}
                return (reached.join(',') || 'none') + ':' + sha256('a').slice(0, 8);
            }
        "#;
        let said = run_program(program, &serde_json::json!({}), &serde_json::Value::Null, &Storage::default()).expect("the program answered");
        assert_eq!(said, "none:ca978112", "the program reached the runtime, or lost its hashes");
    }

    /// The page asks the node, and the node decides: only the page's own site, over HTTPS, at a public address. The
    /// node's own machine, the owner's network, the cloud's metadata address, plain HTTP and another site are never
    /// fetched for it, whoever's route it is.
    #[test]
    fn a_page_in_the_sandbox_cannot_have_the_node_fetch_a_private_address() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            (async function () {
                var tried = ['http://127.0.0.1:9/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://10.0.0.1/x', 'https://192.168.1.1/x',
                    'https://169.254.169.254/latest/meta-data/', 'https://[::1]/x', 'http://shop.example.com/plain', 'https://elsewhere.example.org/x',
                    'https://intranet/x', 'https://api.shop.example.com/ok'];
                var got = [];
                var cookie = 'unread';
                for (var i = 0; i < tried.length; i++) { try { var r = await fetch(tried[i]); if (i === tried.length - 1) cookie = String(r.headers.get('set-cookie')); } catch (e) {} }
                fetch('/api/search', { method: 'POST', headers: { 'x-cookie': cookie }, body: '{}' });
            })();
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let mut fetched: Vec<String> = Vec::new();
        let mut net = |r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            fetched.push(r.url.to_string());
            Ok(crate::trace::Exchange { method: r.method.clone(), url: r.url.clone(), request_headers: vec![], request_body: None, status: 200, response_headers: vec![("set-cookie".into(), "sid=secret".into())], response_body: Some("{}".into()), response_mime: "application/json".into(), resource_type: None, main_frame: None })
        };
        let signed = sign_with(Some("node"), 3000, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), "", &serde_json::Value::Null, Some(&mut net)).expect("the page's signed call");
        assert_eq!(fetched, vec!["https://api.shop.example.com/ok".to_string(), "https://shop.example.com/api/search".to_string()], "only the page's own site is fetched");
        let cookie = signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-cookie")).map(|(_, v)| v.clone());
        assert_eq!(cookie.as_deref(), Some("null"), "the site's cookies never reach the page's script, as in a browser");
    }

    /// The page loads nothing by itself: a frame, an image, a stylesheet in its markup or made by its code goes
    /// nowhere. What the node fetches for it is what its code asked for over the line, and nothing else.
    #[test]
    fn the_page_loads_nothing_but_what_it_asks_the_node_for() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let html = r#"<html><head><link rel="stylesheet" href="https://shop.example.com/style.css"></head><body><iframe src="https://shop.example.com/frame"></iframe><img src="https://shop.example.com/pixel.gif"></body></html>"#;
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            var f = document.createElement('iframe'); f.src = 'https://shop.example.com/made-frame'; document.body.appendChild(f);
            var i = new Image(); i.src = 'https://shop.example.com/made-pixel.gif';
            var l = document.createElement('link'); l.href = 'https://shop.example.com/made.css'; document.head.appendChild(l);
            fetch('/api/search', { method: 'POST', headers: { 'x-sig': 'ok' }, body: '{}' });
        "#.into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        let mut fetched: Vec<String> = Vec::new();
        let mut net = |r: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            fetched.push(r.url.to_string());
            Err("not asked".into())
        };
        let signed = sign_with(Some("node"), 600, &bundle, "https://shop.example.com/search", &asked, "", &Storage::default(), html, &serde_json::Value::Null, Some(&mut net)).expect("the page's signed call");
        assert_eq!(signed.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-sig")).map(|(_, v)| v.as_str()), Some("ok"));
        assert_eq!(fetched, vec!["https://shop.example.com/api/search".to_string()], "only the call the page's code made went over the line");
    }

    /// A page that spins forever is cut at its time: the run ends with no answer, and the node goes on (the next run
    /// answers as before).
    #[test]
    fn a_page_that_spins_forever_is_killed_at_its_time() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let spin: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), "setTimeout(function () { for (;;) {} }, 0);".into())];
        let limits = Limits { ready: std::time::Duration::from_secs(20), wall: std::time::Duration::from_secs(2), memory_mb: 1024, said_bytes: RUN_SAID_MAX };
        let began = std::time::Instant::now();
        let run = run_all_held(Some("node"), 400, &spin, "https://shop.example.com/", "", &Storage::default(), "", &serde_json::Value::Null, &[], None, false, &[], None, limits);
        assert!(run.is_none(), "a run that never answered has no answer");
        assert!(began.elapsed() < std::time::Duration::from_secs(15), "the spin was cut at its time, not waited out: {:?}", began.elapsed());
        let fine: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), "fetch('/api/search', { method: 'POST', headers: { 'x-sig': 'after' }, body: '{}' });".into())];
        let asked = request("POST", "https://shop.example.com/api/search", Some("{}"));
        assert!(sign_with(Some("node"), 200, &fine, "https://shop.example.com/", &asked, "", &Storage::default(), "", &serde_json::Value::Null, None).is_some(), "the next run answers");
    }

    /// A page that allocates without bound is killed past its memory, long before its time is up.
    #[test]
    fn a_page_that_allocates_without_bound_is_killed_past_its_memory() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let hog: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            var held = [];
            setTimeout(function grow() { for (var i = 0; i < 8; i++) held.push(new Uint8Array(32 << 20).fill(7)); setTimeout(grow, 0); }, 0);
        "#.into())];
        let limits = Limits { ready: std::time::Duration::from_secs(20), wall: std::time::Duration::from_secs(60), memory_mb: 256, said_bytes: RUN_SAID_MAX };
        let began = std::time::Instant::now();
        let run = run_all_held(Some("node"), 30_000, &hog, "https://shop.example.com/", "", &Storage::default(), "", &serde_json::Value::Null, &[], None, false, &[], None, limits);
        assert!(run.is_none(), "a run killed for its memory has no answer");
        assert!(began.elapsed() < std::time::Duration::from_secs(30), "the run was killed for its memory, not its time: {:?}", began.elapsed());
    }

    /// Runs `js` with the runtime's own objects in hand, as a page would if it ever got out of its realm, inside every
    /// other layer: what it prints. None where this machine can't confine a runtime.
    fn escaped(js: &str, args: &[&str]) -> Option<String> {
        let c = confined(&runtime()?)?;
        let dir = RunDir::new("test")?;
        let script = dir.write("escaped.js", js.as_bytes())?;
        let out = c.command(&dir, std::time::Duration::from_secs(20)).arg(&script).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// Even with the runtime in hand, a page reads no file but the run's own inputs: not another folder's file, not
    /// the owner's home.
    #[test]
    fn an_escaped_page_still_cannot_read_a_file_outside_its_inputs() {
        let Some(outside) = RunDir::new("test-outside") else { return };
        let secret = outside.write("secret", b"the owner's").expect("a file");
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        let js = r#"
            const fs = require('fs');
            const r = [];
            for (const p of process.argv.slice(2)) { try { fs.readFileSync(p); r.push('read'); } catch (e) { try { fs.readdirSync(p); r.push('listed'); } catch (x) { r.push('denied'); } } }
            console.log(r.join(','));
        "#;
        let Some(said) = escaped(js, &[secret.to_str().unwrap(), &home, "/etc/hosts"]) else {
            eprintln!("no confinable runtime on this machine: skipped");
            return;
        };
        assert_eq!(said, "denied,denied,denied");
    }

    /// Even with the runtime in hand, a page starts no process: not a shell, not the runtime again, not a worker.
    #[test]
    fn an_escaped_page_still_cannot_start_a_process() {
        let js = r#"
            const r = [];
            const tryIt = (f) => { try { f(); r.push('ran'); } catch (e) { r.push('denied'); } };
            tryIt(() => require('child_process').execFileSync('/bin/sh', ['-c', 'true'], { stdio: 'ignore' }));
            tryIt(() => require('child_process').execFileSync(process.execPath, ['-e', '0'], { stdio: 'ignore' }));
            tryIt(() => new (require('worker_threads').Worker)('0', { eval: true }));
            tryIt(() => process.binding('spawn_sync'));
            console.log(r.join(','));
        "#;
        let Some(said) = escaped(js, &[]) else {
            eprintln!("no confinable runtime on this machine: skipped");
            return;
        };
        assert_eq!(said, "denied,denied,denied,denied");
    }

    /// Even with the runtime in hand, a page opens no socket: a listener on the node's own machine hears nothing.
    #[test]
    fn an_escaped_page_still_cannot_open_a_socket() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("a listener");
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port().to_string();
        let js = r#"
            const r = [];
            const end = () => { if (r.length === 2) { console.log(r.join(',')); process.exit(0); } };
            const s = require('net').connect(Number(process.argv[2]), '127.0.0.1');
            s.on('connect', () => { r.push('connected'); end(); });
            s.on('error', () => { r.push('denied'); end(); });
            fetch('http://127.0.0.1:' + process.argv[2] + '/').then(() => { r.push('fetched'); end(); }, () => { r.push('denied'); end(); });
            setTimeout(() => { while (r.length < 2) r.push('denied'); end(); }, 5000);
        "#;
        let Some(said) = escaped(js, &[&port]) else {
            eprintln!("no confinable runtime on this machine: skipped");
            return;
        };
        assert_eq!(said, "denied,denied");
        assert!(listener.accept().is_err(), "nothing reached the node's listener");
    }

    /// Even with the runtime in hand, a page sees none of the node's environment: no key, no path, no setting.
    #[test]
    fn an_escaped_page_sees_none_of_the_nodes_environment() {
        let js = "console.log(JSON.stringify(Object.keys(process.env).filter((k) => k !== '__CF_USER_TEXT_ENCODING')));";
        let Some(said) = escaped(js, &[]) else {
            eprintln!("no confinable runtime on this machine: skipped");
            return;
        };
        assert_eq!(said, "[]");
    }

    /// A run's folder is the run's alone: a name nobody can guess, made fresh (one already there is never used),
    /// readable by the owner only, its files too, and gone when the run ends.
    #[test]
    fn a_sandbox_run_folder_is_private_fresh_and_removed() {
        let dir = RunDir::new("test-private").expect("a folder");
        let path = dir.path.clone();
        let file = dir.write("spec.json", b"{\"cookies\":\"sid=1\"}").expect("a file");
        assert!(dir.write("spec.json", b"again").is_none(), "a file already there is never written through");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let other = RunDir::new("test-private").expect("another folder");
        assert_ne!(other.path, path, "two runs never share a folder");
        drop(dir);
        assert!(!path.exists(), "the folder goes with the run");
    }

    /// One classification of addresses holds everywhere a page's or a route's request could leave: the transport's
    /// rule, the browser's proxy and the sandbox's line to the node all refuse an address the protocol sets aside,
    /// written plainly or carried in an IPv6 address.
    #[test]
    fn one_classification_refuses_a_set_aside_address_everywhere() {
        let page = url::Url::parse("https://shop.example.com/").unwrap();
        for ip in ["192.0.0.1", "198.18.0.1", "240.0.0.1", "100.64.0.1", "::ffff:192.0.0.1", "64:ff9b::c000:1", "2002:c000:1::1", "fd00::1", "fe80::1"] {
            let addr: std::net::IpAddr = ip.parse().unwrap();
            assert!(!crate::egress::is_public_ip(addr), "{ip}");
            assert!(crate::proxy::browser_may_reach(addr).is_err() || crate::egress::private_allowed(), "the browser's proxy lets {ip} through");
            let host = if addr.is_ipv6() { format!("[{ip}]") } else { ip.to_string() };
            let url = url::Url::parse(&format!("https://{host}/x")).unwrap();
            assert!(crate::egress::Egress::Foreign.request(&url).is_err(), "the transport's rule lets {ip} through");
            assert!(page_may_ask(Some(&page), &url).is_err(), "the sandbox's line lets {ip} through");
        }
    }

    /// A run that floods its line is cut at its budget: the node holds at most one line of it at a time, and stops
    /// reading once the run has said more than it may in all. The run then has no answer, and the node goes on.
    #[test]
    fn a_page_that_floods_the_line_is_cut_at_its_budget() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let flood: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), r#"
            var big = new Array(1 << 20).join('x');
            for (var i = 0; i < 200; i++) fetch('/api/flood', { method: 'POST', body: big });
        "#.into())];
        let mut answered = 0usize;
        let mut net = |_: &Request, _: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            answered += 1;
            Err("not asked".into())
        };
        let limits = Limits { ready: std::time::Duration::from_secs(20), wall: std::time::Duration::from_secs(60), memory_mb: 1024, said_bytes: 16 << 20 };
        let began = std::time::Instant::now();
        let run = run_all_held(Some("node"), 30_000, &flood, "https://shop.example.com/", "", &Storage::default(), "", &serde_json::Value::Null, &[], Some(&mut net), false, &[], None, limits);
        assert!(run.is_none(), "a run that said more than it may has no answer");
        assert!(answered < 16, "the node stopped reading at the budget: {answered} requests taken");
        assert!(began.elapsed() < std::time::Duration::from_secs(40), "cut at its budget, not its time: {:?}", began.elapsed());
    }

    /// A runtime that is there but can't be held is told apart from none, and is said as the probe found it: what the
    /// runtime lacks, or the layer that did not hold, never a version nothing checked. A name that leads nowhere is no
    /// runtime.
    #[test]
    fn a_runtime_that_cannot_be_held_is_not_said_to_be_none() {
        assert_eq!(unheld_for(None), Some(Unheld::NoRuntime));
        assert_eq!(unheld_for(Some("/nonexistent/unbrowse-no-such-runtime")), Some(Unheld::NoRuntime));
        // A program that is there and answers no probe, under any layer, as a runtime that won't start under its own
        // permission model's flags.
        let refused = unheld_for(Some("/usr/bin/false")).expect("a program that answers no probe is not held");
        assert_eq!(refused, Unheld::Lacks("gave no answer when started under its own permission model's flags".into()));
        assert!(!refused.said().contains("no JavaScript runtime") && !refused.said().contains("Node 25"), "{}", refused.said());
        assert!(Unheld::NoRuntime.said().contains("no JavaScript runtime"));
    }

    /// Each refusal the probe makes is read as what it found: the runtime's own lack by the capability missing, any
    /// other layer by the probe's own words, and a probe that held everywhere as no refusal at all.
    #[test]
    fn a_refusal_is_read_as_what_the_probe_found() {
        let read = |p: &Probed| refusal_of(p, &layers_hold(p));
        assert_eq!(read(&held_everywhere()), None);
        for (k, v, missing) in [("perm", serde_json::json!(false), "permission model"), ("realm", serde_json::json!("undefined"), "realm"), ("modules", serde_json::json!("undefined"), "modules")] {
            let mut p = held_everywhere();
            p.all.as_mut().unwrap()[k] = v;
            match read(&p) {
                Some(Unheld::Lacks(what)) => assert!(what.contains(missing) && what.contains("a newer Node has it"), "{what}"),
                other => panic!("{k}: {other:?}"),
            }
        }
        let mut p = held_everywhere();
        p.all = None;
        p.runtime_alone = None;
        assert!(matches!(read(&p), Some(Unheld::Lacks(_))), "no answer under any layer");
        let mut p = held_everywhere();
        p.all = None;
        assert!(matches!(read(&p), Some(Unheld::NotConfined(_))), "it answered under its own layer alone");
        let mut p = held_everywhere();
        p.os_alone = None;
        match read(&p) {
            Some(Unheld::NotConfined(why)) => assert!(why.contains("no operating-system layer"), "{why}"),
            other => panic!("{other:?}"),
        }
        let mut p = held_everywhere();
        p.os_alone.as_mut().unwrap()["exec"] = "allowed".into();
        match read(&p) {
            Some(Unheld::NotConfined(why)) => assert!(why.contains("`exec`") && why.contains("operating system"), "{why}"),
            other => panic!("{other:?}"),
        }
    }

    /// A page's fetch is held to its run's deadline: the node hands the deadline to the fetch with every request, a
    /// request after it is refused before the fetch is asked, and the transport never sends one past it.
    #[test]
    fn a_page_fetch_never_outlives_its_run() {
        if !available() {
            eprintln!("no signing runtime on this machine: the sandbox is skipped");
            return;
        }
        let bundle: Bundle = vec![("https://cdn.shop.example.com/app.js".into(), "fetch('/api/slow').then(function () { fetch('/api/after'); });".into())];
        let mut given: Vec<(String, std::time::Instant)> = Vec::new();
        let mut net = |r: &Request, until: std::time::Instant| -> Result<crate::trace::Exchange, String> {
            given.push((r.url.path().to_string(), until));
            // A slow site: the run's time runs out while it answers.
            std::thread::sleep(until.saturating_duration_since(std::time::Instant::now()) + std::time::Duration::from_millis(200));
            Err("too slow".into())
        };
        let limits = Limits { ready: std::time::Duration::from_secs(20), wall: std::time::Duration::from_secs(2), memory_mb: 1024, said_bytes: RUN_SAID_MAX };
        let began = std::time::Instant::now();
        let _ = run_all_held(Some("node"), 30_000, &bundle, "https://shop.example.com/", "", &Storage::default(), "", &serde_json::Value::Null, &[], Some(&mut net), false, &[], None, limits);
        assert_eq!(given.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), vec!["/api/slow"], "nothing is fetched after the run's time is up");
        assert!(given[0].1 <= began + limits.ready + limits.wall, "the fetch is given the run's deadline");
        assert!(began.elapsed() < std::time::Duration::from_secs(25), "the run ended at its deadline: {:?}", began.elapsed());
        let mut late = crate::http::ChromeFetch::held_to(crate::egress::Egress::Foreign).expect("a transport");
        late.until(Some(std::time::Instant::now()));
        let asked = request("GET", "https://shop.example.com/api/late", None);
        assert!(matches!(crate::replay::Fetch::fetch(&mut late, &asked), Err(crate::replay::ReplayError::Refused(_))), "a request past its deadline is never sent");
    }

    /// A probe report that held everywhere: every denial, under all layers and each alone.
    fn held_everywhere() -> Probed {
        let denied = |keys: &[&str], perm: bool| {
            let mut o = serde_json::json!({ "perm": perm, "realm": "symbol", "modules": "function", "env": 0, "abstract": "n/a" });
            for k in keys {
                o[*k] = "denied".into();
            }
            o
        };
        let every = ["read", "home", "write", "writeHere", "writeHome", "exec", "shell", "worker", "net", "unix"];
        Probed { all: Some(denied(&every, true)), os_alone: Some(denied(&every, false)), runtime_alone: Some(denied(&every, true)), mach: Some(Mach::Denied), heard: false }
    }

    /// Page code runs only where every layer the node relies on was shown to deny by itself: one thing the
    /// operating system's layer let through alone, one the runtime's let through alone, a mach lookup the profile
    /// allowed, a socket that heard the probe, or a layer probed with the other still on, and the runtime is refused.
    #[test]
    fn every_layer_must_be_shown_to_deny_by_itself() {
        assert_eq!(layers_hold(&held_everywhere()), Ok(()));
        for k in ["read", "home", "write", "writeHere", "writeHome", "exec", "shell", "net", "unix", "abstract"] {
            let mut p = held_everywhere();
            p.os_alone.as_mut().unwrap()[k] = "allowed".into();
            assert!(layers_hold(&p).is_err(), "the operating system's layer let `{k}` through alone");
        }
        for k in ["read", "home", "write", "writeHere", "writeHome", "exec", "shell", "worker"] {
            let mut p = held_everywhere();
            p.runtime_alone.as_mut().unwrap()[k] = "allowed".into();
            assert!(layers_hold(&p).is_err(), "the runtime's layer let `{k}` through alone");
        }
        // The runtime's model is not relied on for the network: its probe reaching a socket refuses nothing.
        let mut p = held_everywhere();
        p.runtime_alone.as_mut().unwrap()["net"] = "allowed".into();
        assert_eq!(layers_hold(&p), Ok(()));
        let mut p = held_everywhere();
        p.os_alone.as_mut().unwrap()["perm"] = true.into();
        assert!(layers_hold(&p).is_err(), "an operating-system probe with the runtime's model on proves nothing alone");
        for mach in [Mach::Allowed, Mach::Unknown] {
            let mut p = held_everywhere();
            p.mach = Some(mach);
            assert!(layers_hold(&p).is_err(), "{mach:?}");
        }
        let mut p = held_everywhere();
        p.heard = true;
        assert!(layers_hold(&p).is_err());
        let mut p = held_everywhere();
        p.runtime_alone = None;
        assert!(layers_hold(&p).is_err());
    }

    /// On this machine, each layer denies by itself: the operating system's with the runtime's permission model off,
    /// and the runtime's with the operating system's off.
    #[test]
    fn each_layer_denies_by_itself_on_this_machine() {
        let Some(c) = runtime().and_then(|p| confined(&p)) else {
            eprintln!("no confinable runtime on this machine: skipped");
            return;
        };
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_else(|| "/".into());
        let (os, os_heard) = probe_under(&c, Layers::OsAlone, &home).expect("the probe ran under the operating system's layer");
        assert_eq!(os["perm"], false, "the runtime's model was off");
        for k in ["read", "home", "write", "writeHere", "writeHome", "exec", "shell", "net", "unix"] {
            assert_eq!(os[k], "denied", "the operating system's layer alone let `{k}` through: {os}");
        }
        assert!(!os_heard, "no socket heard the probe under the operating system's layer alone");
        let (rt, _) = probe_under(&c, Layers::RuntimeAlone, &home).expect("the probe ran under the runtime's model");
        for k in ["read", "home", "write", "writeHere", "writeHome", "exec", "shell", "worker"] {
            assert_eq!(rt[k], "denied", "the runtime's model alone let `{k}` through: {rt}");
        }
        assert_ne!(mach_probe(&c), Mach::Allowed, "the profile alone refuses a mach service lookup");
        assert!(!home.join(".unbrowse-sandbox-probe").exists());
    }

    /// A platform with no operating-system layer runs no page code, whatever its runtime's own model says: Windows has
    /// none (and no hard CPU or memory limit), and a macOS without `sandbox-exec` has none either.
    #[test]
    fn a_platform_with_no_os_layer_runs_no_page_code() {
        assert!(!os_layer_on("windows", true));
        assert!(!os_layer_on("freebsd", true));
        assert!(!os_layer_on("macos", false));
        assert!(os_layer_on("macos", true) && os_layer_on("linux", false));
        let mut p = held_everywhere();
        p.os_alone = None;
        let refused = layers_hold(&p).expect_err("no operating-system layer, no page code");
        assert!(refused.contains("no operating-system layer"), "{refused}");
    }

    /// The Linux layer opens nothing of the owner's home but the runtime's own file and the libraries it loads: a
    /// runtime installed under the home (`~/.local/bin/node`) doesn't open the folder it sits in, or any other, to
    /// the page.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_linux_layer_opens_no_folder_of_the_owners_home() {
        use std::os::unix::ffi::OsStrExt;
        let home = std::path::PathBuf::from(std::env::var_os("HOME").expect("HOME"));
        let node = home.join(".local/bin/node");
        let lib = home.join(".local/lib/libnode.so.127");
        let c = Confined { node: node.clone(), libraries: vec![lib.clone()] };
        let dir = RunDir::new_in(std::path::Path::new("/tmp"), "rules").expect("a run folder");
        let rules = os_rules(&c, &dir.path);
        let mut runtime = false;
        for (path, access) in &rules.paths {
            let p = std::path::Path::new(std::ffi::OsStr::from_bytes(path.as_bytes()));
            if p == node || p == lib {
                assert_eq!(access & 8, 0, "{} is a file rule, not a folder", p.display());
                runtime |= p == node && access & 1 == 1;
                continue;
            }
            assert!(!p.starts_with(&home) && !home.starts_with(p), "{} opens the owner's home", p.display());
        }
        assert!(runtime, "the runtime itself may be started");
    }
}

#[cfg(all(test, unix))]
#[path = "sandbox_cov_tests.rs"]
mod sandbox_cov_tests;
