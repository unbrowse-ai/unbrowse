# Open Wallet Standard (OWS) support

Unbrowse supports the **Open Wallet Standard (OWS v1.3)** as the primary, open-standard
wallet path — an alternative to lobster.cash. OWS standardizes exactly what an agent needs:
a local encrypted wallet vault (`~/.ows/wallets/<uuid>.json`), policy-gated signing,
API-key delegated agent access, and built-in x402 payments — under an MIT spec, so it
isn't a proprietary keystore.

## Why OWS

| Need | OWS provides |
|---|---|
| Local self-custody keys | encrypted vault (`AES-256-GCM + scrypt`), CAIP-2/CAIP-10 accounts across chains |
| Safe agent delegation | API keys scoped to wallets + policies (`ows key create`), revocable |
| Guardrails | declarative policies (`allowed_chains`, `expires_at`, AND-combined) + custom executables |
| Paying for routes | `ows pay request` signs EIP-3009 USDC on a 402 and retries |

## Using OWS as your wallet

Point unbrowse at an OWS wallet and it becomes the wallet context, preferred over
lobster.cash:

```bash
# create an OWS wallet + a policy-scoped agent key (see the OWS CLI)
ows wallet create --name agent-treasury
ows key create --name claude --wallet agent-treasury --policy base-only

# unbrowse picks it up — explicitly:
export OWS_WALLET_ADDRESS=0xAbCd…           # or it auto-detects ~/.ows/wallets
```

`getWalletContext()` resolves, in order: an explicit `OWS_WALLET_ADDRESS` → a lobster/agent
env wallet → an OWS vault wallet → a local lobster config. So OWS is the primary path; the
bespoke local signer remains as a legacy fallback only.

## Policy engine

Declarative OWS policies are enforced before signing. Rules are AND-combined — every rule
must pass:

```ts
import { evaluatePolicy } from "unbrowse/payments/ows";

const policy = {
  id: "agent-limits", name: "Base only, expires EOY", action: "deny",
  rules: [
    { type: "allowed_chains", chain_ids: ["eip155:8453"] },
    { type: "expires_at", timestamp: "2026-12-31T23:59:59Z" },
  ],
};
evaluatePolicy(policy, { chainId: "eip155:1", wallet, timestamp });
// → { allow: false, reason: "chain eip155:1 not in allowlist" }
```

A `warn` policy reports the failing reason but allows the action; a `deny` policy blocks it.

## Scope

This is the OWS Core Types + the declarative policy engine + vault resolution, wired as the
preferred wallet provider. Full OWS signing/funding flows are delegated to the `ows` CLI /
SDK; unbrowse consumes the wallet identity and enforces policy at the resolve/execute seam.
