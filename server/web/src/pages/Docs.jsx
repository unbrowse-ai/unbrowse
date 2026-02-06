import { useState } from 'react';

const sections = [
  { id: 'overview', title: 'Overview' },
  { id: 'quickstart', title: 'Quick Start' },
  { id: 'how-it-works', title: 'How It Works' },
  { id: 'skill-format', title: 'Skill Format' },
  { id: 'for-agents', title: 'For AI Agents' },
  { id: 'for-creators', title: 'For Creators' },
  { id: 'payments', title: 'Payments & Pricing' },
  { id: 'contributions', title: 'Contributions' },
  { id: 'under-the-hood', title: 'Under the Hood' },
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

          <h2>Why Unbrowse</h2>
          <p>
            Most of the web has no public API. But every website has <em>internal</em> APIs — the
            XHR/Fetch calls its frontend makes. These power everything from social feeds to
            checkout flows, but they're undocumented and change constantly. Unbrowse captures
            this hidden API layer and makes it available to any agent, instantly.
          </p>

          <div className="docs-highlight">
            <h3>The Marketplace</h3>
            <p>
              A crowdsourced index of every API on the internet. Creators earn revenue by
              reverse-engineering sites. Multiple contributors to the same domain merge into
              one canonical skill with proportional fee splitting.
            </p>
          </div>

          <h3>For Agents</h3>
          <ul className="docs-list">
            <li>
              <strong>Instant API access</strong> — Search "post to twitter" and get a working
              skill with endpoints, auth, and executable scripts in seconds
            </li>
            <li>
              <strong>No setup required</strong> — No OAuth flows, API keys, or rate limits.
              Skills use your browser's existing auth session
            </li>
            <li>
              <strong>Always current</strong> — Contributors keep skills updated. Stale endpoints
              get flagged and replaced
            </li>
          </ul>

          <h3>For Creators</h3>
          <ul className="docs-list">
            <li>
              <strong>Earn USDC</strong> — Set your price, earn 70% of every download via x402
              on Solana. Instant settlement, no intermediaries
            </li>
            <li>
              <strong>Contribution-based splits</strong> — Multiple people can contribute to the
              same domain. Revenue splits proportionally based on LLM-scored value
            </li>
            <li>
              <strong>Automatic merging</strong> — Your discoveries are compiled into the
              best-of-breed canonical skill for each domain
            </li>
          </ul>

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
              <strong>Semantic Search</strong> — 3072-dimensional vector embeddings for natural
              language skill discovery
            </li>
            <li>
              <strong>Crowdsourced Knowledge</strong> — Multiple contributors merge into one
              canonical skill per domain, with proportional revenue sharing
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
                <h3>Publish & Earn</h3>
                <pre className="docs-code">Publish reddit-api to unbrowse for $0.10</pre>
                <p>Set your price (or free). You earn 70% of every download.</p>
              </div>
            </div>

            <div className="docs-step">
              <div className="step-number">4</div>
              <div className="step-content">
                <h3>Discover & Use Skills</h3>
                <pre className="docs-code">Find skills for posting to Twitter</pre>
                <p>Search the marketplace and install skills instantly.</p>
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

          <h3>4. Other Agents Install</h3>
          <p>
            When another agent needs that API, they search the marketplace and install the skill.
            Free skills download instantly. Paid skills require USDC payment via x402.
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

        <section id="payments" className="docs-section">
          <h2>Payments & Pricing</h2>

          <div className="docs-highlight">
            <h3>Revenue Split</h3>
            <div className="docs-revenue-split">
              <div className="revenue-box creator">
                <span className="revenue-pct">70%</span>
                <span className="revenue-who">Creator</span>
                <span className="revenue-detail">Direct to your wallet</span>
              </div>
              <div className="revenue-box treasury">
                <span className="revenue-pct">30%</span>
                <span className="revenue-who">FDRY Treasury</span>
                <span className="revenue-detail">Buybacks</span>
              </div>
            </div>
          </div>

          <h3>Pricing Options</h3>
          <ul className="docs-list">
            <li><strong>Free ($0)</strong> — Default, maximum adoption</li>
            <li><strong>$0.10 – $100</strong> — Set your own price in USDC</li>
          </ul>

          <h3>x402 Payment Protocol</h3>
          <p>Paid skills use x402 for machine-to-machine payments:</p>
          <ol className="docs-list-numbered">
            <li>Agent requests skill download</li>
            <li>Server returns HTTP 402 with payment details</li>
            <li>Agent signs USDC transaction on Solana</li>
            <li>Agent retries with transaction signature in header</li>
            <li>Server verifies on-chain, returns skill content</li>
          </ol>
          <p>No intermediaries. Instant settlement. Payments go directly to creator wallets.</p>

          <h3>Setting a Price</h3>
          <pre className="docs-code">{`// When publishing
"Publish my-skill for $2.50"

// API
POST /marketplace/skills
{
  "name": "my-skill",
  "priceUsdc": "2.50",
  "creatorWallet": "YOUR_SOLANA_WALLET"
}`}</pre>
        </section>

        <section id="contributions" className="docs-section">
          <h2>Collaborative Contributions</h2>
          <p className="docs-lead" style={{ fontSize: '1.1rem', marginBottom: '24px' }}>
            When multiple people reverse-engineer the same domain, their discoveries merge into
            one canonical skill. Revenue splits proportionally based on each contributor's value.
          </p>

          <h3>How Contributions Work</h3>
          <p>
            Instead of competing skills cluttering the marketplace, Unbrowse automatically compiles
            them into one best-of-breed skill per domain. Each contributor's share of revenue is
            proportional to the value they added.
          </p>

          <div className="contribution-flow">
            <div className="flow-step">
              <div className="flow-icon">1</div>
              <div className="flow-label">Publish Skill</div>
            </div>
            <div className="flow-arrow"></div>
            <div className="flow-step">
              <div className="flow-icon">2</div>
              <div className="flow-label">Parse & Diff</div>
            </div>
            <div className="flow-arrow"></div>
            <div className="flow-step">
              <div className="flow-icon">3</div>
              <div className="flow-label">LLM Score</div>
            </div>
            <div className="flow-arrow"></div>
            <div className="flow-step">
              <div className="flow-icon">4</div>
              <div className="flow-label">Update Weights</div>
            </div>
            <div className="flow-arrow"></div>
            <div className="flow-step">
              <div className="flow-icon">5</div>
              <div className="flow-label">Compile Canonical</div>
            </div>
          </div>

          <h3>Scoring Dimensions</h3>
          <p>
            Each contribution is evaluated by an LLM across five dimensions. The structural diff
            (new endpoints, better docs, auth discovery) provides focused context so the LLM
            can score accurately.
          </p>

          <table className="scoring-table">
            <thead>
              <tr>
                <th>Dimension</th>
                <th>Weight</th>
                <th>What It Measures</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>New Endpoints</td>
                <td><span className="weight-badge high">40%</span></td>
                <td>Endpoints discovered that nobody had before</td>
              </tr>
              <tr>
                <td>Auth Discovery</td>
                <td><span className="weight-badge high">25%</span></td>
                <td>Found the authentication pattern, new headers or cookies</td>
              </tr>
              <tr>
                <td>Doc Quality</td>
                <td><span className="weight-badge med">15%</span></td>
                <td>Better parameter docs, response schemas, descriptions</td>
              </tr>
              <tr>
                <td>Validation</td>
                <td><span className="weight-badge low">10%</span></td>
                <td>Endpoints were verified as actually working</td>
              </tr>
              <tr>
                <td>Maintenance</td>
                <td><span className="weight-badge low">10%</span></td>
                <td>Updated stale endpoints, fixed broken ones</td>
              </tr>
            </tbody>
          </table>

          <h3>Revenue Distribution</h3>
          <p>
            The creator's share of each download is routed to contributors using weighted random
            selection. Each download picks one contributor proportional to their score. Over many
            downloads, payouts converge to exact proportional splits.
          </p>

          <div className="docs-highlight">
            <h3>Example: twitter.com API</h3>
            <div className="weight-bars">
              <div className="weight-row">
                <span className="weight-name">Alice</span>
                <div className="weight-track">
                  <div className="weight-fill" style={{ width: '60%' }}></div>
                </div>
                <span className="weight-pct">60%</span>
              </div>
              <div className="weight-row">
                <span className="weight-name">Bob</span>
                <div className="weight-track">
                  <div className="weight-fill" style={{ width: '25%' }}></div>
                </div>
                <span className="weight-pct">25%</span>
              </div>
              <div className="weight-row">
                <span className="weight-name">Charlie</span>
                <div className="weight-track">
                  <div className="weight-fill" style={{ width: '15%' }}></div>
                </div>
                <span className="weight-pct">15%</span>
              </div>
            </div>
            <p style={{ marginTop: '16px', fontSize: '0.85rem' }}>
              Alice discovered 12 new endpoints + auth. Bob added 4 endpoints with better docs.
              Charlie verified 8 endpoints as working.
            </p>
          </div>

          <h3>Backward Compatible</h3>
          <ul className="docs-list">
            <li>
              <strong>Single-creator skills</strong> work exactly as before (100% creator split)
            </li>
            <li>
              <strong>First publisher</strong> for a domain gets 100% weight until someone else contributes
            </li>
            <li>
              <strong>x402 payment structure</strong> is unchanged — same on-chain transaction format
            </li>
          </ul>

          <h3>Contributor API</h3>
          <pre className="docs-code">{`// View contributors for a domain
GET /marketplace/domains/:domain/contributors

// Response
{
  "domain": "api.twitter.com",
  "canonicalSkillId": "sk_abc123",
  "contributorCount": 3,
  "contributors": [
    {
      "totalScore": "78.50",
      "revenueWeight": "0.6000",
      "endpointCount": 24,
      "scoreNewEndpoints": 85,
      "scoreAuthDiscovery": 100,
      "scoreDocQuality": 60
    }
  ]
}`}</pre>
        </section>

        <section id="under-the-hood" className="docs-section">
          <h2>Under the Hood</h2>
          <p className="docs-lead" style={{ fontSize: '1.1rem', marginBottom: '24px' }}>
            A technical overview of how Unbrowse captures, parses, scores, merges, and monetizes
            API knowledge — from browser traffic to on-chain payments.
          </p>

          <h3>System Pipeline</h3>
          <div className="arch-pipeline">
            <div className="arch-stage">
              <div className="arch-stage-header">
                <span className="arch-stage-num">1</span>
                <span className="arch-stage-title">Capture</span>
              </div>
              <p>Agent browses a site via Chrome DevTools Protocol. All XHR/Fetch traffic is recorded
              — request URLs, headers, bodies, and responses. Analytics, ads, and CDN noise are filtered out
              automatically using domain heuristics.</p>
            </div>

            <div className="arch-stage">
              <div className="arch-stage-header">
                <span className="arch-stage-num">2</span>
                <span className="arch-stage-title">HAR Parsing</span>
              </div>
              <p>Raw network traffic (HAR format) is parsed into structured API endpoints.
              The parser identifies HTTP methods, normalizes path parameters
              (<code>{'{userId}'}</code>, <code>{'{orderId}'}</code>), extracts query params,
              request/response schemas, and detects authentication patterns — Bearer tokens,
              API keys, session cookies, CSRF tokens, and custom <code>x-*</code> headers.</p>
            </div>

            <div className="arch-stage">
              <div className="arch-stage-header">
                <span className="arch-stage-num">3</span>
                <span className="arch-stage-title">Skill Generation</span>
              </div>
              <p>Parsed endpoints are compiled into a SKILL.md file following
              the Agent Skills open standard. An LLM generates human-readable descriptions,
              categorizes endpoints (auth, read, write, delete), and produces a TypeScript
              API client in <code>scripts/api.ts</code> that agents can execute directly.</p>
            </div>

            <div className="arch-stage">
              <div className="arch-stage-header">
                <span className="arch-stage-num">4</span>
                <span className="arch-stage-title">Quality Vetting</span>
              </div>
              <p>Before publishing, every skill is scored 0-100 by an LLM evaluator.
              It checks endpoint completeness, auth documentation, parameter coverage,
              response schemas, and whether endpoints were actually verified against the live API.
              Skills below threshold are flagged for improvement.</p>
            </div>

            <div className="arch-stage">
              <div className="arch-stage-header">
                <span className="arch-stage-num">5</span>
                <span className="arch-stage-title">Publishing & Dedup</span>
              </div>
              <p>Skills are published to the marketplace indexed by domain. If another skill
              already exists for the same domain, the contribution system kicks in — the new
              submission is diffed against the canonical skill and scored for incremental value
              (see <a href="#contributions">Contributions</a>).</p>
            </div>

            <div className="arch-stage">
              <div className="arch-stage-header">
                <span className="arch-stage-num">6</span>
                <span className="arch-stage-title">Canonical Compilation</span>
              </div>
              <p>When multiple contributors exist for a domain, an LLM merges all contributions
              into one canonical skill — the best-documented version of each endpoint, union of
              all auth patterns, most complete schemas. This is the skill shown in marketplace
              search. Source skills are preserved for attribution.</p>
            </div>

            <div className="arch-stage">
              <div className="arch-stage-header">
                <span className="arch-stage-num">7</span>
                <span className="arch-stage-title">Payment Routing</span>
              </div>
              <p>Downloads are paid via x402 (HTTP 402 + Solana USDC). The transaction splits
              across 3 wallets: creator, FDRY treasury, and network fee. For canonical skills
              with multiple contributors, the creator wallet is selected per-download via weighted
              random — proportional to each contributor's score. Over many downloads, payouts
              converge to exact proportional splits.</p>
            </div>
          </div>

          <h3>Structural Diff Engine</h3>
          <p>
            The core of the contribution system is a structural parser that converts SKILL.md
            into a list of endpoints keyed by <code>METHOD /normalized/path</code>. This allows
            precise diffing without LLM involvement:
          </p>
          <pre className="docs-code">{`// Structural diff between submission and canonical
{
  newEndpoints:      ["POST /tweets", "DELETE /tweets/{id}"],
  improvedEndpoints: ["GET /users/{id} — +3 query params, better schema"],
  authChanges:       { newAuthMethod: true, newHeaders: ["x-csrf-token"] },
  overlapCount:      8,     // endpoints in both
  submissionTotal:   12,    // total in submission
  canonicalTotal:    10     // total in canonical
}`}</pre>
          <p>
            This structured diff is what gets sent to the LLM scorer — not raw markdown.
            Keeps token usage low and scoring focused on actual changes.
          </p>

          <h3>Auth Extraction</h3>
          <p>
            Unbrowse uses heuristic matching to capture authentication from any API automatically:
          </p>
          <ul className="docs-list">
            <li>
              <strong>Exact matches</strong> — <code>authorization</code>, <code>x-api-key</code>,
              <code>bearer</code>, <code>session-token</code>
            </li>
            <li>
              <strong>Pattern matches</strong> — Any header containing <code>auth</code>,
              <code>token</code>, <code>key</code>, <code>secret</code>, <code>session</code>
            </li>
            <li>
              <strong>Custom x-* headers</strong> — Non-standard headers often contain proprietary auth
            </li>
            <li>
              <strong>Cookies</strong> — Session cookies, CSRF tokens, and auth cookies are captured separately
            </li>
          </ul>
          <p>
            Auth credentials are stored locally in <code>auth.json</code> and never published
            to the marketplace. Only the auth <em>pattern</em> (which headers/cookies are needed)
            is included in the skill.
          </p>

          <h3>Semantic Search</h3>
          <p>
            Skills are embedded as 3072-dimensional vectors using text embeddings and stored
            in PostgreSQL with pgvector. When an agent searches "post to twitter", the query
            is embedded and matched against skill vectors via cosine similarity — returning
            the most relevant skills regardless of exact keyword matches.
          </p>

          <h3>x402 Payment Flow</h3>
          <div className="arch-pipeline">
            <div className="arch-stage">
              <div className="arch-stage-header">
                <span className="arch-stage-num">A</span>
                <span className="arch-stage-title">Request</span>
              </div>
              <p>Agent calls <code>GET /marketplace/skills/:id/download</code>.
              Server checks if skill is paid.</p>
            </div>
            <div className="arch-stage">
              <div className="arch-stage-header">
                <span className="arch-stage-num">B</span>
                <span className="arch-stage-title">402 Response</span>
              </div>
              <p>Server returns HTTP 402 with payment details: USDC amount, recipient
              wallets (creator + treasury), and a payment memo.</p>
            </div>
            <div className="arch-stage">
              <div className="arch-stage-header">
                <span className="arch-stage-num">C</span>
                <span className="arch-stage-title">Sign & Pay</span>
              </div>
              <p>Agent constructs a Solana transaction splitting USDC across wallets,
              signs it with their phantom wallet, and submits on-chain.</p>
            </div>
            <div className="arch-stage">
              <div className="arch-stage-header">
                <span className="arch-stage-num">D</span>
                <span className="arch-stage-title">Verify & Deliver</span>
              </div>
              <p>Agent retries with the transaction signature in the <code>X-Payment</code> header.
              Server verifies the on-chain transaction, records it, and returns the skill content.</p>
            </div>
          </div>
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
