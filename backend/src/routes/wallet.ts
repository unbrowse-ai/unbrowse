import { Hono } from "hono";
import type { Env } from "../types.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { bearerAuth } from "../middleware/auth.js";
import { signWithDefaultWallet, loadDefaultWalletSecret } from "../services/wallet-signer.js";

export const walletRoutes = new Hono<{ Bindings: Env }>();

walletRoutes.use("/wallet/sign", rateLimit({ limit: 60, window: 60, prefix: "wallet-sign" }));

/**
 * POST /v1/wallet/sign — sign a message with the unbrowse-default wallet.
 *
 * The default wallet is the platform's own Ed25519 keypair, held server-side as
 * a wrangler secret; signing with it needs no Privy delegation and no user
 * consent (the backend holds the key). Returns the base58 pubkey + base64
 * signature over a domain-separated message, so the signature is verifiable by
 * anyone holding the pubkey but cannot be replayed into another protocol.
 *
 * Used to mint platform attestations (route-freshness claims, receipts, the
 * website-wallet domain binding of whitepaper §9) under one stable identity.
 */
walletRoutes.post("/wallet/sign", bearerAuth, async (c) => {
	let body: { message?: unknown };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid json" }, 400);
	}
	const message = typeof body?.message === "string" ? body.message : "";
	if (!message) return c.json({ error: "message (string) required" }, 400);
	// Bound the payload so a hostile client cannot pin a Worker isolate.
	if (message.length > 16384) return c.json({ error: "message too large (max 16KB)" }, 413);

	const secret = loadDefaultWalletSecret(c.env);
	if (!secret) {
		return c.json({ error: "default wallet not configured", _binding_missing: "UNBROWSE_DEFAULT_WALLET_KEY" }, 503);
	}
	try {
		const signed = await signWithDefaultWallet(message, secret);
		return c.json(signed);
	} catch (err) {
		console.error("[wallet] sign failed:", (err as Error).message);
		return c.json({ error: "sign failed" }, 500);
	}
});
