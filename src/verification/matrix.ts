export interface IntegrationCheck {
  host: string;
  capability: string;
  status: "pass" | "fail" | "skip" | "untested";
  last_verified?: string;
}

export type VerificationMatrix = IntegrationCheck[];

export function computeVerificationCoverage(matrix: VerificationMatrix): number {
  if (matrix.length === 0) return 0;
  const tested = matrix.filter((c) => c.status !== "untested").length;
  return tested / matrix.length;
}

export const INITIAL_MATRIX: VerificationMatrix = [
  { host: "openclaw", capability: "capture", status: "pass", last_verified: "2026-03-31" },
  { host: "openclaw", capability: "execute", status: "pass", last_verified: "2026-03-31" },
  { host: "openclaw", capability: "search", status: "pass", last_verified: "2026-03-31" },
  { host: "mcp", capability: "execute", status: "pass", last_verified: "2026-03-31" },
  { host: "mcp", capability: "search", status: "pass", last_verified: "2026-03-31" },
  { host: "cli", capability: "capture", status: "pass", last_verified: "2026-03-31" },
  { host: "cli", capability: "execute", status: "pass", last_verified: "2026-03-31" },
  { host: "cli", capability: "search", status: "pass", last_verified: "2026-03-31" },
  { host: "cli", capability: "publish", status: "pass", last_verified: "2026-03-31" },
  { host: "hermes", capability: "execute", status: "untested" },
  { host: "elizaos", capability: "execute", status: "untested" },
  { host: "langchain", capability: "execute", status: "untested" },
  { host: "langchain", capability: "search", status: "untested" },
];
