# Coming Soon

Capabilities described in the paper that are on the implementation roadmap but not yet shipped.

---

## Route Economy with x402 Micropayments

The paper describes a payment layer where agents pay per-route-use via the x402 protocol -- HTTP 402 responses carrying USDC payment instructions on Solana. When an agent requests a cached route, the marketplace returns a payment-required response; the agent's wallet signs the transaction; the route is unlocked. This creates a self-sustaining economy where route contributors earn revenue proportional to usage.

Currently, all marketplace access is free. The payment infrastructure -- wallet integration, transaction signing, fee metering, and settlement -- is the primary roadmap item for enabling the economic model described in the paper.

## Delta-Based Contributor Attribution

When multiple users contribute to the same domain's skill -- discovering new endpoints, updating schemas, adding auth methods -- each contribution is measured by the delta it introduces. Schema diffs quantify structural changes. Cosine dissimilarity between pre- and post-contribution endpoint embeddings measures semantic novelty.

The attribution data determines how route fees are split: 70% to contributors (weighted by delta size) and 30% to infrastructure. Schema diffs are already computed during skill merges. The remaining work is connecting attribution scores to the payment system and building a contributor dashboard.

## Dynamic Route Pricing

Route fees will adjust based on demand. High-traffic routes command higher prices (reflecting their value to the network), while low-traffic routes are cheaper (encouraging exploration of the long tail). Pricing follows a supply-demand curve where the base fee is modulated by request volume over trailing time windows.

## TEE Attestation for Credential Isolation

The paper proposes using Trusted Execution Environments to isolate credential handling. API keys, session tokens, and cookies would be decrypted and used only inside a TEE enclave, never exposed to the skill execution layer or the marketplace. This provides hardware-backed guarantees that credentials cannot be exfiltrated, even if the execution environment is compromised.

Current credential storage uses an encrypted local vault and the system keychain. TEE support requires integration with platform-specific enclaves (Apple Secure Enclave, Intel SGX, or ARM TrustZone) and a remote attestation protocol for verifying enclave integrity.

## Multi-Step Operation Graph Planning

The operation graph (DAG of endpoint dependencies) is already built during skill enrichment. The next step is using it for automated multi-step execution: given a user intent that requires chaining multiple endpoints, the system would traverse the graph, identify the required endpoint sequence, bind intermediate outputs to downstream inputs, and execute the chain without human intervention.

For example, resolving "get the top post from r/singularity and all its comments" would require: (1) search for the subreddit, (2) fetch the subreddit's top posts, (3) extract the first post's ID, (4) fetch comments for that post ID. The operation graph already encodes these dependencies; the execution planner that walks the graph is the missing piece.

## robots.txt Compliance Layer

A compliance layer that checks robots.txt directives before capturing traffic or executing endpoints against a domain. Routes discovered on paths disallowed by robots.txt would be flagged and optionally excluded from the marketplace. This addresses the ethical dimension of automated API discovery on sites that explicitly restrict crawling.

## Session Persistence Across Agent Restarts

Browse sessions are currently ephemeral -- they exist only for the lifetime of the Kuri process. Session persistence would serialize the full session state (cookies, auth tokens, page context, captured traffic, pending operations) to disk, allowing a new agent instance to resume exactly where the previous one left off. This is critical for long-running agent workflows that may be interrupted by timeouts, crashes, or deliberate pauses.
