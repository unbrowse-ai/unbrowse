/**
 * Skill Index Client — Publish/search/download skills from the marketplace.
 *
 * Backend API surface used by this extension:
 * - GET  /marketplace/skills?q=&limit=
 * - GET  /marketplace/skills/:id
 * - GET  /marketplace/skills/:id/versions
 * - GET  /marketplace/skills/:id/versions/:hash
 * - GET  /marketplace/skill-downloads/:id   (200 for free, 402 for paid via x402)
 * - POST /marketplace/skills               (wallet-signed)
 * - POST /auth/wallet/link/request         (wallet-signed; sends email)
 * - GET  /health
 *
 * Notes:
 * - Paid downloads use x402 (HTTP 402) + Solana USDC.
 * - Publishing requires a Solana private key to sign X-Wallet-* headers.
 */

import {
  loadWeb3,
  loadSplToken,
  keypairFromBase58PrivateKey,
  keypairFromBase58PrivateKeyWeb3,
  signEd25519MessageBase58,
} from "./solana/solana-helpers.js";
import type { HeaderProfileFile } from "./types.js";

const DEFAULT_PUBLISH_TIMEOUT_MS = 300_000;

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
  headerProfile?: HeaderProfileFile;
  category: string | null;
  authType: string | null;
  serviceName: string | null;
  domain: string | null;
  abstraction?: {
    mode?: string;
    endpointCount?: number;
    hidesRawLogic?: boolean;
  };
}

export interface VersionInfo {
  versionId: string;
  versionHash: string;
  versionNumber: string;
  changelog: string | null;
  isLatest: boolean;
  createdAt: string;
}

export interface SkillEndpointSummary {
  endpointId: string;
  method: string;
  normalizedPath: string;
  rawPath?: string | null;
  domain?: string | null;
  fingerprint?: string | null;
  queryKeys?: string[];
  bodySchema?: string | null;
  pathParams?: Array<{ name: string; type: string; example: string }>;
  validationStatus?: string | null;
  qualityScore?: number | null;
  healthScore?: string | number | null;
  totalExecutions?: number;
  successfulExecutions?: number;
  contributedBy?: string | null;
  createdAt?: string;
}

export interface ExecuteEndpointRequest {
  params?: Record<string, any>;
  pathParams?: Record<string, any>;
  query?: Record<string, any>;
  body?: any;
  auth?: {
    cookies?: string;
    headers?: Record<string, string>;
  };
  context?: {
    traceId?: string;
    sessionId?: string;
    stepId?: string;
    parentStepId?: string;
    autoChain?: boolean;
    intent?: string;
  };
  privacy?: {
    storeTrace?: boolean;
    storeRaw?: boolean;
  };
}

export interface ExecuteEndpointResult {
  success: boolean;
  ok?: boolean;
  statusCode?: number;
  data?: any;
  error?: any;
  meta?: any;
}

export interface PublishPayload {
  name: string;
  description: string;
  skillMd: string;
  category?: string;
  authType?: string;
  scripts?: Record<string, string>;
  references?: Record<string, string>;
  headerProfile?: HeaderProfileFile;
  serviceName?: string;
  domain?: string;
  creatorWallet?: string;
  /** Price in USDC (e.g., "0" for free, "1.00" for $1.00). Min: $0.10, Max: $100.00. Default: free. */
  priceUsdc?: string;
  /**
   * Optional per-publish auth bundle used only for backend quality validation.
   * This is ephemeral request data and is not intended for persistence.
   */
  validationAuth?: {
    headers?: Record<string, string>;
    cookies?: string;
  };
}

export interface PublishResult {
  success: boolean;
  merged?: boolean;
  message?: string;
  skillId?: string;
  skill?: {
    skillId: string;
    name: string;
    skillMd?: string;
    scripts?: Record<string, string>;
    references?: Record<string, string>;
  };
  contribution?: {
    contributionId: string;
    noveltyScore: number;
    weight: number;
    endpointsAdded: number;
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
    publishTimeoutMs?: number;
  };

  get creatorWallet(): string | undefined { return this.opts.creatorWallet; }
  get solanaPrivateKey(): string | undefined { return this.opts.solanaPrivateKey; }

  constructor(opts: {
    indexUrl: string;
    creatorWallet?: string;
    solanaPrivateKey?: string;
    publishTimeoutMs?: number;
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
    extra?: { feePayer?: string; programId?: string; rpcUrl?: string };
  }): Promise<string> {
    const { Connection, PublicKey, Transaction, TransactionInstruction } = await loadWeb3();
    const { getAssociatedTokenAddress, createTransferInstruction } = await loadSplToken();
    const keypair = await keypairFromBase58PrivateKeyWeb3(this.solanaPrivateKey!);

    const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const network = String(accepts.network ?? "").toLowerCase();
    const isDevnetByNetwork = network.includes("devnet");
    const isDevnetByMint = accepts.asset === DEVNET_USDC_MINT;
    const isMainnetByMint = accepts.asset === MAINNET_USDC_MINT;

    if ((isDevnetByNetwork && isMainnetByMint) || (!isDevnetByNetwork && isDevnetByMint)) {
      throw new Error(
        `x402 challenge mismatch: network=${accepts.network}, asset=${accepts.asset}. ` +
        "Refusing to sign invalid payment challenge.",
      );
    }

    const rpcUrl = accepts.extra?.rpcUrl
      ?? (isDevnetByNetwork || isDevnetByMint ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");
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
    const publishTimeoutMs = Number.isFinite(this.opts.publishTimeoutMs) && (this.opts.publishTimeoutMs as number) > 0
      ? Math.trunc(this.opts.publishTimeoutMs as number)
      : DEFAULT_PUBLISH_TIMEOUT_MS;

    const resp = await fetch(`${this.indexUrl}/marketplace/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...walletHeaders },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(publishTimeoutMs),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Publish failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<PublishResult>;
  }

  /** Request wallet-email linking (requires wallet signature; sends email). */
  async requestWalletLink(email: string): Promise<{ success: boolean; message?: string; dev?: any }> {
    const walletHeaders = await this.getWalletAuthHeaders("link_wallet");

    const resp = await fetch(`${this.indexUrl}/auth/wallet/link/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...walletHeaders },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Wallet link request failed (${resp.status}): ${text}`);
    }
    return resp.json() as any;
  }

  /** Execute an endpoint through the backend executor (requires wallet signature). */
  async executeEndpoint(endpointId: string, req: ExecuteEndpointRequest): Promise<ExecuteEndpointResult> {
    if (!endpointId) throw new Error("endpointId is required");
    const walletHeaders = await this.getWalletAuthHeaders("execute");

    const resp = await fetch(
      `${this.indexUrl}/marketplace/endpoints/${encodeURIComponent(endpointId)}/execute`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...walletHeaders },
        body: JSON.stringify(req ?? {}),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Execute failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<ExecuteEndpointResult>;
  }

  /** List all published versions for a skill (free). */
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

  /** Download a specific skill version by version hash (free for free skills; may still be gated for paid). */
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

  /** List canonical endpoints for a skill (includes endpointId required for backend execute). */
  async getSkillEndpoints(skillId: string): Promise<SkillEndpointSummary[]> {
    const resp = await fetch(
      `${this.indexUrl}/marketplace/skills/${encodeURIComponent(skillId)}/endpoints`,
      {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Get endpoints failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    return data.endpoints || [];
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
    const keypair = await keypairFromBase58PrivateKey(this.solanaPrivateKey);
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
    return signEd25519MessageBase58({
      privateKeyB58: this.solanaPrivateKey!,
      message,
    });
  }
}
