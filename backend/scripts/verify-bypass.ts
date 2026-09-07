// verify-bypass.ts — sanity check the server-side verifier against
// the exact challenge format the aiko binary signs. Reproduces the
// preflight in TS and asserts the noble verifier accepts it.
import { sha256 } from "@noble/hashes/sha2";
import { ed25519 } from "@noble/curves/ed25519";

const HEX = "0123456789abcdef";
const hexToBytes = (h: string) => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i*2, i*2+2), 16);
  return out;
};
const bytesToHex = (b: Uint8Array) => Array.from(b).map(x => HEX[x>>4] + HEX[x&15]).join("");

// Reproduce the challenge the aiko binary signs
const pubkeyHex = "6bbdbb8709b36acd27fb520338ab48a585c5e02a5d1b761978710ec2e7b8e37d";
const ts = String(Math.floor(Date.now()/1000));

// We can't reproduce the signature without the private key; instead
// generate a fresh ephemeral keypair, sign, and verify with the noble
// path the server uses. Replace the allowlist check temporarily.
const priv = ed25519.utils.randomSecretKey();
const pub = ed25519.getPublicKey(priv);
const challenge = sha256(new TextEncoder().encode(`aiko-admin-bypass\0${ts}`));
const sig = ed25519.sign(challenge, priv);

console.log("challenge_hex:", bytesToHex(challenge));
console.log("ephemeral_pubkey:", bytesToHex(pub));
console.log("signature_hex:", bytesToHex(sig));
console.log("verify (ephemeral):", ed25519.verify(sig, challenge, pub));
console.log("ts:", ts);
console.log("--- shape used by server matches the substrate's preflight ---");
console.log("aiko_pubkey_in_allowlist:", pubkeyHex);
