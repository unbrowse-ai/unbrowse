/**
 * Skill Index Client — Publish and search the cloud skill marketplace.
 *
 * Handles communication with the skill index API, including x402 payments
 * for downloading skills on Solana. Publishing and searching are free;
 * downloading a skill package requires USDC via x402.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkillSummary {
  id: string;
  service: string;
  slug: string;
  baseUrl: string;
  authMethodType: string;
  endpointCount: number;
  downloadCount: number;
  tags: string[];
  creatorWallet: string;
  creatorAlias?: string;
  updatedAt: string;
}

export interface SkillPackage {
  id: string;
  service: string;
  baseUrl: string;
  authMethodType: string;
  endpoints: { method: string; path: string; description?: string }[];
  skillMd: string;
  apiTemplate: string;
}

export interface PublishPayload {
  service: string;
  baseUrl: string;
  authMethodType: string;
  endpoints: { method: string; path: string; description?: string }[];
  skillMd: string;
  apiTemplate: string;
  creatorWallet: string;
}

export interface PublishResult {
  id: string;
  slug: string;
  version: number;
}

export interface SearchResult {
  skills: SkillSummary[];
  total: number;
}

// ── Client ───────────────────────────────────────────────────────────────────

export class SkillIndexClient {
  private indexUrl: string;
  private opts: {
    indexUrl: string;
    creatorWallet?: string;
    solanaPrivateKey?: string;
  };

  get creatorWallet(): string | undefined { return this.opts.creatorWallet; }
  get solanaPrivateKey(): string | undefined { return this.opts.solanaPrivateKey; }

  constructor(opts: {
    indexUrl: string;
    creatorWallet?: string;
    solanaPrivateKey?: string;
  }) {
    this.indexUrl = opts.indexUrl.replace(/\/$/, "");
    this.opts = opts;
  }

  /** Search the skill index (free). */
  async search(
    query: string,
    opts?: { tags?: string; limit?: number; offset?: number },
  ): Promise<SearchResult> {
    const url = new URL(`${this.indexUrl}/skills/search`);
    url.searchParams.set("q", query);
    if (opts?.tags) url.searchParams.set("tags", opts.tags);
    if (opts?.limit) url.searchParams.set("limit", String(opts.limit));
    if (opts?.offset) url.searchParams.set("offset", String(opts.offset));

    let resp: Response;
    try {
      resp = await fetch(url.toString(), {
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const name = (err as Error).name ?? "";
      if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND") || name === "AbortError" || name === "TimeoutError" || msg.includes("timeout")) {
        throw new Error(`Skill marketplace not reachable (${this.indexUrl}). The server may be offline or the URL misconfigured.`);
      }
      throw err;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Search failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<SearchResult>;
  }

  /** Get skill summary with endpoint list (free). */
  async getSummary(id: string): Promise<SkillSummary & { endpoints: { method: string; path: string }[] }> {
    const resp = await fetch(`${this.indexUrl}/skills/${encodeURIComponent(id)}/summary`, {
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Summary failed (${resp.status}): ${text}`);
    }

    return resp.json() as any;
  }

  /**
   * Download a skill package (x402 payment required).
   *
   * Handles the 402 → sign → retry flow using a Solana keypair.
   * Falls back to free download if the server has no x402 gate (dev mode).
   */
  async download(id: string): Promise<SkillPackage> {
    // Step 1: Initial request — may return 200 (free) or 402
    const resp = await fetch(`${this.indexUrl}/skills/${encodeURIComponent(id)}/download`, {
      signal: AbortSignal.timeout(15_000),
    });

    if (resp.ok) {
      // Free mode — no payment required
      return resp.json() as Promise<SkillPackage>;
    }

    if (resp.status !== 402) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Download failed (${resp.status}): ${text}`);
    }

    // Step 2: We got a 402 — need to pay
    if (!this.solanaPrivateKey) {
      throw new Error(
        "No Solana private key configured for x402 payments. " +
        "Set skillIndexSolanaPrivateKey in unbrowse config or UNBROWSE_SOLANA_PRIVATE_KEY env var.",
      );
    }

    const paymentReq = await resp.json();
    const accepts = paymentReq?.accepts?.[0];
    if (!accepts) {
      throw new Error("Invalid 402 response: no payment requirements");
    }

    // Step 3: Build and sign the Solana x402 transaction
    const paymentData = await this.buildAndSignPayment(accepts);

    // Step 4: Retry with X-Payment header
    const retryResp = await fetch(`${this.indexUrl}/skills/${encodeURIComponent(id)}/download`, {
      headers: { "X-Payment": paymentData },
      signal: AbortSignal.timeout(30_000),
    });

    if (!retryResp.ok) {
      const text = await retryResp.text().catch(() => "");
      throw new Error(`Download failed after payment (${retryResp.status}): ${text}`);
    }

    return retryResp.json() as Promise<SkillPackage>;
  }

  /**
   * Build and sign a Solana x402 payment transaction.
   * Returns base64-encoded X-Payment header value.
   */
  private async buildAndSignPayment(accepts: {
    maxAmountRequired: string;
    payTo: string;
    asset: string;
    network: string;
    extra?: { feePayer?: string; programId?: string };
  }): Promise<string> {
    const {
      Connection,
      PublicKey,
      Transaction,
      TransactionInstruction,
      Keypair,
      SystemProgram,
    } = await import("@solana/web3.js");
    const { getAssociatedTokenAddress, createTransferInstruction } =
      await import("@solana/spl-token");

    // Decode private key
    let keypair: InstanceType<typeof Keypair>;
    try {
      const bs58 = await import("bs58");
      keypair = Keypair.fromSecretKey(bs58.default.decode(this.solanaPrivateKey!));
    } catch {
      throw new Error("Invalid Solana private key. Must be base58-encoded.");
    }

    const isDevnet = accepts.network?.includes("devnet");
    const rpcUrl = isDevnet ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");

    const amount = BigInt(accepts.maxAmountRequired);
    const usdcMint = new PublicKey(accepts.asset);
    const recipient = new PublicKey(accepts.payTo);
    const programId = new PublicKey(
      accepts.extra?.programId ?? "5g8XvMcpWEgHitW7abiYTr1u8sDasePLQnrebQyCLPvY",
    );

    // Get token accounts
    const payerTokenAccount = await getAssociatedTokenAddress(usdcMint, keypair.publicKey);
    const recipientTokenAccount = await getAssociatedTokenAddress(usdcMint, recipient);

    // Build nonce
    const nonce = BigInt(Date.now());

    // Build verify_payment instruction: [0x00, amount(u64 LE), nonce(u64 LE)]
    const verifyData = Buffer.alloc(17);
    verifyData[0] = 0;
    verifyData.writeBigUInt64LE(amount, 1);
    verifyData.writeBigUInt64LE(nonce, 9);

    const verifyInstruction = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
      ],
      data: verifyData,
    });

    // SPL token transfer
    const transferInstruction = createTransferInstruction(
      payerTokenAccount,
      recipientTokenAccount,
      keypair.publicKey,
      Number(amount),
    );

    // Build settle_payment instruction: [0x01, nonce(u64 LE)]
    const settleData = Buffer.alloc(9);
    settleData[0] = 1;
    settleData.writeBigUInt64LE(nonce, 1);

    const settleInstruction = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: keypair.publicKey, isSigner: true, isWritable: false },
      ],
      data: settleData,
    });

    // Build transaction
    const tx = new Transaction();
    tx.add(verifyInstruction);
    tx.add(transferInstruction);
    tx.add(settleInstruction);

    const latestBlockhash = await connection.getLatestBlockhash();
    tx.recentBlockhash = latestBlockhash.blockhash;
    tx.feePayer = keypair.publicKey;
    tx.sign(keypair);

    // Encode as X-Payment header
    const paymentPayload = {
      transaction: Buffer.from(tx.serialize()).toString("base64"),
    };

    return Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
  }

  /** Publish a skill to the index (free). */
  async publish(payload: PublishPayload): Promise<PublishResult> {
    const resp = await fetch(`${this.indexUrl}/skills/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Publish failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<PublishResult>;
  }

  /**
   * Health check — verify the server is reachable (fast, no auth required).
   * Returns true if reachable, false otherwise.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.indexUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
}
