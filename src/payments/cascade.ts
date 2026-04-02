import { createHash } from "crypto";
import bs58 from "bs58";
import type { SkillManifest } from "../types/index.js";

type Contributor = NonNullable<SkillManifest["contributors"]>[number];

type CascadeSdk = {
  createSplitsClient(args: {
    rpc: unknown;
    rpcSubscriptions: unknown;
    signer: unknown;
  }): {
    ensureSplit(args: {
      recipients: Array<{ address: string; share: number }>;
      uniqueId?: unknown;
    }): Promise<{
      status: "created" | "updated" | "no_change" | "blocked" | "failed";
      splitConfig?: string;
      message?: string;
      reason?: string;
    }>;
  };
  labelToSeed(label: string): unknown;
};

type SolanaKit = {
  createSolanaRpc(url: string): unknown;
  createSolanaRpcSubscriptions(url: string): unknown;
  createKeyPairSignerFromBytes(secretKey: Uint8Array): Promise<unknown>;
};

type CascadeDeps = {
  loadSdk?: () => Promise<CascadeSdk>;
  loadKit?: () => Promise<SolanaKit>;
  env?: Record<string, string | undefined>;
};

export type CascadeProvisionResult = {
  split_config?: string;
  warning?: string;
  source?: "env" | "sdk" | "existing";
};

function payableContributors(skill: Pick<SkillManifest, "contributors">): Contributor[] {
  return (skill.contributors ?? []).filter((c): c is Contributor => !!c.wallet_address?.trim());
}

function cascadeLabel(skillId: string): string {
  const digest = createHash("sha256").update(skillId).digest("hex");
  return `ubr-${digest.slice(0, 23)}`;
}

function decodeSecretKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty signer secret");

  if (trimmed.startsWith("[")) {
    return Uint8Array.from(JSON.parse(trimmed) as number[]);
  }

  if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) {
    return Uint8Array.from(bs58.decode(trimmed));
  }

  return Uint8Array.from(Buffer.from(trimmed, "base64"));
}

function recipientsForSkill(
  skill: Pick<SkillManifest, "contributors">,
  platformWallet: string,
): Array<{ address: string; share: number }> {
  return [
    { address: platformWallet, share: 10 },
    ...payableContributors(skill).map((c) => ({
      address: c.wallet_address!.trim(),
      share: c.share,
    })),
  ];
}

export async function ensureCascadeSplitForSkill(
  skill: Pick<SkillManifest, "skill_id" | "contributors" | "split_config">,
  deps: CascadeDeps = {},
): Promise<CascadeProvisionResult> {
  const env = deps.env ?? process.env;
  if (skill.split_config?.trim()) {
    return { split_config: skill.split_config.trim(), source: "existing" };
  }

  const contributors = payableContributors(skill);
  if (contributors.length <= 1) return {};

  const explicitSplitConfig = env.UNBROWSE_CASCADE_SPLIT_ADDRESS?.trim()
    || env.UNBROWSE_CASCADE_SPLIT_CONFIG?.trim();
  if (explicitSplitConfig) {
    return { split_config: explicitSplitConfig, source: "env" };
  }

  const platformWallet = env.UNBROWSE_CASCADE_PLATFORM_WALLET?.trim()
    || env.PAYMENT_RECIPIENT?.trim();
  const secretKey = env.UNBROWSE_CASCADE_SIGNER_SECRET_KEY?.trim();
  const rpcUrl = env.UNBROWSE_CASCADE_RPC_URL?.trim();
  const rpcWsUrl = env.UNBROWSE_CASCADE_RPC_WS_URL?.trim();

  if (!platformWallet || !secretKey || !rpcUrl || !rpcWsUrl) {
    return {
      warning: "cascade_split_not_configured",
    };
  }

  const loadSdk = deps.loadSdk ?? (async () => await import("@cascade-fyi/splits-sdk") as unknown as CascadeSdk);
  const loadKit = deps.loadKit ?? (async () => await import("@solana/kit") as unknown as SolanaKit);
  const [sdk, kit] = await Promise.all([loadSdk(), loadKit()]);

  const signer = await kit.createKeyPairSignerFromBytes(decodeSecretKey(secretKey));
  const splits = sdk.createSplitsClient({
    rpc: kit.createSolanaRpc(rpcUrl),
    rpcSubscriptions: kit.createSolanaRpcSubscriptions(rpcWsUrl),
    signer,
  });

  const result = await splits.ensureSplit({
    recipients: recipientsForSkill(skill, platformWallet),
    uniqueId: sdk.labelToSeed(cascadeLabel(skill.skill_id)),
  });

  if (result.status === "created" || result.status === "updated" || result.status === "no_change") {
    return {
      split_config: result.splitConfig,
      source: "sdk",
    };
  }

  return {
    warning: result.message || `cascade_split_${result.status}`,
  };
}
