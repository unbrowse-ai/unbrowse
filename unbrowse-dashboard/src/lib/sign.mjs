// HMAC-SHA256 over "<unix seconds>.<body>", shared by the Worker (verify) and the CI collector (sign).
// WebCrypto only, so the same file runs in a Worker and in Node 20+.

const enc = new TextEncoder();
export const MAX_SKEW_S = 600;

async function hmac(key, text) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, enc.encode(text));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sign(key, body, now = Math.floor(Date.now() / 1000)) {
  return { time: String(now), signature: `sha256=${await hmac(key, `${now}.${body}`)}` };
}

// Returns null when the request is good, else the reason it is refused.
export async function verify(key, body, time, signature, now = Math.floor(Date.now() / 1000)) {
  if (!key) return "no key configured";
  if (!time || !signature) return "unsigned";
  const t = Number(time);
  if (!Number.isInteger(t) || Math.abs(now - t) > MAX_SKEW_S) return "stale";
  const want = `sha256=${await hmac(key, `${t}.${body}`)}`;
  if (want.length !== signature.length) return "bad signature";
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0 ? null : "bad signature";
}
