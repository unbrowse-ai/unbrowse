// Agent bug reports: what a node may send to POST /v1/reports, how its text is scrubbed (again: the node scrubbed it
// first), and how it becomes a GitHub issue. The lists are ../schema.json's `reports`; the node's side is
// unbrowse-node/app/src/report.rs, and both sides' tests read the scrub and fingerprint examples kept there, so the
// two can't drift.

export const FIELDS = ["kind", "summary", "expected", "got", "goal", "url", "tool", "error", "route", "last_error", "version", "os", "source", "install_id"];
export const REQUIRED = ["kind", "summary", "version", "os", "source", "install_id"];
export const KINDS = ["wrong_data", "false_success", "failed", "slow", "confusing", "other"];
export const SOURCES = ["agent", "node"];
export const TOOLS = ["unbrowse_search", "unbrowse_do", "unbrowse_browse", "unbrowse_logins", "unbrowse_call", "unbrowse_whoami"];
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "WS"];
export const ROUTE_FIELDS = ["method", "host", "path", "inputs", "write", "steps"];
export const LAST_ERROR_FIELDS = ["tool", "class", "error"];
export const MAX_CHARS = { summary: 140, expected: 600, got: 1500, goal: 200, url: 300, error: 600, host: 253, path: 300, input: 64, last_error: 300 };
export const MAX_INPUTS = 30;
export const MAX_STEPS = 100;
export const MAX_BODY_BYTES = 16_384;
/** What one signer (one node's report key) may file a day, and how many new issues of those. */
export const PER_SIGNER_PER_DAY = 20;
export const NEW_ISSUES_PER_SIGNER_PER_DAY = 5;
/** The old name of `PER_SIGNER_PER_DAY`, from when the limit was keyed on the sender's install id. */
export const PER_INSTALL_PER_DAY = PER_SIGNER_PER_DAY;
export const NEW_ISSUES_PER_DAY = 30;
/** While REPORTS_ACCEPT_UNSIGNED=1 lets reports in that no node signed, all of them together, a day: far below one
 * signer's limits, since none of them names who sent it. */
export const UNSIGNED_PER_DAY = 5;
export const UNSIGNED_NEW_ISSUES_PER_DAY = 1;
export const COMMENTS_PER_DAY = 100;

const OSES = ["macos", "linux", "windows", "other"];
const ERROR_CLASSES = ["bad_request", "unauthorized", "payment_required", "forbidden", "not_found", "conflict", "unavailable", "internal", "site", "other"];

// ---- scrubbing: the same rules as the node's `report::scrub`, step for step ----
//
// 1. Characters that hide or reorder text (zero-width, bidi controls, BOM) go.
// 2. What is encoded is decoded, so it is judged as it reads: `\/`, `\uXXXX`, `&#NN;`, and percent-encoding.
// 3. A run of 9 digits or more is a number (a card, a phone, an id), even split by spaces, `-`, `.` or brackets.
// 4. Each word (text between spaces, quotes, brackets and `,;|`) loses its query or fragment, then is judged: a vault
//    reference, an address, a URL (scheme, host and path), a host, or pieces split at `/ : & = ?`, each classified,
//    and the value after a key whose name says it's secret (`password=`, `"api_key": "…"`) masked.

const SEPARATORS = new Set([..."\"'<>()[]{},;`|"]);
const PIECE_DELIMS = new Set([..."/:&=?|"]);
const TOKEN_CHARS = /^[A-Za-z0-9_\-+.~%]+$/;
// Rust's `char::is_whitespace`: JavaScript's \s and U+0085 (U+FEFF, which \s holds, is gone before this is asked).
const isSpace = (c) => /\s/u.test(c) || c === "\u0085";
const isDigit = (c) => c >= "0" && c <= "9";
const isAlnum = (c) => /^[A-Za-z0-9]$/.test(c);
const isHex = (c) => /^[0-9A-Fa-f]$/.test(c);

