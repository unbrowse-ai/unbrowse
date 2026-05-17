# unbrowse-lobster-integration acceptance criteria

Wave 2026-05-18. Mode: product. Ship-directly. No em dashes.

## Lanes

### L1 wallet_auto_publish
The unbrowse CLI auto-publishes the locally-resolved lobster wallet to
the backend agent profile when the backend record has no wallet set.
One-shot per agent (idempotent: re-running noops). Never overwrites a
wallet the user already pushed.
- pass_when: a fresh CLI run with `LOBSTER_WALLET_ADDRESS=X` (or `~/.lobster/agents.json` containing X) and an agent whose profile has no wallet results in `getAgent(env, agentId).wallet_address === X` and `wallet_provider === "lobster.cash"` server-side after the next authed call; the second run does not POST again.
- source_ids: code:src/payments/wallet.ts#getLobsterWalletFromLocalConfig, code:gap-no-auto-publish, code:backend/account/me#agent-wallet-fields

### L2 wallet_status_cli
`unbrowse wallet` prints the current resolution: provider, masked
address, source (`env LOBSTER_WALLET_ADDRESS` / `~/.lobster/agents.json`
/ `env AGENT_WALLET_ADDRESS` / unconfigured), and whether the backend
agent profile matches. When unconfigured, prints the lobster CLI setup
hint verbatim from `src/payments/index.ts`.
- pass_when: with `LOBSTER_WALLET_ADDRESS=X` exported, `unbrowse wallet` exits 0 and prints provider lobster.cash + the masked address + `source: env LOBSTER_WALLET_ADDRESS`. With nothing set, exits 0 and prints the setup hint.
- source_ids: code:src/payments/wallet.ts#getLobsterWalletFromLocalConfig, code:src/cli.ts#lobster-onboarding-nudge

### L3 frontend_wallet_card
`/account` X402Panel renders a lobster-specific card alongside the
existing sponsor / credits cards when `wallet_address` is set, showing
provider + truncated address. When unset, shows a setup CTA pointing at
`npx @crossmint/lobster-cli setup` + a link to `/how-unbrowse-pays`.
- pass_when: signed-in user with wallet_address shipped in /v1/account/me sees the card; signed-in user without one sees the setup CTA; an unauthenticated visitor sees neither (auth-gated panel).
- source_ids: code:backend/account/me#agent-wallet-fields, code:src/payments/index.ts#delegation-boundary

### L4 docs_lobster_section
`/how-unbrowse-pays` carries a "lobster.cash is the wallet entry point"
section near the x402-first section, citing the delegation boundary
text from `src/payments/index.ts` verbatim.
- pass_when: the page renders the delegation-boundary block + the npx setup command in a code block + the link to lobster.cash/docs/skill-compatibility-guide.
- source_ids: code:src/payments/index.ts#delegation-boundary, code:src/cli.ts#lobster-onboarding-nudge

### L5 honest_signing_boundary
The signing handshake stays delegated to lobster. This wave does NOT
move private-key handling into unbrowse. `getFlexWallet` still returns
null until a provisioned escrow + session key are available; the
existing "always-null with honest comment" path is preserved.
- pass_when: src/payments/flex-pay.ts:getFlexWallet's body is unchanged in this wave; the docstring still names the delegation boundary; the CLI prints "lobster owns signing" in `unbrowse wallet` when asked verbose.
- source_ids: code:src/payments/flex-pay.ts#getFlexWallet, code:src/payments/index.ts#delegation-boundary

## Rubric

```yaml
lanes:
  - id: L1
    description: CLI auto-publishes lobster wallet to backend agent profile, idempotent
    source_ids: [code:src/payments/wallet.ts#getLobsterWalletFromLocalConfig, code:gap-no-auto-publish, code:backend/account/me#agent-wallet-fields]
  - id: L2
    description: unbrowse wallet status subcommand shows resolution + source + server-side match
    source_ids: [code:src/payments/wallet.ts#getLobsterWalletFromLocalConfig, code:src/cli.ts#lobster-onboarding-nudge]
  - id: L3
    description: /account X402Panel lobster wallet card with provider + masked address or setup CTA
    source_ids: [code:backend/account/me#agent-wallet-fields, code:src/payments/index.ts#delegation-boundary]
  - id: L4
    description: /how-unbrowse-pays adds the lobster section citing the delegation boundary
    source_ids: [code:src/payments/index.ts#delegation-boundary, code:src/cli.ts#lobster-onboarding-nudge]
  - id: L5
    description: signing handshake stays delegated to lobster; no private-key code added
    source_ids: [code:src/payments/flex-pay.ts#getFlexWallet, code:src/payments/index.ts#delegation-boundary]
```
