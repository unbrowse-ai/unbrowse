const SOLANA = "solana:";
const F_CONNECT = "standard:connect";
const F_SIGN_MESSAGE = "solana:signMessage";
/** Wallets that can connect + sign a Solana message (what x402 over Solana needs). */
export function pickSolanaWallets(wallets) {
    return wallets.filter((w) => w.chains.some((c) => c.startsWith(SOLANA)) &&
        F_SIGN_MESSAGE in w.features);
}
function toBase64(bytes) {
    // browser + node, no deps
    if (typeof btoa === "function") {
        let s = "";
        for (const b of bytes)
            s += String.fromCharCode(b);
        return btoa(s);
    }
    // @ts-ignore Buffer exists in node
    return Buffer.from(bytes).toString("base64");
}
/**
 * The bytes a wallet signs for an x402 payment. The server advertises the
 * challenge in the 402 `terms` (an `accepts`/`flex`/`x402` envelope); we surface
 * the common shapes and sign the canonical challenge string. The exact on-wire
 * payload assembly is owned by the x402 facilitator the server names — this
 * produces the message to authorize.
 */
export function paymentMessage(terms) {
    let challenge = "";
    if (terms && typeof terms === "object") {
        const t = terms;
        const accepts = Array.isArray(t.accepts) ? t.accepts[0] : undefined;
        challenge =
            (typeof t.challenge === "string" && t.challenge) ||
                (typeof t.message === "string" && t.message) ||
                (accepts && typeof accepts.challenge === "string" && accepts.challenge) ||
                JSON.stringify(accepts ?? t);
    }
    return new TextEncoder().encode(challenge);
}
/**
 * Build a {@link PayHandler} from any Wallet Standard wallet. On a 402 it asks
 * the wallet to sign the payment challenge and returns the `X-PAYMENT` header
 * for a single retry. Returns `null` (declines) if the wallet cannot sign — the
 * caller then sees the original 402, never a thrown error.
 *
 *   import { Unbrowse } from "unbrowse/sdk";
 *   import { walletStandardPay } from "unbrowse/sdk/wallet-standard";
 *   const pay = walletStandardPay(myWallet);
 *   const unbrowse = new Unbrowse({ apiKey, pay });
 */
export function walletStandardPay(wallet, opts = {}) {
    const header = opts.header ?? "X-PAYMENT";
    return async (ctx) => {
        const sign = wallet.features[F_SIGN_MESSAGE];
        if (!sign)
            return null; // wallet can't sign Solana messages → decline cleanly
        let account = opts.account ?? wallet.accounts[0];
        if (!account) {
            const connect = wallet.features[F_CONNECT];
            if (!connect)
                return null;
            const { accounts } = await connect.connect();
            account = accounts[0];
            if (!account)
                return null;
        }
        const message = paymentMessage(ctx.terms);
        const [result] = await sign.signMessage({ account, message });
        if (!result)
            return null;
        return { [header]: toBase64(result.signature) };
    };
}
const DEFAULT_BASE = "https://beta-api.unbrowse.ai";
/**
 * An OPTIONAL default wallet for users who don't want to run their own wallet —
 * a Wallet Standard `Wallet` whose signing is delegated to the Unbrowse server
 * (authorized by an API key). It is opt-in: you must pass an `apiKey`. Register
 * it with `@wallet-standard/wallet`'s `registerWallet()` to expose it to any
 * Wallet Standard consumer (including the Unbrowse frontend).
 *
 * Web2-native: the user "just wants to pay via API" — no seed phrase, no
 * extension. The server (or lobster.cash, or any other wallet) remains the
 * transaction-state authority; this is a thin convenience default, never forced.
 */
export function makeUnbrowseWallet(opts) {
    if (!opts.apiKey) {
        throw new Error("makeUnbrowseWallet is opt-in: pass { apiKey } to delegate signing to the Unbrowse server.");
    }
    const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    const doFetch = opts.fetch ?? globalThis.fetch;
    const account = {
        address: opts.address,
        publicKey: opts.publicKey,
        chains: ["solana:mainnet"],
        features: [F_SIGN_MESSAGE],
    };
    const signMessage = async ({ message }) => {
        const res = await doFetch(`${base}/v1/wallet/sign`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
            body: JSON.stringify({ address: opts.address, message: toBase64(message) }),
        });
        if (!res.ok)
            throw new Error(`unbrowse wallet sign failed: ${res.status}`);
        const data = (await res.json());
        const sig = Uint8Array.from(atobBytes(data.signature));
        return [{ signedMessage: message, signature: sig }];
    };
    return {
        version: "1.0.0",
        name: "Unbrowse",
        chains: ["solana:mainnet"],
        accounts: [account],
        features: {
            [F_CONNECT]: { connect: async () => ({ accounts: [account] }) },
            [F_SIGN_MESSAGE]: { signMessage },
        },
    };
}
function atobBytes(b64) {
    const bin = typeof atob === "function" ? atob(b64) : // @ts-ignore
        Buffer.from(b64, "base64").toString("binary");
    const out = [];
    for (let i = 0; i < bin.length; i++)
        out.push(bin.charCodeAt(i));
    return out;
}