/** Zero-width characters, bidi controls and the byte-order mark: they hide or reorder text. */
export function isInvisible(cp) {
  return (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff;
}

function validChar(cp) {
  return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
}

/** One pass of decoding: `\/`, `\uXXXX`, `&#NN;` / `&#xHH;`, then runs of `%XX` that make UTF-8. */
function decodeOnce(t) {
  t = t.replace(/\\\//g, "/");
  t = t.replace(/\\u([0-9A-Fa-f]{4})/g, (m, h) => {
    const cp = parseInt(h, 16);
    return validChar(cp) ? String.fromCodePoint(cp) : m;
  });
  t = t.replace(/&#(?:([0-9]{1,7})|[xX]([0-9A-Fa-f]{1,6}));/g, (m, d, h) => {
    const cp = d !== undefined ? parseInt(d, 10) : parseInt(h, 16);
    return validChar(cp) ? String.fromCodePoint(cp) : m;
  });
  t = t.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    const bytes = new Uint8Array(m.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(m.slice(i * 3 + 1, i * 3 + 3), 16);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return m;
    }
  });
  return t;
}

/** Text with nothing hidden and nothing encoded: invisible characters out, then decoded until it stops changing
 *  (at most three times). */
export function prepare(text) {
  let t = Array.from(String(text)).filter((c) => !isInvisible(c.codePointAt(0))).join("");
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(t);
    if (next === t) break;
    t = next;
  }
  return Array.from(t).filter((c) => !isInvisible(c.codePointAt(0))).join("");
}

function count(counts, k) {
  counts[k] = (counts[k] || 0) + 1;
}

export function isIpv4(s) {
  const bare = s.replace(/:[0-9]+$/, "");
  const parts = bare.split(".");
  return parts.length === 4 && parts.every((p) => /^[0-9]{1,3}$/.test(p));
}

/** An IPv6 address: groups of 1 to 4 hex digits split by `:`, eight of them, or fewer with one `::`. */
export function isIpv6(s) {
  const halves = s.split("::");
  if (halves.length > 2) return false;
  const groups = (h) => (h === "" ? [] : h.split(":"));
  const all = halves.flatMap(groups);
  if (!all.every((g) => g.length >= 1 && g.length <= 4 && Array.from(g).every(isHex))) return false;
  return halves.length === 2 ? all.length < 8 : all.length === 8;
}

const SEP_IN_NUMBER = new Set([..." -()."]);

/** Step 3: every run of 9 digits or more (a card, phone or national id, written with spaces, dashes, dots or
 *  brackets between its groups) as `[number]`. A run that starts or ends inside a word, or right after a `/`, is the
 *  word's, and an IPv4 address is judged as one. */
export function maskDigitRuns(text, counts = {}) {
  const c = Array.from(text);
  let out = "";
  let i = 0;
  while (i < c.length) {
    const prev = i > 0 ? c[i - 1] : "";
    const prev2 = i > 1 ? c[i - 2] : "";
    const starts = isDigit(c[i]) && !(isAlnum(prev) || prev === "_" || prev === "/") && !(SEP_IN_NUMBER.has(prev) && prev !== " " && (isAlnum(prev2) || prev2 === "_"));
    if (!starts) {
      out += c[i];
      i += 1;
      continue;
    }
    let k = i;
    let digits = 0;
    let end = i;
    for (;;) {
      while (k < c.length && isDigit(c[k])) {
        k += 1;
        digits += 1;
      }
      end = k;
      let s = k;
      while (s < c.length && s - k < 3 && SEP_IN_NUMBER.has(c[s])) s += 1;
      if (s > k && s < c.length && isDigit(c[s])) {
        k = s;
        continue;
      }
      break;
    }
    const run = c.slice(i, end).join("");
    const next = end < c.length ? c[end] : "";
    if (digits >= 9 && !isAlnum(next) && next !== "_" && !isIpv4(run)) {
      out += "[number]";
      count(counts, "number");
    } else {
      out += run;
    }
    i = end;
  }
  return out;
}

/**
 * What a piece of text is, when it is something a report must not carry: `vault` (a vault reference), `email`, `ip`,
 * `number` (9 digits or more in text, 4 or more in a path), `hex` (16 hex digits or more, or 0x and 8), `token` (24
 * characters or more mixing letters and digits, or 12 or more mixing upper and lower case and digits). Null otherwise.
 */
