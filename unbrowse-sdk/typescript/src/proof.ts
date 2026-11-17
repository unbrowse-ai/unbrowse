// Before a token goes to whatever answers at the node's address, that listener proves it is the node the token is for.
// The node answers a fresh challenge with keccak256("unbrowse/node-proof\n" || token || "\n" || port (2 bytes, big
// endian) || challenge) for each token it holds (`/v1/node/proof`; `unbrowse_core::node_proof`). Only a process that
// holds the token can, so one that took the node's port while it was away (a boot, an update, a crash) never sees it.

const RC_HI = new Uint32Array([
  0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x00000000, 0x00000000,
  0x00000000, 0x00000000, 0x00000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x80000000, 0x00000000, 0x80000000,
  0x80000000, 0x80000000, 0x00000000, 0x80000000,
]);
const RC_LO = new Uint32Array([
  0x00000001, 0x00008082, 0x0000808a, 0x80008000, 0x0000808b, 0x80000001, 0x80008081, 0x00008009, 0x0000008a, 0x00000088,
  0x80008009, 0x8000000a, 0x8000808b, 0x0000008b, 0x00008089, 0x00008003, 0x00008002, 0x00000080, 0x0000800a, 0x8000000a,
  0x80008081, 0x00008080, 0x80000001, 0x80008008,
]);
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];

/** keccak-f[1600] on 25 lanes, each a (lo, hi) pair of 32-bit words. */
function permute(s: Uint32Array): void {
  const c = new Uint32Array(10);
  const b = new Uint32Array(50);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      c[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
      c[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
    }
    for (let x = 0; x < 5; x++) {
      const n = (x + 1) % 5;
      const p = (x + 4) % 5;
      const lo = c[2 * p] ^ ((c[2 * n] << 1) | (c[2 * n + 1] >>> 31));
      const hi = c[2 * p + 1] ^ ((c[2 * n + 1] << 1) | (c[2 * n] >>> 31));
      for (let y = 0; y < 25; y += 5) {
        s[2 * (x + y)] ^= lo;
        s[2 * (x + y) + 1] ^= hi;
      }
    }
    // rho and pi: lane (x, y) moves to (y, 2x + 3y), rotated.
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const from = x + 5 * y;
        const to = y + 5 * ((2 * x + 3 * y) % 5);
        const r = ROT[from];
        let lo = s[2 * from];
        let hi = s[2 * from + 1];
        if (r >= 32) {
          [lo, hi] = [hi, lo];
        }
        const k = r % 32;
        if (k) {
          [lo, hi] = [(lo << k) | (hi >>> (32 - k)), (hi << k) | (lo >>> (32 - k))];
        }
        b[2 * to] = lo;
        b[2 * to + 1] = hi;
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const i = x + y;
        const i1 = ((x + 1) % 5) + y;
        const i2 = ((x + 2) % 5) + y;
        s[2 * i] = b[2 * i] ^ (~b[2 * i1] & b[2 * i2]);
        s[2 * i + 1] = b[2 * i + 1] ^ (~b[2 * i1 + 1] & b[2 * i2 + 1]);
      }
    }
    s[0] ^= RC_LO[round];
    s[1] ^= RC_HI[round];
  }
}

/** Keccak-256, as Ethereum and the node use it (padding 0x01, not SHA3's 0x06). */
export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136;
  const padded = new Uint8Array(Math.floor(data.length / rate) * rate + rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Uint32Array(50);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 4; i++) {
      const j = off + 4 * i;
      s[i] ^= padded[j] | (padded[j + 1] << 8) | (padded[j + 2] << 16) | (padded[j + 3] << 24);
    }
    permute(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[4 * i] = s[i] & 0xff;
    out[4 * i + 1] = (s[i] >>> 8) & 0xff;
    out[4 * i + 2] = (s[i] >>> 16) & 0xff;
    out[4 * i + 3] = (s[i] >>> 24) & 0xff;
  }
  return out;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the node answers for `token` at `port` to `challenge` (`unbrowse_core::node_proof`). */
export function nodeProof(token: string, port: number, challenge: Uint8Array): string {
  const head = new TextEncoder().encode(`unbrowse/node-proof\n${token}\n`);
  const msg = new Uint8Array(head.length + 2 + challenge.length);
  msg.set(head);
  msg[head.length] = (port >> 8) & 0xff;
  msg[head.length + 1] = port & 0xff;
  msg.set(challenge, head.length + 2);
  return hex(keccak256(msg));
}

/** The port a base URL reaches, as the node signs it: the one named, else the scheme's own. */
export function portOf(baseUrl: string): number | undefined {
  try {
    const u = new URL(baseUrl);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a proof answer holds `want`: among the agents' proofs, or as the owner's. */
export function answerHolds(answer: unknown, want: string): boolean {
  const a = answer as { agents?: unknown; owner?: unknown; agent?: unknown } | null;
  if (!a || typeof a !== "object") return false;
  const said = [...(Array.isArray(a.agents) ? a.agents : []), a.owner, a.agent].filter((p): p is string => typeof p === "string");
  return said.some((p) => p.toLowerCase().replace(/^0x/, "") === want);
}

/** The name the node finds a token by, without the token: keccak256("unbrowse/node-key\n" || token)
 * (`unbrowse_core::token_key`). Sent with the challenge so the node answers for that token alone. */
export function tokenKey(token: string): string {
  return hex(keccak256(new TextEncoder().encode(`unbrowse/node-key\n${token}`)));
}
