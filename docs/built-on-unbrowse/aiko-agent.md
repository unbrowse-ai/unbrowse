# Aiko: The Reference Consumer Agent

[aiko.unbrowse.ai](https://aiko.unbrowse.ai)

Aiko is a personal AI agent for people who do not want to learn how agents work. It is the clearest demonstration of what Unbrowse enables one layer up.

## The belief

The problem was never AI. The problem was making normal people become developers first. Every "agent" tool asks you to set things up before it can help. Aiko's bet is the opposite: you say what you need in plain language, and it handles the setup, the tools, the memory, and the payment invisibly.

## What it is

* **A personal agent on your Mac.** It runs locally and is screen-aware, positioned next to your context rather than uploading it.
* **It remembers.** Persistent memory across sessions, so you do not re-explain yourself every time.
* **It picks up new abilities as needed.** Capabilities grow on demand instead of being pre-configured by the user.
* **It pays for the paid stuff.** Metered payment over x402 means no developer keys and no plugin wiring for the user.
* **Web tasks are fast because of Unbrowse.** Aiko routes web work through Unbrowse, so it skips spinning up a browser and calls the interface behind the page directly. Browser agents wait for the page to paint; Aiko usually does not.

## How Aiko is bound to Unbrowse

Aiko runs as the parent agent runtime in `aiko-engine3`; Unbrowse runs as the child internet executor. The binding is native but pointer-only: Aiko receives tool affordances, typed pointers, wallet proofs, and receipts. It does not receive Unbrowse's raw secrets or private route-engine internals.

The current binding is declared in `src/values/aiko-unbrowse-binding.ts` and projected through the machine-readable bridge manifest at `GET /v1/contract/surface`:

* **Parent:** `/Users/lekt9/Projects/unbrowse-ecosystem/aiko-engine3`, speaking the `aiko --json` protocol.
* **Child:** the stateless `unbrowse` binary, using `resolve`, `execute`, `search`, and account sponsor status.
* **On-chain accessibility:** fresh route resolutions mirror through `cachedResolution -> mirrorResolutionToChain -> IQ Solana table` when the IQ environment is configured.
* **Wallet-gated values:** private fills are represented as `iqseal:<txSig>` pointers, revealed only by the bound wallet.
* **Deploy receipts:** Unbrowse deploys are recorded by `recordDeploy` as `/contract` rows in the `ubz-deploys` namespace.
* **Seeded indexing:** new clients can start from sponsor-status or credit-budget funding, so first indexing work can be paid for without making the user wire provider accounts.

## In-app demo shape

The Aiko page now shows the actual handoff:

1. A user asks Aiko for a web outcome.
2. Aiko resolves the intent through Unbrowse, executes the chosen route, and pauses before irreversible actions like pay, send, or book.
3. The resulting route pointer, sealed values, and deploy/index receipts are accessible through the on-chain `/contract` surface when configured, with local cache fallback when not.

## Why this matters for Unbrowse

Aiko is the existence proof for the Unbrowse thesis at the consumer edge. If a non-technical user can hand a web task to an agent and get a result in plain language, with no browser theater and no key management, then the layer underneath (shared route lookup, reuse, accountable maintenance) is doing exactly the job it was designed for. Aiko surfaces the outcome; Unbrowse is the execution substrate that makes the outcome cheap and fast.

## Where to go

* Try it: [aiko.unbrowse.ai](https://aiko.unbrowse.ai)
* Build the same execution layer into your own product: [For Developers](../for-developers/integration-surfaces.md)
* Understand the layer underneath: [Where This Goes](../vision.md)