export function classify(s, inPath = false) {
  if (!s) return null;
  if (s.toLowerCase().includes("vault:")) return "vault";
  const at = s.lastIndexOf("@");
  if (at >= 0 && /\.[A-Za-z]{2,}/.test(s.slice(at + 1))) return "email";
  if (isIpv4(s)) return "ip";
  if (/^[0-9]+$/.test(s) && s.length >= (inPath ? 4 : 9)) return "number";
  const prefixed = /^0[xX]/.test(s);
  const h = prefixed ? s.slice(2) : s;
  if (h.length >= (prefixed ? 8 : 16) && /^[0-9A-Fa-f]+$/.test(h) && /[0-9]/.test(h)) return "hex";
  if (TOKEN_CHARS.test(s)) {
    const letter = /[A-Za-z]/.test(s);
    const digit = /[0-9]/.test(s);
    if (s.length >= 24 && letter && digit) return "token";
    if (s.length >= 12 && /[A-Z]/.test(s) && /[a-z]/.test(s) && digit) return "token";
  }
  return null;
}

// A key names a secret (or a person) when a word of its name says so: part of it (`access_token`, `x-api-key`,
// `jsessionid`), or the whole of one of its words (`code`, `pin`, `sig`). Stated as a rule of names, never of sites.
const SECRET_IN_NAME = ["token", "secret", "passw", "session", "sessid", "apikey", "auth", "cookie", "signature", "credential", "csrf", "xsrf", "bearer", "private"];
const SECRET_NAME_WORDS = ["key", "code", "pwd", "pass", "sig", "sid", "otp", "jwt", "pin", "ssn", "email", "phone", "nonce", "ticket"];

