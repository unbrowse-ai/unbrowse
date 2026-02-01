/**
 * Skill Index Client — Publish and search the cloud skill marketplace.
 *
 * Handles communication with the skill index API, including x402 payments
 * for downloading skills on Solana. Publishing and searching are free;
 * downloading a skill package requires USDC via x402.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface SkillSummary {
  skillId: string;
  name: string;
  description: string;
  category: string | null;
  authType: string | null;
  serviceName: string | null;
  domain: string | null;
  downloadCount: number;
  creatorWallet: string | null;
  priceUsdc: string;
  isPublished: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SkillPackage {
  skillId: string;
  name: string;
  description: string;
  skillMd: string;
  scripts?: Record<string, string>;
  references?: Record<string, string>;
  category: string | null;
  authType: string | null;
  serviceName: string | null;
  domain: string | null;
}

export interface PublishPayload {
  name: string;
  description: string;
  skillMd: string;
  category?: string;
  authType?: string;
  scripts?: Record<string, string>;
  references?: Record<string, string>;
  serviceName?: string;
  domain?: string;
  creatorWallet?: string;
  /** Price in USDC (e.g., "1.00" for $1.00). Min: $0.10, Max: $100.00. Default: $1.00 */
  priceUsdc?: string;
}

export interface PublishResult {
  success: boolean;
  skill: {
    skillId: string;
    name: string;
  };
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

  /** Search the skill marketplace (free). */
  async search(
    query: string,
    opts?: { limit?: number },
  ): Promise<SearchResult> {
    const url = new URL(`${this.indexUrl}/marketplace/skills`);
    if (query) url.searchParams.set("q", query);
    if (opts?.limit) url.searchParams.set("limit", String(opts.limit));

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

    const data = await resp.json();
    return {
      skills: data.skills || [],
      total: data.count || 0,
    };
  }

  /** Get skill summary (free - metadata only, no content). */
  async getSkillSummary(id: string): Promise<SkillSummary> {
    const resp = await fetch(`${this.indexUrl}/marketplace/skills/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Get skill failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    return data.skill;
  }

  /**
   * Download a skill package with full content.
   * Requires x402 payment ($1.00 USDC).
   */
  async download(id: string): Promise<SkillPackage> {
    if (!this.solanaPrivateKey) {
      throw new Error(
        "No Solana private key configured. Required for x402 skill downloads. " +
        "Set skillIndexSolanaPrivateKey in unbrowse config or use unbrowse_wallet to create one.",
      );
    }

    const downloadUrl = `${this.indexUrl}/marketplace/skill-downloads/${encodeURIComponent(id)}`;

    // First request to get 402 response with payment requirements
    const initialResp = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(15_000),
    });

    if (initialResp.status === 402) {
      // Parse x402 payment requirements
      const x402Response = await initialResp.json();
      const accepts = x402Response.accepts?.[0];

      if (!accepts) {
        throw new Error("Invalid x402 response - no payment requirements");
      }

      // Build and sign payment transaction
      const paymentHeader = await this.buildAndSignPayment(accepts);

      // Retry with payment
      const paidResp = await fetch(downloadUrl, {
        headers: {
          "X-Payment": paymentHeader,
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!paidResp.ok) {
        const text = await paidResp.text().catch(() => "");
        throw new Error(`Skill download failed after payment (${paidResp.status}): ${text}`);
      }

      const data = await paidResp.json();
      return data.skill;
    }

    if (!initialResp.ok) {
      const text = await initialResp.text().catch(() => "");
      throw new Error(`Skill download failed (${initialResp.status}): ${text}`);
    }

    // Unexpected success without payment (shouldn't happen with gated content)
    const data = await initialResp.json();
    return data.skill;
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

  /** Publish a skill to the marketplace (free). */
  async publish(payload: PublishPayload): Promise<PublishResult> {
    const resp = await fetch(`${this.indexUrl}/marketplace/skills`, {
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

  /**
   * Update a skill (creator wallet signature required).
   * Only the wallet that published the skill can update it.
   */
  async update(id: string, payload: Partial<PublishPayload>): Promise<PublishResult> {
    if (!this.solanaPrivateKey) {
      throw new Error(
        "No Solana private key configured. Required to sign update requests. " +
        "Set skillIndexSolanaPrivateKey in unbrowse config.",
      );
    }

    const timestamp = Date.now().toString();
    const message = `unbrowse:edit:${id}:${timestamp}`;
    const signature = await this.signMessage(message);

    const resp = await fetch(`${this.indexUrl}/skills/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": signature,
        "X-Timestamp": timestamp,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Update failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<PublishResult>;
  }

  /**
   * Delete a skill (creator wallet signature required).
   * Only the wallet that published the skill can delete it.
   */
  async delete(id: string): Promise<{ deleted: boolean; id: string }> {
    if (!this.solanaPrivateKey) {
      throw new Error(
        "No Solana private key configured. Required to sign delete requests. " +
        "Set skillIndexSolanaPrivateKey in unbrowse config.",
      );
    }

    const timestamp = Date.now().toString();
    const message = `unbrowse:edit:${id}:${timestamp}`;
    const signature = await this.signMessage(message);

    const resp = await fetch(`${this.indexUrl}/skills/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: {
        "X-Signature": signature,
        "X-Timestamp": timestamp,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Delete failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<{ deleted: boolean; id: string }>;
  }

  /**
   * Sign a message with the Solana keypair.
   * Returns base58-encoded Ed25519 signature.
   */
  private async signMessage(message: string): Promise<string> {
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = await import("bs58");
    const nacl = await import("tweetnacl");

    // Decode private key
    let keypair: InstanceType<typeof Keypair>;
    try {
      keypair = Keypair.fromSecretKey(bs58.default.decode(this.solanaPrivateKey!));
    } catch {
      throw new Error("Invalid Solana private key. Must be base58-encoded.");
    }

    // Sign message
    const messageBytes = new TextEncoder().encode(message);
    const signature = nacl.sign.detached(messageBytes, keypair.secretKey);

    return bs58.default.encode(signature);
  }
}
