import bs58 from "bs58";
import type { Env, SkillManifest } from "../types.js";

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

type Deps = {
  loadSdk?: () => Promise<CascadeSdk>;
  loadKit?: () => Promise<SolanaKit>;
};

const PLATFORM_SHARE = 10;

function payableContributors(skill: Pick<SkillManifest, "contributors">) {
  return (skill.contributors ?? []).filter((c) => c.wallet_address?.trim());
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function cascadeLabel(skillId: string): Promise<string> {
  const digest = await sha256Hex(skillId);
  return `ubr-${digest.slice(0, 23)}`;
}

function decodeSecretKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty signer secret");
  if (trimmed.startsWith("[")) {
    return Uint8Array.from(JSON.parse(trimmed) as number[]);
  }
  return Uint8Array.from(bs58.decode(trimmed));
}

export function canProvisionCascadeSplit(env: Pick<Env, "CASCADE_PLATFORM_WALLET" | "CASCADE_SIGNER_SECRET_KEY" | "CASCADE_RPC_URL" | "CASCADE_RPC_WS_URL">): boolean {
  return !!(
    env.CASCADE_PLATFORM_WALLET?.trim()
    && env.CASCADE_SIGNER_SECRET_KEY?.trim()
    && env.CASCADE_RPC_URL?.trim()
    && env.CASCADE_RPC_WS_URL?.trim()
  );
}

export async function ensureSkillCascadeSplit(
  env: Pick<Env, "CASCADE_PLATFORM_WALLET" | "CASCADE_SIGNER_SECRET_KEY" | "CASCADE_RPC_URL" | "CASCADE_RPC_WS_URL">,
  skill: Pick<SkillManifest, "skill_id" | "contributors" | "split_config">,
  deps: Deps = {},
): Promise<{ split_config?: string; warning?: string }> {
  const contributors = payableContributors(skill);
  if (contributors.length <= 1) {
    return skill.split_config?.trim() ? { split_config: skill.split_config.trim() } : {};
  }
  if (!canProvisionCascadeSplit(env)) {
    return skill.split_config?.trim()
      ? { split_config: skill.split_config.trim(), warning: "cascade_split_not_configured" }
      : { warning: "cascade_split_not_configured" };
  }

  const loadSdk = deps.loadSdk ?? (async () => await import("@cascade-fyi/splits-sdk") as unknown as CascadeSdk);
  const loadKit = deps.loadKit ?? (async () => await import("@solana/kit") as unknown as SolanaKit);
  const [sdk, kit] = await Promise.all([loadSdk(), loadKit()]);

  const signer = await kit.createKeyPairSignerFromBytes(decodeSecretKey(env.CASCADE_SIGNER_SECRET_KEY!));
  const splits = sdk.createSplitsClient({
    rpc: kit.createSolanaRpc(env.CASCADE_RPC_URL!),
    rpcSubscriptions: kit.createSolanaRpcSubscriptions(env.CASCADE_RPC_WS_URL!),
    signer,
  });

  const recipients = [
    { address: env.CASCADE_PLATFORM_WALLET!, share: PLATFORM_SHARE },
    ...contributors.map((c) => ({ address: c.wallet_address!.trim(), share: c.share })),
  ];
  const uniqueId = sdk.labelToSeed(await cascadeLabel(skill.skill_id));
  const result = await splits.ensureSplit({ recipients, uniqueId });

  if (result.status === "created" || result.status === "updated" || result.status === "no_change") {
    return { split_config: result.splitConfig };
  }
  return { warning: result.message || `cascade_split_${result.status}` };
}
