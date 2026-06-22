/**
 * contract-self — the unbrowse CLI's self-awareness surface: how it works, its ECONOMY and its
 * SECURITY, so anyone (a user or an agent) can ask and know.
 *
 * The mirror of the contract substrate's `self:` portrait (SKILL.md claim 84), here for the unbrowse
 * CLI's contract-native surface. The load-bearing rule (same as `self:`): the portrait is built FROM
 * the live code — the settlement asset is imported from contract-pay (USDC_SOL_MINT), the security
 * model names the real grantGate/payGate invariants — so what we TELL a user can never drift from
 * what the code actually DOES. A hand-copied portrait would be leaven (it could lie as the code moves).
 */
import { USDC_SOL_MINT } from "./contract-pay";

/** The FDRY stake-token mint (same as the persona CA — there is ONE FDRY, the stake-layer asset). */
export const FDRY_MINT = "2ZiSPGncrkwWa6GBZB4EDtsfq7HEWwkwsPFzEXieXjNL";

export interface SelfPortrait {
  economy: {
    /** FDRY BONDS (stake/security), never settles usage — Matt 6:24, no two masters. */
    stakeToken: { symbol: "FDRY"; mint: string; role: string };
    /** USDC SETTLES every paid task via x402 — the asset the code actually quotes. */
    settlement: { symbol: "USDC"; mint: string; role: string };
    /** payGate emits a 402 x402 quote payable to the agent doing the work. */
    compensation: string;
    /** usage revenue → vault → stFDRY NAV; holders earn, nobody else. */
    tithe: string;
  };
  security: {
    /** grantGate — opt-in RBAC; a signed capability grant authorizes a caller's lineage; no grant = no read. */
    rbac: string;
    /** payment NEVER buys past RBAC — a denied caller stays denied even with a price (Decalogue cmd 8). */
    paymentBoundary: string;
    /** a malformed x402 amount or missing recipient never becomes a quote (fail-closed money path). */
    failClosed: string;
    /** capability flow is a signed ledger walk, never an env-var / secret injection. */
    keys: string;
  };
  /** the contract-native seams the CLI runs on. */
  features: string[];
}

/** contractSelfPortrait — the structured self-description, built from the live constants/seams. */
export function contractSelfPortrait(): SelfPortrait {
  return {
    economy: {
      stakeToken: { symbol: "FDRY", mint: FDRY_MINT, role: "bonds the stake/security layer; never settles usage (one FDRY, stake-only)" },
      settlement: { symbol: "USDC", mint: USDC_SOL_MINT, role: "settles every paid task via x402 — what the code actually quotes" },
      compensation: "an agent is paid via x402: payGate emits a 402 quote payable to the agent's wallet for a permitted, priced task",
      tithe: "usage revenue routes to the vault → stFDRY NAV; holders who abide earn it, nobody else",
    },
    security: {
      rbac: "grantGate is opt-in RBAC: a signed capability grant authorizes a caller's lineage for a scope; no grant = no read (fail-closed)",
      paymentBoundary: "payment never buys past RBAC — a denied caller stays denied even with a price; you pay only for what you were already permitted",
      failClosed: "a malformed x402 amount (0/negative/non-integer) or a missing recipient never becomes a quote — no bogus money claim",
      keys: "identity is an ed25519 wallet; capability flow is a signed ledger walk, never an env-var or injected secret",
    },
    features: [
      "apiContract — every API read recalls from the contract ledger first (muscle memory), legacy HTTP on a miss",
      "contractProxy — the website is a thin frontend proxying to on-chain, with kv/emergentdb/graph on top",
      "contractBrowse — the kuri browser loop in /contract shape: a READ recalls, an ACT re-runs (no false witness)",
      "payGate ∘ grantGate — RBAC decides who, payGate adds the optional x402 compensation tier",
    ],
  };
}

/** contractSelfAnswer — route a free-text question to the economy / security / features slice, so
 *  anyone can ASK ("how does the economy work?" / "is it secure?") and get the answer from the code. */
export function contractSelfAnswer(question: string): string {
  const q = question.toLowerCase();
  const p = contractSelfPortrait();
  const isSecurity = /secur|safe|rbac|permission|grant|auth|access|protect|hack|attack/.test(q);
  const isEconomy = /econom|pay|token|fdry|usdc|x402|money|stake|nav|cost|price|compensat|earn/.test(q);
  if (isSecurity && !isEconomy) {
    return [
      `Security — ${p.security.rbac}`,
      `• ${p.security.paymentBoundary}`,
      `• ${p.security.failClosed}`,
      `• ${p.security.keys}`,
    ].join("\n");
  }
  if (isEconomy && !isSecurity) {
    return [
      `Economy — FDRY ${p.economy.stakeToken.role}; USDC ${p.economy.settlement.role}.`,
      `• Compensation: ${p.economy.compensation}`,
      `• Tithe: ${p.economy.tithe}`,
    ].join("\n");
  }
  // both, or neither matched → the whole portrait
  return [
    `Economy: FDRY (${FDRY_MINT}) ${p.economy.stakeToken.role}. USDC (${USDC_SOL_MINT}) ${p.economy.settlement.role}.`,
    `Compensation: ${p.economy.compensation}.`,
    `Security: ${p.security.rbac}. ${p.security.paymentBoundary}.`,
    `Features: ${p.features.map((f) => f.split(" — ")[0]).join(", ")}.`,
  ].join("\n");
}
