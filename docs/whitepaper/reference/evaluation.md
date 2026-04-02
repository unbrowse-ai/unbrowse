# Evaluation

Benchmark results from the paper "Internal APIs Are All You Need," with context on methodology, findings, and threats to validity.

---

## Setup

The benchmark evaluates Unbrowse against Playwright-based browser automation across 94 public domains. All measurements were taken on a single machine under consistent conditions:

- **Hardware**: Apple M4 Max MacBook Pro
- **Location**: Singapore
- **Task type**: WebArena-style information retrieval -- each task requests a specific piece of structured data from a target website
- **Comparison baseline**: Playwright with standard browser automation patterns (navigate, wait for selector, extract text)
- **Domains tested**: 94, spanning government (12), SaaS (18), e-commerce (14), healthcare (8), finance (11), media (15), social (7), and other (9)

Each domain was tested with a warmed cache (skill already installed and route cached) and measured for cold-start discovery time on first encounter.

## Warmed Cache Results

With skills pre-installed and routes cached from prior execution:

| Metric | Unbrowse | Playwright | Speedup |
|---|---|---|---|
| **Mean latency** | 950ms | 3,404ms | 3.6x |
| **Median latency** | -- | -- | 5.4x |

- **18 domains** completed in under 100ms, indicating a route cache hit with no network overhead beyond the single API call
- **Fastest domain**: 79ms (Unbrowse) vs. 2,289ms (Playwright) -- a **30x speedup**
- The speedup is most pronounced on sites with simple, well-structured APIs and least pronounced on sites requiring authentication flows or multi-step endpoint chains

The 3.6x mean speedup understates the typical experience because a small number of slow domains pull the mean up. The 5.4x median speedup better represents the common case.

## Cold-Start Discovery

When encountering a domain for the first time with no cached skill:

| Metric | Value |
|---|---|
| **Median** | 8.2 seconds |
| **Mean** | 12.4 seconds |
| **90th percentile** | 22 seconds |

Cold-start includes the full pipeline: launching Kuri, navigating to the page, waiting for network traffic, extracting endpoints, inferring schemas, generating descriptions, and building the operation graph. The high variance (mean significantly above median) is driven by sites with complex authentication flows or aggressive anti-bot measures that require retries.

**Breakeven point**: the cached route advantage pays back the cold-start investment after **3-5 uses** of the same domain. After breakeven, every subsequent use accumulates savings.

## Cost Reduction

After the initial Tier 1 skill install (one-time cold-start cost), subsequent executions show a **90-96% cost reduction** compared to browser-based automation. This accounts for:

- Eliminated browser launch and rendering costs
- No DOM parsing or selector maintenance
- Reduced compute (a single HTTP request vs. a full browser session)
- Lower latency translating directly to lower token costs for LLM-driven agents (less time waiting = fewer polling cycles)

## Domain Coverage

The 94 benchmark domains were selected to represent the diversity of the public web:

| Category | Count | Examples |
|---|---|---|
| Government | 12 | Public data portals, regulatory sites |
| SaaS | 18 | Productivity tools, developer platforms |
| E-commerce | 14 | Retail, marketplace, product search |
| Healthcare | 8 | Provider directories, drug databases |
| Finance | 11 | Market data, banking portals |
| Media | 15 | News sites, content platforms |
| Social | 7 | Forums, social networks |
| Other | 9 | Utilities, reference, miscellaneous |

Performance varied significantly by category. Government and data portal sites showed the largest speedups (many serve clean JSON APIs). Social media sites showed the smallest gains due to complex authentication, rate limiting, and GraphQL endpoints with large POST bodies.

## Threats to Validity

The benchmark results should be interpreted with the following caveats:

**Benchmark bias toward permissive sites.** The 94 domains were selected from sites where endpoint discovery succeeds reliably. Sites with aggressive anti-bot measures, CAPTCHAs, or client-side rendering that defeats traffic capture are underrepresented. The benchmark does not claim coverage of the entire web -- it measures performance on the portion of the web where the approach works.

**Geographic latency dependence.** All measurements were taken from Singapore. API call latency depends on the geographic distance between the client and the target server. Users in different regions will see different absolute numbers, though the relative speedup over Playwright should hold because both approaches share the same geographic penalty.

**Anti-bot evasion is not always reliable.** Kuri's stealth extensions defeat most fingerprinting, but some sites (notably Cloudflare-protected sites with JavaScript challenges) intermittently block headless browsers. The benchmark excludes domains where cold-start discovery failed more than 50% of the time, which biases results toward successful cases.

**Single-machine, single-run measurements.** Results represent a single evaluation run, not a statistical distribution across multiple machines and network conditions. Variance from network jitter, server load, and browser startup time is present but not characterized.

**Task simplicity.** The benchmark uses information retrieval tasks (fetch a specific piece of data). More complex tasks requiring multi-step endpoint chains, form submission, or stateful workflows are not measured. The operation graph is designed for these cases but is not yet used in automated execution.
