// CI's pictures, for a pull request's report (.github/scripts/pr_report.py): CI puts each screenshot here with the
// key only it holds, and the report's comment shows it from here, since GitHub draws a comment's images by fetching
// them, unsigned. A picture lives at /s/<run>/<name>: <run> is the uploader's own 32 hex characters, so an address
// can't be guessed, and nothing here lists what the bucket holds. The bucket forgets each picture after 14 days
// (its lifecycle rule, README).

const PATH = /^\/s\/([0-9a-f]{32})\/([a-z0-9][a-z0-9._-]{0,95}\.(png|jpe?g|webp))$/;
const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
const MAX_BYTES = 4 * 1024 * 1024;

/** Whether two strings are the same, taking as long either way. */
function same(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The bytes start the way the named type's do: a picture, not something wearing its name. */
function looksLike(kind, bytes) {
  const b = new Uint8Array(bytes.slice(0, 12));
  if (kind === "png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (kind === "jpg" || kind === "jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (kind === "webp") return String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP";
  return false;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = PATH.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    const key = url.pathname.slice(1);
    const kind = m[3];
    if (request.method === "GET" || request.method === "HEAD") {
      const object = await env.SHOTS.get(key);
      if (!object) return new Response("not found", { status: 404 });
      const headers = {
        "content-type": TYPES[kind],
        "cache-control": "public, max-age=1209600, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
      };
      return new Response(request.method === "HEAD" ? null : object.body, { headers });
    }
    if (request.method !== "PUT") return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD, PUT" } });
    const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!env.SHOTS_KEY || !same(given, env.SHOTS_KEY)) return new Response("unauthorized", { status: 401 });
    const declared = Number(request.headers.get("content-length") || "0");
    if (declared > MAX_BYTES) return new Response("too large", { status: 413 });
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return new Response("too large or empty", { status: 413 });
    if (!looksLike(kind, bytes)) return new Response(`not a ${kind}`, { status: 415 });
    await env.SHOTS.put(key, bytes, { httpMetadata: { contentType: TYPES[kind] } });
    return new Response(JSON.stringify({ url: `${url.origin}/${key}` }), { status: 201, headers: { "content-type": "application/json" } });
  },
};
