# Pricing and usage

Your account's current plan, credits and returned payment requirements are authoritative. Check `unbrowse usage`, `GET /api/v1/usage`, or the signed-in [billing page](https://unbrowse.ai/app/billing). When available, the `unbrowse_credits` MCP tool returns free and paid balances and a checkout link for the user.

Verified successful runs are metered; failed, refused or input-required runs are not completed billable outcomes. Inspect the returned usage fields for your plan. A quota or credit refusal includes recovery information; do not blindly retry payments.

There is no anonymous pay-per-call: x402 was removed from the hosted API in September 2026, and every call needs an account (API key or OAuth). See [api.md](api.md).
