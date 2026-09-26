# Pricing and usage

Your account's current plan, credits and returned payment requirements are authoritative. Check `unbrowse usage`, `GET /api/v1/usage`, or the signed-in [billing page](https://unbrowse.ai/app/billing). When available, the `unbrowse.credits` MCP tool returns free and paid balances and a checkout link for the user.

Verified successful runs are metered; failed, refused or input-required runs are not completed billable outcomes. Inspect the returned usage fields for your plan. A quota or credit refusal includes recovery information; do not blindly retry payments.

Anonymous pay-per-call requests can use x402 when offered by the endpoint. Read its current `402` payment requirements rather than assuming a fixed price. The CLI and SDK do not sign payments: use an x402-capable client. See [api.md](api.md).
