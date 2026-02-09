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
  // Version info
  latestVersionHash?: string;
  totalVersions?: number;
  // Badge info
  badge?: "official" | "highlighted" | "deprecated" | "verified";
  badgeReason?: string;
  // Trending info
  velocity?: number;
  downloads24h?: number;
}

export interface VersionInfo {
  versionId: string;
  versionHash: string;
  versionNumber: string;
  changelog: string | null;
  isLatest: boolean;
  createdAt: string;
}

export interface TrendingSkill extends SkillSummary {
  velocity: number;
  downloads24h: number;
  downloads7d: number;
  executions24h: number;
  successRate: number | null;
}

export interface SkillStats {
  skillId: string;
  period: string;
  installations: number;
  executions: {
    total: number;
    successful: number;
    successRate: number;
    avgExecutionTimeMs: number | null;
  };
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
  /** Price in USDC (e.g., "0" for free, "1.00" for $1.00). Min: $0.10, Max: $100.00. Default: free. */
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
        headers: {
          "Accept": "application/json",
        },
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
      headers: {
        "Accept": "application/json",
      },
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
   * Free skills download directly; paid skills require x402 payment.
   */
  async download(id: string): Promise<SkillPackage> {
    const downloadUrl = `${this.indexUrl}/marketplace/skill-downloads/${encodeURIComponent(id)}`;

    // First request - may succeed directly (free) or return 402 (paid)
    const initialResp = await fetch(downloadUrl, {
      headers: {
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });

    // Free skill - returns content directly
    if (initialResp.ok) {
      const data = await initialResp.json();
      return data.skill;
    }

    // Paid skill - requires x402 payment
    if (initialResp.status === 402) {
      if (!this.solanaPrivateKey) {
        throw new Error(
          "This skill requires payment but no Solana wallet is configured. " +
          "Set up a wallet with unbrowse_wallet to download paid skills.",
        );
      }

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
          "Accept": "application/json",
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

    // Other error
    const text = await initialResp.text().catch(() => "");
    throw new Error(`Skill download failed (${initialResp.status}): ${text}`);
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
    let Connection: any, PublicKey: any, Transaction: any, TransactionInstruction: any, Keypair: any, SystemProgram: any;
    let getAssociatedTokenAddress: any, createTransferInstruction: any;
    try {
      ({ Connection, PublicKey, Transaction, TransactionInstruction, Keypair, SystemProgram } =
        await import("@solana/web3.js"));
      ({ getAssociatedTokenAddress, createTransferInstruction } =
        await import("@solana/spl-token"));
    } catch (err) {
      throw new Error(
        `Solana native bindings failed to load (Node ${process.version}). ` +
        `Try Node v22 LTS. Error: ${(err as Error).message}`
      );
    }

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

  /** Publish a skill to the marketplace (requires wallet signature). */
  async publish(payload: PublishPayload): Promise<PublishResult> {
    const walletHeaders = await this.getWalletAuthHeaders("publish");

    const resp = await fetch(`${this.indexUrl}/marketplace/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...walletHeaders },
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
    const walletHeaders = await this.getWalletAuthHeaders("edit");

    const resp = await fetch(`${this.indexUrl}/skills/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...walletHeaders },
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
    const walletHeaders = await this.getWalletAuthHeaders("delete");

    const resp = await fetch(`${this.indexUrl}/skills/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: walletHeaders,
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Delete failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<{ deleted: boolean; id: string }>;
  }

  /**
   * Build wallet auth headers for the backend.
   * Returns X-Wallet-Address, X-Wallet-Signature, X-Wallet-Message headers.
   */
  private async getWalletAuthHeaders(action: string): Promise<Record<string, string>> {
    if (!this.solanaPrivateKey) {
      throw new Error(
        "No Solana private key configured. Required to sign requests. " +
        'Use unbrowse_wallet action="set_payer" to configure.',
      );
    }

    const { Keypair } = await import("@solana/web3.js");
    const bs58 = await import("bs58");

    const keypair = Keypair.fromSecretKey(bs58.default.decode(this.solanaPrivateKey));
    const walletAddress = keypair.publicKey.toBase58();
    const timestamp = Date.now().toString();
    const message = `unbrowse:${action}:${timestamp}`;
    const signature = await this.signMessage(message);

    return {
      "X-Wallet-Address": walletAddress,
      "X-Wallet-Signature": signature,
      "X-Wallet-Message": message,
    };
  }

  /**
   * Sign a message with the Solana keypair.
   * Returns base58-encoded Ed25519 signature.
   */
  private async signMessage(message: string): Promise<string> {
    let Keypair: any, bs58: any, nacl: any;
    try {
      ({ Keypair } = await import("@solana/web3.js"));
      bs58 = await import("bs58");
      nacl = await import("tweetnacl");
    } catch (err) {
      throw new Error(
        `Solana native bindings failed to load (Node ${process.version}). ` +
        `Try Node v22 LTS. Error: ${(err as Error).message}`
      );
    }

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

  // ============================================================================
  // VERSION MANAGEMENT
  // ============================================================================

  /**
   * Get all versions for a skill.
   */
  async getVersions(skillId: string): Promise<VersionInfo[]> {
    const resp = await fetch(
      `${this.indexUrl}/marketplace/skills/${encodeURIComponent(skillId)}/versions`,
      {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Get versions failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    return data.versions || [];
  }

  /**
   * Create a new version for a skill.
   * Returns null if version already exists (no changes).
   */
  async createVersion(
    skillId: string,
    payload: {
      skillMd: string;
      scripts?: Record<string, string>;
      references?: Record<string, string>;
      changelog?: string;
      versionNumber?: string;
    },
  ): Promise<VersionInfo | null> {
    const resp = await fetch(
      `${this.indexUrl}/marketplace/skills/${encodeURIComponent(skillId)}/versions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (resp.status === 409) {
      // Version already exists (no changes)
      return null;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Create version failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    return data.version;
  }

  /**
   * Download a specific version of a skill by version hash.
   */
  async downloadVersion(skillId: string, versionHash: string): Promise<SkillPackage> {
    const resp = await fetch(
      `${this.indexUrl}/marketplace/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(versionHash)}`,
      {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Download version failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    return data.skill;
  }

  // ============================================================================
  // INSTALLATION & EXECUTION TRACKING
  // ============================================================================

  /**
   * Report a skill installation (called after successful download).
   */
  async reportInstallation(input: {
    skillId: string;
    versionHash?: string;
    installedBy?: string;
    platform?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ installationId: string }> {
    try {
      const resp = await fetch(`${this.indexUrl}/marketplace/installations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillId: input.skillId,
          versionHash: input.versionHash,
          installedBy: input.installedBy || this.creatorWallet,
          platform: input.platform || process.platform,
          metadata: input.metadata,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        console.warn(`[SkillIndexClient] Installation tracking failed: ${resp.status}`);
        return { installationId: "" };
      }

      const data = await resp.json();
      return { installationId: data.installation?.installationId || "" };
    } catch (err) {
      // Installation tracking is best-effort, don't fail the operation
      console.warn(`[SkillIndexClient] Installation tracking failed: ${err}`);
      return { installationId: "" };
    }
  }

  /**
   * Report a skill execution (called after each replay).
   */
  async reportExecution(input: {
    skillId: string;
    installationId?: string;
    success: boolean;
    executionTimeMs?: number;
    errorMessage?: string;
    endpoint?: string;
  }): Promise<void> {
    try {
      await fetch(`${this.indexUrl}/marketplace/executions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Execution tracking is best-effort, don't fail the operation
    }
  }

  /**
   * Get stats for a skill.
   */
  async getSkillStats(
    skillId: string,
    period: "24h" | "7d" | "30d" | "all" = "24h",
  ): Promise<SkillStats> {
    const resp = await fetch(
      `${this.indexUrl}/marketplace/skills/${encodeURIComponent(skillId)}/stats?period=${period}`,
      {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Get stats failed (${resp.status}): ${text}`);
    }

    return resp.json();
  }

  // ============================================================================
  // TRENDING
  // ============================================================================

  /**
   * Get trending skills.
   */
  async getTrending(
    opts?: { period?: "24h" | "7d" | "30d"; limit?: number },
  ): Promise<TrendingSkill[]> {
    const url = new URL(`${this.indexUrl}/marketplace/trending`);
    if (opts?.period) url.searchParams.set("period", opts.period);
    if (opts?.limit) url.searchParams.set("limit", String(opts.limit));

    const resp = await fetch(url.toString(), {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Get trending failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    return data.skills || [];
  }

  /**
   * Get featured/badged skills.
   */
  async getFeatured(limit: number = 50): Promise<SkillSummary[]> {
    const resp = await fetch(
      `${this.indexUrl}/marketplace/featured?limit=${limit}`,
      {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Get featured failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    return data.skills || [];
  }
}
