import { getConfiguredApiOrigin } from "@/lib/api-base";

export function resolveApiUrl(): string {
  return getConfiguredApiOrigin();
}
