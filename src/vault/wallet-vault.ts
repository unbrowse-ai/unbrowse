/**
 * wallet-vault — credentials sealed to the wallet, the client keeps nothing
 * usable.
 *
 * The default vault (src/vault/index.ts) stores credentials in the OS keychain
 * or a local AES file with a local key — usable by anyone with the machine. The
 * wallet-vault is the ZK-obfuscation endgame: each credential is SEALED TO THE
 * WALLET (sealToWallet — AES-256-GCM under a key only the holder's wallet can
 * derive, content-addressed over the plaintext). So:
 *   - only the wallet-holder can OPEN a credential (a wrong wallet fails closed);
 *   - the stored blob leaks NO plaintext (opaque ciphertext + a content-hash);
 *   - the content-address is host-independent, so the sealed blob can live in
 *     the backend KV and resolve the same on any machine — the last stateless
 *     gap (the binary holds only sealed blobs, never plaintext secrets).
 *
 * "Any key value ZK'ed to their wallet only for them to use." This is the
 * secular commitment+AEAD layer the whitepaper's commitmentBound proof later
 * strengthens; it needs no ZK to be correct. Reverse-engineering the client
 * yields nothing because the client keeps nothing openable.
 */
import { sealToWallet, revealForWallet, type WalletSealed } from "../trust/sealed-cache.js";

/** A wallet-sealed credential store. In-memory working set; the durable copy is
 *  the sealed-blob stream (local opaque file or the backend KV — either way it
 *  carries no plaintext and only the wallet-holder can open it). */
export class WalletVault {
	private readonly entries = new Map<string, WalletSealed>();

	/** Seal `secret` for `account` to the holder's wallet. Returns the sealed
	 *  blob (what gets persisted). The account name scopes the AEAD so a blob
	 *  sealed for one account cannot be opened into another. */
	async store(account: string, secret: string, walletSecret: string): Promise<WalletSealed> {
		const sealed = await sealToWallet(secret, walletSecret, account);
		this.entries.set(account, sealed);
		return sealed;
	}

	has(account: string): boolean {
		return this.entries.has(account);
	}

	/** The host-independent content-address for an account's credential (reveals
	 *  nothing about the secret), or undefined. */
	commitmentOf(account: string): string | undefined {
		return this.entries.get(account)?.commitment;
	}

	/** Open the credential for the wallet-holder. Throws for a wrong wallet or a
	 *  tampered blob; returns undefined for an unknown account. */
	async open(account: string, walletSecret: string): Promise<string | undefined> {
		const sealed = this.entries.get(account);
		if (!sealed) return undefined;
		return (await revealForWallet(sealed, walletSecret, account)) as string;
	}

	/** Export the sealed blobs for persistence — opaque, no plaintext, ready for
	 *  the backend KV (stateless) or a local sealed-blob file. */
	exportSealed(): Record<string, WalletSealed> {
		return Object.fromEntries(this.entries);
	}

	/** Rehydrate from previously-exported sealed blobs (e.g. fetched from the
	 *  backend KV by the wallet identity). Still openable only by the holder. */
	importSealed(blobs: Record<string, WalletSealed>): void {
		for (const [account, blob] of Object.entries(blobs)) this.entries.set(account, blob);
	}

	get size(): number {
		return this.entries.size;
	}
}