/** Whether a key's name says its value is a secret or a person's. */
export function isSecretKey(name) {
  const k = name.replace(/^-+/, "");
  if (!k || k.length > 40 || !/^[A-Za-z0-9_.-]+$/.test(k)) return false;
  const lower = k.toLowerCase();
  if (SECRET_IN_NAME.some((w) => lower.includes(w))) return true;
  const words = k.split(/[-_.]/).flatMap((p) => p.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ")).map((w) => w.toLowerCase());
  return words.some((w) => SECRET_NAME_WORDS.includes(w));
}

/** A value no key makes secret: a number of three digits or fewer (a status, a count), true, false or null. */
function isPlainValue(v) {
  return /^[0-9]{1,3}$/.test(v) || ["true", "false", "null"].includes(v.toLowerCase());
}

/** A host as a report keeps it, read from the name alone: an address is `[ip]`; a single name, or a host on a port
 *  other than the web's (80, 443), is a machine's, `[internal]`; and the labels left of the site's own name (the
 *  last two, or three under a short second level such as co.uk) are `*`, since a company's or a person's name is
 *  what goes there. Masks are kept. */
export function maskHost(host, counts = {}, withPort = true) {
  let h = host.toLowerCase().replace(/\.$/, "");
  if (!h) return h;
  if (/^\[[a-z]+\]$/.test(h)) return h;
  if (h.startsWith("[")) {
    count(counts, "ip");
    return "[ip]";
  }
  let port = "";
  const m = withPort ? /^(.*):([0-9]+)$/.exec(h) : null;
  if (m) {
    h = m[1];
    port = m[2];
  }
  if (isIpv4(h) || isIpv6(h)) {
    count(counts, "ip");
    return "[ip]";
  }
  const labels = h.split(".");
  if (labels.length === 1 || labels.some((l) => !l) || (port && port !== "80" && port !== "443")) {
    count(counts, "internal");
    return "[internal]";
  }
  const keep = labels.length >= 3 && labels[labels.length - 2].length <= 3 ? 3 : 2;
  if (labels.length > keep) {
    if (labels[0] !== "*" || labels.length > keep + 1) count(counts, "subdomain");
    return `*.${labels.slice(-keep).join(".")}`;
  }
  return h;
}

/** A word's query and fragment: cut from the first `?` or `#` that follows something path- or host-like, or that
 *  starts something holding `=`. */
export function dropQuery(core, counts = {}) {
  const c = Array.from(core);
  for (let i = 0; i < c.length; i++) {
    if (c[i] !== "?" && c[i] !== "#") continue;
    const before = c.slice(0, i).join("");
    const after = c.slice(i + 1).join("");
    if (before && after && (before.includes("/") || before.includes(".") || after.includes("="))) {
      count(counts, "query");
      return before;
    }
  }
  return core;
}

/** Pieces of a word, split at `/ : & = ? |`, each classified, the value after a secret key masked. Returns the text
 *  and what the word ends on: `key` (a secret key's name), `value` (a secret key and its `=` or `:`), or null. */
function scrubPieces(core, counts, inPath) {
  const pieces = [""];
  const delims = [];
  for (const ch of core) {
    if (PIECE_DELIMS.has(ch)) {
      delims.push(ch);
      pieces.push("");
    } else pieces[pieces.length - 1] += ch;
  }
  const mask = (k) => (inPath ? `{${k}}` : `[${k}]`);
  let out = "";
  let ends = null;
  let k = 0;
  while (k < pieces.length) {
    const p = pieces[k];
    const kind = classify(p, inPath);
    if (kind) count(counts, kind);
    out += kind ? mask(kind) : p;
    if (k === pieces.length - 1) {
      if (!kind && isSecretKey(p)) ends = "key";
      break;
    }
    const d = delims[k];
    out += d;
    if (!kind && isSecretKey(p) && (d === "=" || d === ":")) {
      let m = k + 1;
      let value = pieces[m];
      while (m < delims.length && delims[m] !== "&") {
        value += delims[m] + pieces[m + 1];
        m += 1;
      }
      if (!value && m === pieces.length - 1) {
        ends = "value";
        break;
      }
      if (value && !isPlainValue(value)) {
        count(counts, "secret");
        out += mask("secret");
        if (m >= delims.length) break;
        out += delims[m];
        k = m + 1;
        continue;
      }
    }
    k += 1;
  }
  return [out, ends];
}

/** A URL as a report keeps it: scheme, host and path, with ids in the path masked; never a query, fragment or login. */
export function reduceUrl(u, counts = {}) {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(.*)$/s.exec(u);
  if (!m) {
    count(counts, "url");
    return "[url]";
  }
  let auth = m[2];
  const at = auth.lastIndexOf("@");
  if (at >= 0) {
    auth = auth.slice(at + 1);
    count(counts, "login");
  }
  const host = maskHost(auth, counts);
  const [path] = scrubPieces(m[3], counts, true);
  if (m[4]) count(counts, "query");
  return `${m[1].toLowerCase()}://${host}${path}`;
}

const URL_START = /(?:https?|wss?):\/\//i;
const HOST_LIKE = /^(\*|[A-Za-z0-9-]+)(\.[A-Za-z0-9-]+)+$/;

/** One word, judged. Returns its text and what it ends on (see `scrubPieces`). */
function scrubWord(w, counts) {
  if (!w) return [w, null];
  const [, rawCore, tail] = /^(.*?)([.,:!?]*)$/s.exec(w);
  const core = dropQuery(rawCore, counts);
  if (!core) return [tail, null];
  if (core.toLowerCase().includes("vault:")) {
    count(counts, "vault");
    return ["[vault]" + tail, null];
  }
  if (isIpv4(core) || isIpv6(core)) {
    count(counts, "ip");
    return ["[ip]" + tail, null];
  }
  const at = core.search(URL_START);
  if (at >= 0) {
    const [before] = at > 0 ? scrubWord(core.slice(0, at), counts) : [""];
    return [before + reduceUrl(core.slice(at), counts) + tail, null];
  }
  const whole = classify(core);
  if (whole) {
    count(counts, whole);
    return [`[${whole}]` + tail, null];
  }
  const slash = core.indexOf("/");
  const head = slash >= 0 ? core.slice(0, slash) : core;
  let lead = "";
  let rest = core;
  if (HOST_LIKE.test(head) && head.split(".").length >= 3 && /^[A-Za-z]{2,}$/.test(head.slice(head.lastIndexOf(".") + 1))) {
    lead = maskHost(head, counts, false);
    rest = core.slice(head.length);
  }
  const [out, ends] = scrubPieces(rest, counts, false);
  const state = ends === "key" ? (tail.startsWith(":") ? "value" : tail ? null : "key") : ends;
  return [lead + out + tail, state];
}

/** Whether a separator keeps a key's value coming: spaces, tabs and quotes only. */
function carries(sep) {
  return Array.from(sep).every((ch) => ch === " " || ch === "\t" || ch === '"' || ch === "'" || ch === "`");
}

/** Text as a report keeps it: steps 1 to 4 above. */
export function scrub(text, counts = {}) {
  const t = maskDigitRuns(prepare(text), counts);
  const parts = [];
  let word = "";
  let sep = "";
  for (const ch of t) {
    if (isSpace(ch) || SEPARATORS.has(ch)) {
      if (word) {
        parts.push([word, false]);
        word = "";
      }
      sep += ch;
    } else {
      if (sep) {
        parts.push([sep, true]);
        sep = "";
      }
      word += ch;
    }
  }
  if (word) parts.push([word, false]);
  if (sep) parts.push([sep, true]);
  let out = "";
  let state = null;
  for (const [p, isSep] of parts) {
    if (isSep) {
      if (!carries(p)) state = null;
      out += p;
      continue;
    }
    if (state === "value") {
      const [, core, tail] = /^(.*?)([.,:!?]*)$/s.exec(p);
      state = null;
      if (core && !isPlainValue(core)) {
        count(counts, "secret");
        out += "[secret]" + tail;
        continue;
      }
    }
    if (state === "key" && (p[0] === ":" || p[0] === "=")) {
      state = null;
      const rest = p.slice(1);
      if (!rest) {
        out += p;
        state = "value";
        continue;
      }
      if (!isPlainValue(rest)) {
        count(counts, "secret");
        out += p[0] + "[secret]";
        continue;
      }
    }
    const [s, ends] = scrubWord(p, counts);
    out += s;
    state = ends;
  }
  return out;
}

const DICTIONARY_SEGMENT = /^[a-z]+(?:[-_.][a-z]+)*$/;

/** A path as a report keeps a route's or a page's: each segment kept only when it is a template (`{name}`), a mask,
 *  a version (`v2`) or plain lowercase words of 32 characters or fewer; else `{number}` or `{id}`. A handle, a
 *  name with digits, an id or a file named for someone never reads through. */
export function templatePath(path, counts = {}) {
  return path
    .split("/")
    .map((seg) => {
      if (!seg || /^\{[A-Za-z0-9_.\-[\]]+\}$/.test(seg) || /^\[[a-z]+\]$/.test(seg) || /^v[0-9]{1,3}$/.test(seg)) return seg;
      if (seg.length <= 32 && DICTIONARY_SEGMENT.test(seg)) return seg;
      count(counts, "path");
      return /^[0-9]+$/.test(seg) ? "{number}" : "{id}";
    })
    .join("/");
}

/** At most `max` characters, cut with an ellipsis. */
export function cap(s, max) {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max - 1).join("") + "…";
}

