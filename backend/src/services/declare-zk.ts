/**
 * Zero-knowledge credential-binding NIZK — TS port of the proven reference
 * `paper/reference/zk/binding.py`. This is PRODUCTION CRYPTO: it must be
 * byte-identical to the Python reference (cross-verified by a known-answer
 * gate, `backend/tests/declare-zk-kat.test.ts`), not a hand-rolled scheme.
 *
 * Construction (a textbook, sound NIZK):
 *
 *   - Derive a secret scalar  x = H("cred:"||credential) mod q  from the
 *     credential bytes.
 *   - Public binding point     y = g^x mod p   over the 2048-bit RFC-3526
 *     MODP group (discrete log hard, so y reveals nothing of x / the credential).
 *   - The WALLET signs y (ed25519), binding "this y belongs to this wallet".
 *     The credential never appears — only y, which is one-way.
 *   - A non-interactive Schnorr proof of knowledge of x (Fiat-Shamir):
 *         k random;  t = g^k;  e = H(g, y, t, ctx);  s = k + e*x  (mod q)
 *     Verifier checks  g^s == t * y^e (mod p)  AND the wallet's signature over y.
 *
 * The wallet ed25519 path is the SAME Web Crypto path declare-signature.ts uses.
 *
 * EXACT-MATCH details (must mirror binding.py byte-for-byte):
 *   - P (RFC-3526 group 14, 2048-bit MODP), G=2, Q=(P-1)/2.
 *   - _int(b) = BigInt(big-endian) of sha256(b).
 *   - credential_scalar = _int("cred:"||credential) mod Q.
 *   - y = modpow(G, x, P) — JS `**` is NOT modular; square-and-multiply is used.
 *   - FS challenge e = _int(asciiBytes("<G>|<y>|<t>|") + ctx) mod Q, where G, y, t
 *     are formatted as DECIMAL strings joined by "|" with a trailing "|", then ctx
 *     bytes appended, then sha256. (Decimal, not hex — matches Python `b"%d|%d|%d|"`.)
 *   - prove: k=rand(1..Q-1); t=g^k; e=...; s=(k+e*x) mod Q → {t:hex, s:hex, ctx:hex}.
 *   - verify: ed25519 verify(root, sig, utf8(y_hex)) AND g^s == (t * y^e) mod p.
 */

// RFC 3526 group 14 (2048-bit MODP). p safe prime, q = (p-1)/2, generator g=2.
// Hex copied verbatim from binding.py.
const P = BigInt(
  "0x" +
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74" +
    "020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437" +
    "4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
    "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05" +
    "98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB" +
    "9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
    "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718" +
    "3995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF",
);
const G = 2n;
const Q = (P - 1n) / 2n;

const enc = new TextEncoder();

/** Public binding produced by `bind` — y signed by the wallet over utf8(y_hex). */
export interface ZkBinding {
  /** g^x mod p as a Python-style hex string ("0x"-prefixed, lowercase). */
  y: string;
  /** Wallet ed25519 pubkey (hex) that signed y. */
  root: string;
  /** ed25519 signature (hex) over utf8(y). */
  sig: string;
}

/** NIZK proof of knowledge of the credential behind a binding (Schnorr/FS). */
export interface ZkProof {
  /** g^k mod p, hex. */
  t: string;
  /** (k + e*x) mod q, hex. */
  s: string;
  /** Fiat-Shamir context bytes, hex. */
  ctx: string;
}

