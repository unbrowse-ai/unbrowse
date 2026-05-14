/**
 * Flex onboarding gate (Day 3 seed, v6.16.0).
 *
 * Pure decision function. Day 4 wires it into priced routes so the agent gets
 * a 402 + X-Flex-Onboarding-Required header when its AgentProfile is missing
 * any of the three Flex fields.
 */

export interface FlexOnboardingStatus {
  ready: boolean;
  missing: Array<"wallet_address" | "flex_escrow_address" | "flex_session_key_address">;
}

export function checkFlexOnboarding(profile: {
  wallet_address?: string;
  flex_escrow_address?: string;
  flex_session_key_address?: string;
}): FlexOnboardingStatus {
  const missing: FlexOnboardingStatus["missing"] = [];
  if (!profile.wallet_address?.trim()) missing.push("wallet_address");
  if (!profile.flex_escrow_address?.trim()) missing.push("flex_escrow_address");
  if (!profile.flex_session_key_address?.trim()) missing.push("flex_session_key_address");
  return { ready: missing.length === 0, missing };
}

/**
 * Day 3: pure decision function. Day 4 wires it into priced routes.
 * Emits the 402 + X-Flex-Onboarding-Required header structure for the caller.
 */
export function buildFlexOnboardingRequired402(missing: FlexOnboardingStatus["missing"]): {
  status: 402;
  headers: Record<string, string>;
  body: { error: string; missing: typeof missing; remediation: string };
} {
  return {
    status: 402,
    headers: { "X-Flex-Onboarding-Required": "1", "X-Flex-Missing": missing.join(",") },
    body: {
      error: "flex_onboarding_incomplete",
      missing,
      remediation: "Run `unbrowse setup` or pair via /account",
    },
  };
}
