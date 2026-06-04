/**
 * src/sdk/onboard.ts — identity onboarding for the hole.
 *
 * Best-practice credential chain, resolved in order:
 *   1. a BOUND ACCOUNT — an API key (from a frontend OAuth login or `unbrowse register`),
 *      which already carries payouts + sync;
 *   2. else the auto-created LOCAL SELF-CUSTODY WALLET (the keyless fallback every install
 *      gets — see src/values/signer.ts `ensureLocalWalletAddress`, surfaced at
 *      ~/.unbrowse/wallet.json), which can later be SYNCED onto an account.
 *
 * `onboardingStatus` reports what's configured and the one next step to tell the user.
 * Every input (api-key resolver, wallet peek, sync) is injectable so this is testable
 * offline and embeddable in any frontend.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function defaultResolveApiKey() {
    const k = process.env.UNBROWSE_API_KEY?.trim();
    return k ? k : undefined;
}
function defaultPeekWallet() {
    try {
        const p = join(process.env.HOME || homedir(), ".unbrowse", "wallet.json");
        if (!existsSync(p))
            return undefined;
        const j = JSON.parse(readFileSync(p, "utf8"));
        return typeof j.address === "string" && j.address ? j.address : undefined;
    }
    catch {
        return undefined;
    }
}
function maskKey(key) {
    return key.length <= 10 ? key : `${key.slice(0, 4)}…${key.slice(-4)}`;
}
/**
 * Ensure the agent has a usable identity, account-first then local wallet. When only a
 * local wallet exists and a `sync` is provided, the wallet is published onto an account.
 * Throws only when neither an account key nor a local wallet can be found (run setup).
 */
export async function ensureIdentity(opts = {}) {
    const apiKey = (opts.resolveApiKey ?? defaultResolveApiKey)();
    if (apiKey) {
        return { kind: "account", id: maskKey(apiKey), synced: true };
    }
    const wallet = (opts.peekWallet ?? defaultPeekWallet)();
    if (wallet) {
        const id = { kind: "wallet", id: wallet, synced: false };
        if (opts.sync) {
            await opts.sync(id);
            id.synced = true;
        }
        return id;
    }
    throw new Error("No identity yet. Run `unbrowse setup` to create a local self-custody wallet, " +
        "or set UNBROWSE_API_KEY (`unbrowse register --email you@example.com`) to bind an account.");
}
/** Report onboarding state + the single next step to show the user. */
export function onboardingStatus(opts = {}) {
    const apiKey = (opts.resolveApiKey ?? defaultResolveApiKey)();
    const wallet = (opts.peekWallet ?? defaultPeekWallet)();
    const hasAccount = !!apiKey;
    const hasWallet = !!wallet;
    let identity = null;
    let nextStep;
    if (hasAccount) {
        identity = { kind: "account", id: maskKey(apiKey), synced: true };
        nextStep = "You're set: a bound account handles sync, payouts, and paid routes.";
    }
    else if (hasWallet) {
        identity = { kind: "wallet", id: wallet, synced: false };
        nextStep =
            "Local self-custody wallet ready. Bind an account to sync earnings across machines: " +
                "`unbrowse register --email you@example.com`.";
    }
    else {
        nextStep = "Run `unbrowse setup` to create your local wallet (or set UNBROWSE_API_KEY).";
    }
    return { identity, hasAccount, hasWallet, nextStep };
}