function bytesToHexBigInt(bytes: Uint8Array): bigint {
  // big-endian
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  return acc;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** sha256(bytes) — async via Web Crypto (CF Workers + bun). */
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

/** _int(b) — BigInt big-endian of sha256(b). Mirrors Python `_int`. */
async function intHash(bytes: Uint8Array): Promise<bigint> {
  return bytesToHexBigInt(await sha256(bytes));
}

/** Python-style hex of a non-negative BigInt: "0x" + lowercase, no leading zeros
 *  (matches `hex(n)`; hex(0) == "0x0"). */
function pyHex(n: bigint): string {
  return "0x" + n.toString(16);
}

/** Modular exponentiation (square-and-multiply). JS `**` is NOT modular. */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  if (b < 0n) b += mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

/** x = _int("cred:"||credential) mod Q. Mirrors Python `credential_scalar`. */
export async function credentialScalar(credential: Uint8Array): Promise<bigint> {
  const prefixed = new Uint8Array(5 + credential.length);
  prefixed.set(enc.encode("cred:"), 0);
  prefixed.set(credential, 5);
  return (await intHash(prefixed)) % Q;
}

/**
 * Public binding: y = g^x, signed by the wallet ed25519 key over utf8(y_hex).
 * Reveals nothing of x. `signY` signs the bytes of the y hex string and returns
 * the signature hex (the caller supplies the wallet — same Web Crypto path the
 * declare-signature gate uses).
 */
export async function bind(
  credential: Uint8Array,
  wallet: { rootHex: string; signY: (yBytes: Uint8Array) => Promise<string> },
): Promise<ZkBinding> {
  const x = await credentialScalar(credential);
  const y = modPow(G, x, P);
  const yHex = pyHex(y);
  const sig = await wallet.signY(enc.encode(yHex));
  return { y: yHex, root: wallet.rootHex, sig };
}

/**
 * The FS challenge e = _int("<G>|<y>|<t>|"||ctx) mod Q, with G, y, t as DECIMAL
 * ASCII strings (matches Python `b"%d|%d|%d|" % (G, y, t) + ctx`).
 */
async function fsChallenge(y: bigint, t: bigint, ctx: Uint8Array): Promise<bigint> {
  const prefix = enc.encode(`${G.toString()}|${y.toString()}|${t.toString()}|`);
  const msg = new Uint8Array(prefix.length + ctx.length);
  msg.set(prefix, 0);
  msg.set(ctx, prefix.length);
  return (await intHash(msg)) % Q;
}

/**
 * NIZK proof of knowledge of the credential behind `binding` (Schnorr/FS).
 * `k` is sampled in [1, Q-1] (mirrors Python `secrets.randbelow(Q-1)+1`).
 * Optional `kOverride` lets the KAT inject a deterministic k for cross-checks.
 */
export async function prove(
  credential: Uint8Array,
  binding: ZkBinding,
  ctx: Uint8Array = new Uint8Array(0),
  kOverride?: bigint,
): Promise<ZkProof> {
  const x = await credentialScalar(credential);
  const y = BigInt(binding.y);
  if (modPow(G, x, P) !== y) throw new Error("credential does not open this binding");
  const k = kOverride ?? randBelow(Q - 1n) + 1n;
  const t = modPow(G, k, P);
  const e = await fsChallenge(y, t, ctx);
  const s = (k + e * x) % Q;
  return { t: pyHex(t), s: pyHex(s), ctx: bytesToHex(ctx) };
}

/** Cryptographically uniform random in [0, bound). Mirrors Python `secrets.randbelow`. */
function randBelow(bound: bigint): bigint {
  if (bound <= 0n) throw new Error("bound must be positive");
  // rejection sampling over whole bytes
  const bits = bound.toString(2).length;
  const bytes = Math.ceil(bits / 8);
  const buf = new Uint8Array(bytes);
  // mask the top byte to the needed bit-width to keep rejection rate low
  const topBits = bits % 8 === 0 ? 8 : bits % 8;
  const topMask = (1 << topBits) - 1;
  for (;;) {
    crypto.getRandomValues(buf);
    buf[0] &= topMask;
    let n = 0n;
    for (const b of buf) n = (n << 8n) | BigInt(b);
    if (n < bound) return n;
  }
}

/**
 * True iff the proof shows knowledge of the bound credential AND the wallet
 * signed the binding — without the credential ever being transmitted. The
 * ed25519 verify uses the SAME Web Crypto path as declare-signature.ts.
 */
export async function verifyBinding(binding: ZkBinding, proof: ZkProof): Promise<boolean> {
  try {
    const y = BigInt(binding.y);
    const t = BigInt(proof.t);
    const s = BigInt(proof.s);
    const ctx = hexToBytes(proof.ctx);
    // 1. the wallet really bound this y (ed25519 verify over utf8(y_hex))
    if (!(await verifyWalletSig(binding.root, binding.sig, enc.encode(binding.y)))) {
      return false;
    }
    // 2. Schnorr: g^s == t * y^e (mod p)
    const e = await fsChallenge(y, t, ctx);
    return modPow(G, s, P) === (t * modPow(y, e, P)) % P;
  } catch {
    return false;
  }
}

/** ed25519 verify — same Web Crypto path declare-signature.ts uses. */
async function verifyWalletSig(
  pubHex: string,
  sigHex: string,
  msg: Uint8Array,
): Promise<boolean> {
  try {
    const pubBytes = hexToBytes(pubHex);
    if (pubBytes.length !== 32) return false;
    const sigBytes = hexToBytes(sigHex);
    if (sigBytes.length !== 64) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      pubBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, msg);
  } catch {
    return false;
  }
}
