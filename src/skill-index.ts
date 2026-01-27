/**
 * Skill Index Client — Publish and search the cloud skill marketplace.
 *
 * Handles communication with the skill index API, including x402 payments
 * for downloading skills. Publishing and searching are free; downloading
 * a skill package costs $0.01 USDC via x402 on Base.
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
  private creatorWallet?: string;
  private evmPrivateKey?: string;
  private paymentFetch?: typeof fetch;

  constructor(opts: {
    indexUrl: string;
    creatorWallet?: string;
    evmPrivateKey?: string;
  }) {
    this.indexUrl = opts.indexUrl.replace(/\/$/, "");
    this.creatorWallet = opts.creatorWallet;
    this.evmPrivateKey = opts.evmPrivateKey;
  }

  /**
   * Initialize x402 payment-enabled fetch.
   * Lazily loads @x402/fetch and viem — only needed for downloads.
   */
  private async initPaymentFetch(): Promise<void> {
    if (this.paymentFetch) return;
    if (!this.evmPrivateKey) return;

    try {
      const { wrapFetchWithPayment } = await import("x402/client") as any;
      const { privateKeyToAccount } = await import("viem/accounts");

      const account = privateKeyToAccount(this.evmPrivateKey as `0x${string}`);

      this.paymentFetch = wrapFetchWithPayment(fetch, account);
    } catch (err) {
      throw new Error(
        `Failed to initialize x402 payment client: ${String(err)}. ` +
        `Ensure x402 and viem are installed.`,
      );
    }
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

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });

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
   * Uses @x402/fetch to automatically handle the 402 -> sign -> retry flow.
   * Requires evmPrivateKey to be configured.
   */
  async download(id: string): Promise<SkillPackage> {
    await this.initPaymentFetch();

    const fetchFn = this.paymentFetch;
    if (!fetchFn) {
      throw new Error(
        "No EVM private key configured for x402 payments. " +
        "Set skillIndexEvmPrivateKey in unbrowse config or UNBROWSE_EVM_PRIVATE_KEY env var.",
      );
    }

    const resp = await fetchFn(`${this.indexUrl}/skills/${encodeURIComponent(id)}/download`, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Download failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<SkillPackage>;
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
}
