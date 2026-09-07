const DEFAULT_API_ORIGIN = "https://beta-api.unbrowse.ai";

type ApiEnv = Partial<Record<"NEXT_PUBLIC_API_URL" | "NEXT_PUBLIC_API_BASE_URL" | "UNBROWSE_API_URL", string | undefined>>;

function cleanOrigin(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

export function getConfiguredApiOrigin(env: ApiEnv = process.env as ApiEnv): string {
  return cleanOrigin(env.NEXT_PUBLIC_API_URL) ??
    cleanOrigin(env.NEXT_PUBLIC_API_BASE_URL) ??
    cleanOrigin(env.UNBROWSE_API_URL) ??
    DEFAULT_API_ORIGIN;
}

export function getConfiguredApiV1Origin(env: ApiEnv = process.env as ApiEnv): string {
  const origin = getConfiguredApiOrigin(env);
  return origin.endsWith("/v1") ? origin : `${origin}/v1`;
}