/** No control characters but newlines and tabs, and nothing invisible; one line when `oneLine`. */
function clean(s, oneLine) {
  let t = Array.from(s).filter((c) => !isInvisible(c.codePointAt(0))).join("").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  if (oneLine) t = t.replace(/[\n\t]+/g, " ");
  return t.trim();
}

// ---- the fingerprint: which reports are the same problem ----

/** The host of a report's page, or "". */
function pageHost(url) {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(url || "");
  return m ? m[1] : "";
}

/** Reports are one problem, one issue, when they share what the node, not the writer, says about them: the kind, the
 *  tool, the route's shape, the page's host, and the class and error of the last failed call; and, for the node's
 *  own report, its error, which the node makes from the error's variant and status alone. Never the free text an
 *  agent wrote: it differs for one problem, and anyone can vary it. 16 hex digits of a SHA-256. */
export async function fingerprint(r) {
  const route = r.route || {};
  const last = r.last_error || {};
  const text = [
    r.kind,
    r.tool || "",
    route.method || "",
    route.host || "",
    route.path || "",
    pageHost(r.url),
    last.class || "",
    last.error || "",
    r.source === "node" ? r.error || "" : "",
  ].join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export async function sha256hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- the check ----

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const TEXTS = ["summary", "expected", "got", "goal", "error"];

/** Checks a report's shape: only the allowed fields, each of its type, from its list and within its length. Returns
 *  the reason it is refused, or null. Text is scrubbed afterwards, not refused for what it holds. */
export function check(r) {
  if (!isObject(r)) return "a report is an object";
  for (const k of Object.keys(r)) if (!FIELDS.includes(k)) return `field not allowed: ${k}`;
  for (const k of REQUIRED) if (!(k in r)) return `missing field: ${k}`;
  if (!KINDS.includes(r.kind)) return `kind is one of ${KINDS.join(", ")}`;
  if (!SOURCES.includes(r.source)) return "source is agent or node";
  if (!OSES.includes(r.os)) return "os is not an allowed value";
  if (typeof r.version !== "string" || r.version.length > 32 || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(r.version)) return "version is X.Y.Z";
  if (typeof r.install_id !== "string" || !/^[0-9a-f]{32}$/.test(r.install_id)) return "install_id is 32 hex characters";
  for (const k of TEXTS) {
    if (!(k in r)) continue;
    if (typeof r[k] !== "string") return `${k} is a string`;
    if (Array.from(r[k]).length > MAX_CHARS[k]) return `${k} is at most ${MAX_CHARS[k]} characters`;
  }
  if (!r.summary.trim()) return "summary says what went wrong";
  if ("tool" in r && !TOOLS.includes(r.tool)) return "tool is not an allowed value";
  if ("url" in r) {
    if (typeof r.url !== "string" || r.url.length > MAX_CHARS.url) return `url is a string of at most ${MAX_CHARS.url} characters`;
    if (!/^(https?|wss?):\/\/[A-Za-z0-9.\-[\]:*]+(\/[^?#\s@]*)?$/.test(r.url)) return "url is a scheme, host and path only";
  }
  if ("route" in r) {
    const t = r.route;
    if (!isObject(t)) return "route is an object";
    for (const k of Object.keys(t)) if (!ROUTE_FIELDS.includes(k)) return `route field not allowed: ${k}`;
    if (!METHODS.includes(t.method)) return "route.method is not an allowed value";
    if (typeof t.host !== "string" || t.host.length > MAX_CHARS.host || !/^[A-Za-z0-9.\-[\]:*]+$/.test(t.host)) return "route.host is a host";
    if (typeof t.path !== "string" || t.path.length > MAX_CHARS.path || !/^\/[A-Za-z0-9\-._~!$&'()*+,;=:%/{}[\]]*$/.test(t.path)) return "route.path is a path";
    if (!Array.isArray(t.inputs) || t.inputs.length > MAX_INPUTS) return `route.inputs is a list of at most ${MAX_INPUTS} names`;
    for (const i of t.inputs) {
      if (typeof i !== "string" || i.length > MAX_CHARS.input || !/^[A-Za-z0-9_.\-[\]]+$/.test(i)) return "route.inputs holds names";
    }
    if (typeof t.write !== "boolean") return "route.write is true or false";
    if (!Number.isSafeInteger(t.steps) || t.steps < 0 || t.steps > MAX_STEPS) return `route.steps is a whole number up to ${MAX_STEPS}`;
  }
  if ("last_error" in r) {
    const e = r.last_error;
    if (!isObject(e)) return "last_error is an object";
    for (const k of Object.keys(e)) if (!LAST_ERROR_FIELDS.includes(k)) return `last_error field not allowed: ${k}`;
    if (!TOOLS.includes(e.tool)) return "last_error.tool is not an allowed value";
    if (!ERROR_CLASSES.includes(e.class)) return "last_error.class is not an allowed value";
    if ("error" in e && (typeof e.error !== "string" || Array.from(e.error).length > MAX_CHARS.last_error)) return `last_error.error is at most ${MAX_CHARS.last_error} characters`;
  }
  return null;
}

/** The report as it goes public: its text scrubbed again and capped, and the install id left out. */
export function publicReport(r) {
  const counts = {};
  const out = { kind: r.kind, source: r.source, version: r.version, os: r.os };
  for (const k of TEXTS) {
    if (typeof r[k] === "string" && r[k].trim()) out[k] = cap(clean(scrub(r[k], counts), k === "summary" || k === "goal"), MAX_CHARS[k]);
  }
  if (r.tool) out.tool = r.tool;
  if (r.url) {
    const page = /^([a-z]+):\/\/([^/]*)(.*)$/is.exec(r.url);
    out.url = `${page[1].toLowerCase()}://${maskHost(page[2], counts)}${templatePath(page[3], counts)}`;
  }
  if (r.route) out.route = { ...r.route, host: maskHost(r.route.host, counts), path: templatePath(r.route.path, counts) };
  if (r.last_error) {
    out.last_error = { tool: r.last_error.tool, class: r.last_error.class };
    if (r.last_error.error) out.last_error.error = cap(clean(scrub(r.last_error.error, counts), false), MAX_CHARS.last_error);
  }
  return out;
}

// ---- the issue ----

/** Text in a fenced block whose fence no run of backticks inside can close: nothing in it renders, links or mentions. */
function fenced(text) {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** A title from the summary: no mention, no markdown that renders. */
export function title(r) {
  return cap(`${r.kind}: ${r.summary}`.replace(/@/g, "@\u200b").replace(/[`*[\]<>]/g, ""), 160);
}

// What a report says of its source, and nothing more: anyone can send a report that says it is the node's.
const SOURCE_SAYS = { agent: "an agent using the node", node: "the node itself (as the report says: the relay can't verify it)" };

/** The issue's body: a fixed template, every value the report carries in a block that renders as plain text. */
export function issueBody(r, fp, previous = null, mark = null) {
  const lines = [
    `Reported by ${SOURCE_SAYS[r.source]}${r.tool ? `, after \`${r.tool}\`` : ""}. Node ${r.version} on ${r.os}. Kind: \`${r.kind}\`.`,
    "Anyone running a node can file a report, so the words below are the first report's own, unverified; later reports of the same problem only add to the count.",
    ...(Number.isSafeInteger(previous) ? ["", `Seen again after #${previous} was closed.`] : []),
    "",
    "### Summary",
    fenced(r.summary),
  ];
  for (const [k, head] of [["expected", "Expected"], ["got", "Got"], ["goal", "Goal"], ["error", "Error"]]) {
    if (r[k]) lines.push("", `### ${head}`, fenced(r[k]));
  }
  if (r.url) lines.push("", "### Page", fenced(r.url));
  if (r.route) {
    const t = r.route;
    lines.push(
      "",
      "### Route",
      fenced(`${t.method} ${t.host}${t.path}\ninputs: ${t.inputs.length ? t.inputs.join(", ") : "none"}\nwrite: ${t.write}\nsteps: ${t.steps}`),
    );
  }
  if (r.last_error) {
    lines.push("", "### The agent's last failed call", fenced(`${r.last_error.tool}: ${r.last_error.class}${r.last_error.error ? `\n${r.last_error.error}` : ""}`));
  }
  lines.push(
    "",
    "---",
    `Filed by the Unbrowse report relay. Scrubbed on the node and again by the relay: no query strings, input values, cookies, headers, bodies, emails or tokens. Reports of the same problem are counted here instead of opening new issues. Fingerprint \`${fp}\`.`,
  );
  if (mark) lines.push(`Relay mark \`${mark}\`.`);
  return lines.join("\n");
}

/** The comment a known problem gets, at most once a day: a count and the node's version, and no text a report
 *  carries, so a comment can't be made to say anything. */
export function seenAgainBody(r, reports) {
  return `Seen again: ${reports} reports so far. The latest from ${r.source === "node" ? "a node" : "an agent"}, node ${r.version} on ${r.os}.`;
}
