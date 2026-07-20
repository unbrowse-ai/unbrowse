# Paper vs Product Status

This page separates the research thesis from Unbrowse 11.1.1.

| Area | Status | Current product truth |
| --- | --- | --- |
| Shared marketplace of learned skills | Shipped | Skills can be discovered, resolved, executed, and reused. |
| Local cache, shared discovery, browser fallback | Shipped | Resolution prefers reusable routes and captures once on a miss. |
| Reliability, freshness, and verification scoring | Shipped | These signals affect route health and ranking. |
| Local credential vault | Shipped | User credentials stay local and are referenced by auth profiles. |
| CLI, SDK, and MCP integrations | Shipped | The public surfaces use the current flat command model. |
| Account credits | Shipped | Granted and earned credits fund metered usage; consumption is recorded in the account ledger. |
| Credit redemption | Planned | Earned credits are recorded now and will become redeemable later. |
| Full graph-backed planning | Partial | Graph primitives exist, but direct intent resolution is the primary product surface. |
| Rich contributor attribution | Planned | Current credits support a simpler earned-credit model. |
| Independent validation market and advanced attestations | Research | These are not current product promises. |

## How to Read the Paper

Treat the route-discovery, reuse, reliability, and evaluation work as the durable technical thesis. Treat research-era economic designs as historical context. The current commercial contract is deliberately simpler: authenticate with an API key, use account credits, and inspect the ledger through the account APIs.
