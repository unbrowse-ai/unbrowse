export type IdentityKind = "account" | "wallet";
export interface Identity {
    kind: IdentityKind;
    /** masked api-key tail for an account, or the base58 wallet address. */
    id: string;
    /** true once the identity is reflected on the server-side account profile. */
    synced: boolean;
}
export interface OnboardOptions {
    /** Resolve a bound-account API key. Default: UNBROWSE_API_KEY from the environment. */
    resolveApiKey?: () => string | undefined;
    /** Peek the local self-custody wallet address (no creation). Default: ~/.unbrowse/wallet.json. */
    peekWallet?: () => string | undefined;
    /** Publish a local wallet identity onto an account (sync). Optional. */
    sync?: (id: Identity) => Promise<void>;
}
export interface OnboardingStatus {
    identity: Identity | null;
    hasAccount: boolean;
    hasWallet: boolean;
    /** One human-readable next step to surface during onboarding. */
    nextStep: string;
}
/**
 * Ensure the agent has a usable identity, account-first then local wallet. When only a
 * local wallet exists and a `sync` is provided, the wallet is published onto an account.
 * Throws only when neither an account key nor a local wallet can be found (run setup).
 */
export declare function ensureIdentity(opts?: OnboardOptions): Promise<Identity>;
/** Report onboarding state + the single next step to show the user. */
export declare function onboardingStatus(opts?: OnboardOptions): OnboardingStatus;
