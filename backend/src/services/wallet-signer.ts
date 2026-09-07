/**
 * wallet-signer — server-side Ed25519 signing with the unbrowse-default wallet.
 *
 * "The unbrowse-default wallet" is the PLATFORM's own keypair (a Solana account
 * literally is a base58 Ed25519 public key — whitepaper §3 "the wallet is the
 * identity"), held server-side as a wrangler secret. Signing with it needs no
 * Privy delegation and no user consent — the backend holds the key and signs
 * directly via Web Crypto Ed25519 (the same path sponsor-flex.ts already uses
 * for Flex payment authorisations).
 *
 * Domain separation: every message is signed under a fixed prefix so a signature
 * minted here can never be replayed as a Flex payment authorisation or any other
 * protocol message that signs raw bytes with the same key.
 */
import { decodeSecretKeyBytes } from "./sponsor-flex.js";

/** Prefix mixed into every signed message — prevents cross-protocol replay. */
export const SIGN_DOMAIN = "unbrowse-wallet-sign-v1\n";

// PKCS#8 wrapper for a raw 32-byte Ed25519 seed (same header sponsor-flex uses).
const PKCS8_HEADER = new Uint8Array([
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function toPkcs8(seed32: Uint8Array): Uint8Array {
	const out = new Uint8Array(PKCS8_HEADER.length + 32);
	out.set(PKCS8_HEADER, 0);
	out.set(seed32, PKCS8_HEADER.length);
	return out;
}

function b64encode(bytes: Uint8Array): string {
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s);
}
function b64decode(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function bs58(): Promise<{ encode: (b: Uint8Array) => string; decode: (s: string) => Uint8Array }> {
	const mod = (await import("bs58")) as unknown as { default: { encode: (b: Uint8Array) => string; decode: (s: string) => Uint8Array } };
	return mod.default;
}

export interface DefaultWalletSignature {
	/** base58 Ed25519 public key — the default wallet's on-chain identity. */
	publicKey: string;
	/** base64 Ed25519 signature over `SIGN_DOMAIN + message`. */
	signature: string;
	/** the message that was signed (the domain prefix is applied internally). */
	message: string;
	/** the domain-separation prefix used (so verifiers reconstruct the bytes). */
	domain: string;
}

/**
 * Sign `message` with the default wallet secret (a 64-byte Solana keypair =
 * 32-byte seed || 32-byte pubkey, in JSON-array / hex / base58 form). Returns
 * the base58 pubkey + base64 signature over the domain-separated bytes.
 */
export async function signWithDefaultWallet(message: string, rawSecret: string): Promise<DefaultWalletSignature> {
	const secret = await decodeSecretKeyBytes(rawSecret);
	if (secret.length < 64) throw new Error(`default_wallet_key_too_short:${secret.length} (need 64-byte seed||pubkey)`);
	const seed = secret.slice(0, 32);
	const pub = secret.slice(32, 64);
	const priv = await crypto.subtle.importKey("pkcs8", toPkcs8(seed).buffer as ArrayBuffer, { name: "Ed25519" }, false, ["sign"]);
	const bytes = new TextEncoder().encode(SIGN_DOMAIN + message);
	const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", priv, bytes));
	return { publicKey: (await bs58()).encode(pub), signature: b64encode(sig), message, domain: SIGN_DOMAIN };
}

/** Verify a default-wallet signature: reconstructs the domain-separated bytes
 *  and checks the signature against the base58 pubkey. */
export async function verifyDefaultWalletSignature(message: string, signatureB64: string, publicKeyB58: string): Promise<boolean> {
	try {
		const pub = (await bs58()).decode(publicKeyB58);
		const key = await crypto.subtle.importKey("raw", pub.buffer as ArrayBuffer, { name: "Ed25519" }, false, ["verify"]);
		const bytes = new TextEncoder().encode(SIGN_DOMAIN + message);
		return await crypto.subtle.verify("Ed25519", key, b64decode(signatureB64), bytes);
	} catch {
		return false;
	}
}

/** Read the default wallet secret from the environment, or null when unset. */
export function loadDefaultWalletSecret(env: { UNBROWSE_DEFAULT_WALLET_KEY?: string }): string | null {
	const v = env.UNBROWSE_DEFAULT_WALLET_KEY?.trim();
	return v ? v : null;
}
