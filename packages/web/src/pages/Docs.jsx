import { useState } from 'react';

const FDRY_ENABLED = import.meta.env.VITE_FDRY_ENABLED === 'true';

const sections = [
  { id: 'overview', title: 'Overview' },
  { id: 'quickstart', title: 'Quick Start' },
  { id: 'how-it-works', title: 'How It Works' },
  { id: 'skill-format', title: 'Skill Format' },
  { id: 'for-agents', title: 'For AI Agents' },
  { id: 'for-creators', title: 'For Creators' },
  { id: 'contributions', title: 'Contributions' },
  ...(FDRY_ENABLED ? [{ id: 'fdry-credits', title: 'FDRY Credits' }] : []),
  { id: 'payments', title: 'Payments & Pricing' },
];

export default function Docs() {
  const [activeSection, setActiveSection] = useState('overview');

  const scrollToSection = (id) => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="docs-page">
      <aside className="docs-sidebar">
        <div className="sidebar-title">Documentation</div>
        <nav className="sidebar-nav">
          {sections.map((section) => (
            <button
              key={section.id}
              className={`sidebar-link ${activeSection === section.id ? 'active' : ''}`}
              onClick={() => scrollToSection(section.id)}
            >
              {section.title}
            </button>
          ))}
        </nav>
      </aside>

      <article className="docs-content">
        <section id="overview" className="docs-section">
          <h1>Unbrowse Documentation</h1>
          <p className="docs-lead">
            Unbrowse lets AI agents learn any website's API by watching network traffic,
            then share that knowledge as reusable skills. It's like Google for agents—an
            index of every API on the internet, discovered automatically.
          </p>

          <h2>Key Features</h2>
          <ul className="docs-list">
            <li>
              <strong>Automatic API Discovery</strong> — Agents observe network traffic and
              automatically generate skills from real interactions
            </li>
            <li>
              <strong>Open Standard</strong> — Skills follow the{' '}
              <a href="https://agentskills.io" target="_blank" rel="noopener">Agent Skills spec</a>,
              portable across agent frameworks
            </li>
            <li>
              <strong>Execution-Native Payments</strong> — Value capture happens at proxy execution time via x402 + FDRY
            </li>
            <li>
              <strong>Wallet-Based Ownership</strong> — Skills are owned by the Solana wallet that created them
            </li>
          </ul>
        </section>

        <section id="quickstart" className="docs-section">
          <h2>Quick Start</h2>
          <p>Talk to your agent naturally. Here's the workflow:</p>

          <div className="docs-steps">
            <div className="docs-step">
              <div className="step-number">1</div>
              <div className="step-content">
                <h3>Install the Extension</h3>
                <pre className="docs-code">Install @getfoundry/unbrowse-openclaw</pre>
              </div>
            </div>

            <div className="docs-step">
              <div className="step-number">2</div>
              <div className="step-content">
                <h3>Capture Any API</h3>
                <pre className="docs-code">Unbrowse reddit.com and learn its API</pre>
                <p>The agent opens a browser, captures all API traffic, and generates a skill.</p>
              </div>
            </div>

            <div className="docs-step">
              <div className="step-number">3</div>
              <div className="step-content">
                <h3>Publish & Contribute</h3>
                <pre className="docs-code">Publish reddit-api to unbrowse</pre>
                <p>Your endpoints improve index coverage and become eligible for usage rewards.</p>
              </div>
            </div>

            <div className="docs-step">
              <div className="step-number">4</div>
              <div className="step-content">
                <h3>Discover & Use Skills</h3>
                <pre className="docs-code">Find skills for posting to Twitter</pre>
                <p>Search the marketplace, then execute through backend proxy for telemetry + quality.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="docs-section">
          <h2>How It Works</h2>

          <h3>1. Agent Browses a Website</h3>
          <p>
            An AI agent with the Unbrowse extension navigates a website using a real browser.
            All network traffic (XHR/Fetch requests) is captured automatically via Chrome DevTools Protocol.
          </p>

          <h3>2. Skills Are Generated</h3>
          <p>
            Captured requests are analyzed and converted into structured skills containing:
            endpoint URLs, request/response schemas, authentication headers, and descriptions.
          </p>

          <h3>3. Published to Marketplace</h3>
          <p>
            Skills are signed with the agent's Solana wallet and published. The wallet address proves ownership
            and receives payments.
          </p>

          <h3>4. Other Agents Execute</h3>
          <p>
            When another agent needs that API, they search marketplace metadata then execute via
            backend proxy abstraction. This preserves hidden execution logic while collecting
            status/success telemetry for trust and ranking.
          </p>
        </section>

        <section id="skill-format" className="docs-section">
          <h2>Skill Format</h2>
          <p>
            Skills follow the <a href="https://agentskills.io" target="_blank" rel="noopener">
            Agent Skills open standard</a>:
          </p>

          <pre className="docs-code">{`my-skill/
├── SKILL.md          # Skill definition and metadata
├── scripts/
│   └── run.ts        # Main execution script
└── references/
    └── REFERENCE.md  # API reference details`}</pre>

          <h3>SKILL.md Example</h3>
          <pre className="docs-code">{`---
name: twitter-post-tweet
description: Posts a tweet to Twitter/X
category: social-media
auth: oauth2
---

# twitter-post-tweet

## When to Use
- Post a tweet on behalf of a user
- Share content to Twitter/X

## Input
- \`text\` (string, required): Tweet content (max 280 chars)
- \`reply_to\` (string, optional): Tweet ID to reply to

## Output
Returns the created tweet with id, text, and metadata.`}</pre>
        </section>

        <section id="for-agents" className="docs-section">
          <h2>For AI Agents</h2>

          <h3>Searching Skills</h3>
          <pre className="docs-code">{`// Natural language
"Find skills for posting to Twitter"

// Or API
GET https://index.unbrowse.ai/marketplace/skills?q=twitter`}</pre>

          <h3>Installing Skills</h3>
          <pre className="docs-code">{`// Natural language
"Install the twitter-api skill"

// Skills are saved to ~/.openclaw/skills/`}</pre>

          <h3>Using Skills</h3>
          <pre className="docs-code">{`// Natural language
"Use the twitter skill to post 'Hello world!'"

// The agent loads the skill and executes with your credentials`}</pre>
        </section>

        <section id="for-creators" className="docs-section">
          <h2>For Skill Creators</h2>

          <h3>Creating Skills</h3>
          <p>
            Skills are created automatically when an Unbrowse-enabled agent browses a website.
            Just tell your agent to "unbrowse" any site.
          </p>

          <h3>Publishing</h3>
          <pre className="docs-code">{`// Free skill (default)
"Publish my-skill to unbrowse"

// Paid skill
"Publish my-skill to unbrowse for $1.00"`}</pre>

          <h3>Updating Skills</h3>
          <p>
            Only the wallet that created a skill can update it. Re-publish with the same
            wallet to push updates.
          </p>

          <h3>Quality Score</h3>
          <p>
            Skills are automatically vetted for quality (0-100). Higher scores get better
            marketplace visibility:
          </p>
          <ul className="docs-list">
            <li><strong>90+</strong> — Featured placement</li>
            <li><strong>70+</strong> — Standard listing</li>
            <li><strong>&lt;50</strong> — May be hidden from search</li>
          </ul>
        </section>

        <section id="contributions" className="docs-section">
          <h2>Collaborative Contributions</h2>
          <p>
            Skills aren't built by a single person — they're built collectively. When multiple
            users capture traffic from the same site, each capture may discover different endpoints,
            auth patterns, or request schemas. Unbrowse automatically merges these into a single
            skill and tracks who contributed what.
          </p>

          <div className="docs-highlight">
            <h3>Auto-Contribute (Opt-Out)</h3>
            <p>
              Auto-contribute is <strong>enabled by default</strong>. When you capture a skill and have
              a wallet configured, your novel endpoints are automatically contributed to the index.
              Set <code>autoContribute: false</code> in your config to keep skills local-only.
            </p>
          </div>

          <h3>How Merging Works</h3>
          <p>
            The backend uses <strong>fingerprint-based deduplication</strong> — requests to{' '}
            <code>/users/123</code> and <code>/users/456</code> resolve to the same{' '}
            <code>GET /users/{'{id}'}</code> endpoint and aren't double-counted.
          </p>
          <pre className="docs-code">{`User A captures 5 endpoints from shopify.com
  → Skill created, User A weight = 1.0

User B captures 8 endpoints (3 overlap, 5 new)
  → 5 novel endpoints merged via fingerprint dedup
  → Weights: A = 0.62, B = 0.38

User C captures 6 endpoints (4 overlap, 2 new) + OAuth refresh
  → 2 endpoints + 1 auth discovery merged
  → Weights: A = 0.46, B = 0.28, C = 0.26`}</pre>

          <h3>Novelty Scoring</h3>
          <p>Each contribution is scored on a 0-1 weighted scale:</p>
          <ul className="docs-list">
            <li><strong>40% Endpoint novelty</strong> — New API routes (Jaccard distance on fingerprints)</li>
            <li><strong>25% Auth novelty</strong> — New auth methods (OAuth, API keys, CSRF tokens)</li>
            <li><strong>15% Schema novelty</strong> — New request body schemas</li>
            <li><strong>10% Documentation</strong> — Quality signals (placeholder)</li>
            <li><strong>10% Maintenance</strong> — Update recency (placeholder)</li>
          </ul>

          <h3>Revenue Splitting</h3>
          <p>
            Paid usage events split revenue 4 ways. For collaborative skills, one contributor is
            <strong> randomly selected weighted by contribution score</strong> per event.
          </p>
          <pre className="docs-code">{`Paid usage event
  → 33% Creator/Contributor (weighted random)
  → 30% Website Owner (DNS-verified, treasury if unclaimed)
  → 20% Platform (FDRY Treasury)
  → 17% Network (staker/airdrop sink wallet)`}</pre>
          <p>
            <strong>Website owners</strong> (e.g., Twitter, Shopify) can claim their 30% by
            verifying domain ownership via DNS TXT record. Unclaimed shares go to the FDRY
            Treasury until claimed.
          </p>
          <p>
            The 17% network share is configurable via backend env (`FDRY_STAKER_AIRDROP_WALLET`)
            and defaults to treasury until staking-airdrop wiring is finalized.
          </p>
          <p>
            Every contribution produces a <strong>proof-of-novelty hash chain</strong> (SHA-256)
            for auditability — proving exactly what was contributed and when.
          </p>

          <h3>Opting Out</h3>
          <pre className="docs-code">{`{
  "plugins": {
    "entries": {
      "unbrowse-openclaw": {
        "config": {
          "autoContribute": false
        }
      }
    }
  }
}`}</pre>
          <p>Skills are still generated locally. Only cloud publishing is disabled.</p>
        </section>

        {FDRY_ENABLED && <section id="fdry-credits" className="docs-section">
          <h2>FDRY Credits</h2>
          <p>
            FDRY is the internal credit system that powers the Unbrowse ecosystem. Contribute
            novel API endpoints and earn credits that can be spent on skill executions. No
            crypto wallet funding required — just contribute and use.
          </p>

          <div className="docs-highlight">
            <h3>The Earn/Spend Cycle</h3>
            <p>
              Contribute novel endpoints to earn FDRY. Spend FDRY to execute skills.
              <strong> 1 FDRY = 1 execution.</strong> The treasury balance is the natural
              rate limiter — when the treasury is flush, credits flow freely.
            </p>
          </div>

          <h3>How to Earn FDRY</h3>
          <div className="docs-steps">
            <div className="docs-step">
              <div className="step-number">1</div>
              <div className="step-content">
                <h3>Capture a Site</h3>
                <pre className="docs-code">Unbrowse shopify.com and learn its API</pre>
                <p>Browse any website with the Unbrowse extension active.</p>
              </div>
            </div>

            <div className="docs-step">
              <div className="step-number">2</div>
              <div className="step-content">
                <h3>Contribute Novel Endpoints</h3>
                <p>
                  When auto-contribute is enabled (default), your captured endpoints are
                  compared against the index. Novel endpoints — ones nobody has discovered
                  before — earn you FDRY instantly.
                </p>
              </div>
            </div>

            <div className="docs-step">
              <div className="step-number">3</div>
              <div className="step-content">
                <h3>Spend on Executions</h3>
                <pre className="docs-code">Use the shopify skill to check order status</pre>
                <p>Each skill execution costs 1 FDRY. Your balance decrements automatically.</p>
              </div>
            </div>
          </div>

          <h3>Credit Rules</h3>
          <ul className="docs-list">
            <li>
              <strong>Starter Grant</strong> — Earn 10 FDRY on your first useful contribution
              (at least one novel endpoint)
            </li>
            <li>
              <strong>Per-Endpoint Reward</strong> — Each novel endpoint earns FDRY based on
              the treasury's current balance and distribution rate
            </li>
            <li>
              <strong>Daily Cap</strong> — Maximum 100 FDRY per wallet per day to prevent
              abuse and ensure fair distribution
            </li>
            <li>
              <strong>Treasury-Limited</strong> — Credits are minted from the FDRY Treasury.
              When the treasury runs low, earn rates decrease naturally
            </li>
          </ul>

          <h3>Checking Your Balance</h3>
          <pre className="docs-code">{`// Via the Earnings dashboard
https://unbrowse.ai/earnings

// Via API
GET /fdry/balance/:wallet

// Response
{
  "balance": 47,
  "dailyEarned": 12,
  "dailyCap": 100,
  "totalEarned": 147,
  "contributions": 23
}`}</pre>

          <p>
            Visit the <a href="/earnings">Earnings Dashboard</a> to see your balance,
            distribution history, and leaderboard position.
          </p>
        </section>}

        <section id="payments" className="docs-section">
          <h2>Payments & Pricing</h2>

          <div className="docs-highlight">
            <h3>4-Way Revenue Split</h3>
            <div className="docs-revenue-split">
              <div className="revenue-box creator">
                <span className="revenue-pct">33%</span>
                <span className="revenue-who">Creator</span>
                <span className="revenue-detail">Direct to wallet (weighted random for collaborative)</span>
              </div>
              <div className="revenue-box creator">
                <span className="revenue-pct">30%</span>
                <span className="revenue-who">Website Owner</span>
                <span className="revenue-detail">DNS-verified claim (treasury if unclaimed)</span>
              </div>
              <div className="revenue-box treasury">
                <span className="revenue-pct">20%</span>
                <span className="revenue-who">Platform</span>
                <span className="revenue-detail">FDRY Treasury</span>
              </div>
              <div className="revenue-box treasury">
                <span className="revenue-pct">17%</span>
                <span className="revenue-who">Network</span>
                <span className="revenue-detail">Staker/Airdrop sink wallet (treasury fallback)</span>
              </div>
            </div>
          </div>
          <p>
            Website owners verify via DNS TXT record. Until verified, their 30% share accrues to
            the FDRY Treasury.
          </p>

          <h3>Pricing Posture</h3>
          <ul className="docs-list">
            <li><strong>Execution-first</strong> — Prefer charging at proxy execution layer</li>
            <li><strong>Download friction low</strong> — Optional download gating; adoption matters</li>
          </ul>

          <h3>x402 Payment Protocol</h3>
          <p>Paid proxy routes use x402 for machine-to-machine payments:</p>
          <ol className="docs-list-numbered">
            <li>Agent requests paid execution route</li>
            <li>Server returns HTTP 402 with payment details</li>
            <li>Agent signs USDC transaction on Solana</li>
            <li>Agent retries with transaction signature in header</li>
            <li>Server verifies on-chain, executes call, records telemetry</li>
          </ol>
          <p>No intermediaries. Instant settlement. Split routing is encoded in backend payment metadata.</p>

          <h3>Network Sink Wallet (Temporary)</h3>
          <pre className="docs-code">{`# Required
FDRY_TREASURY_WALLET=...

# Optional (17% network share for paid usage/download split)
FDRY_STAKER_AIRDROP_WALLET=...`}</pre>
        </section>

        <div className="docs-footer">
          <p>
            <a href="https://github.com/lekt9/unbrowse-openclaw" target="_blank" rel="noopener">
              GitHub
            </a>
            {' · '}
            <a href="https://agentskills.io" target="_blank" rel="noopener">
              Agent Skills Spec
            </a>
            {' · '}
            <a href="https://x.com/getFoundry" target="_blank" rel="noopener">
              @getFoundry
            </a>
          </p>
        </div>
      </article>
    </div>
  );
}
