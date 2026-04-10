# candidate sites mined — 2026-04-11 autonomous session

## sources

### r/webscraping top posts (mined via `unbrowse go` + `eval`)
- "Scraping Tripadvisor/Booking.com reviews, what's the fastest way?" → **tripadvisor.com, booking.com**
- "KDP Scraping" (Kindle Direct Publishing / Amazon book data) → **amazon.com KDP**
- "I want to use Python to find people who need lawyers" → legal directory sites
- "Monthly Self-Promotion - April 2026" (people show what they're scraping)
- "Weekly Webscrapers - Hiring, FAQs, etc" (pain points cluster here)

### smithery.ai /servers MCP registry (mined via `unbrowse go` + `eval`)
21 MCP servers on the first page — categories unbrowse could cover:
- Search: exa, brave, duckduckgo, linkup
- Finance/web3: polymarket, blockscout, coinmarketcap (implied)
- Research: semanticscholar, arxiv (already in bench), paper-search
- Data: rss-reader, context7 docs
- Social: instagram (already in bench), reddit (already in bench), slack
- Email: gmail, agentmail (auth-gated, out of scope for resolve-only bench)
- Utilities: national-weather-service (already in bench via wttr)

### github bounties for smithery
Searched `smithery-ai/mcp-registry` for open issues with "bounty" label:
**zero results**. Smithery doesn't run a public bounty program in the repo
that I could find. The gap list comes from the registry itself — anything
not in their catalog that agents ask for.

### known high-pain scraping targets (common knowledge, not mined this run)
Travel/hotels, jobs, real estate, product reviews — all have gate walls
that are easy wins or real anti-bot challenges for the bench to distinguish.

## candidates file
See `scripts/corpus/benchmark-candidates.txt` — 30 URLs covering the above
categories. Each uses realistic navigation paths (not bare homepages).

## next action
Run `bash scripts/bench-local.sh --corpus-file scripts/corpus/benchmark-candidates.txt`
to collect evidence. Read the CSV row by row. Promote passing URLs to
baseline. Leave failing ones in `.bench-learned-problems/` for review.
