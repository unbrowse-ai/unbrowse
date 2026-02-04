import { useState } from 'react';

const sections = [
  { id: 'overview', title: 'Overview' },
  { id: 'quickstart', title: 'Quick Start' },
  { id: 'how-it-works', title: 'How It Works' },
  { id: 'skill-format', title: 'Skill Format' },
  { id: 'for-agents', title: 'For AI Agents' },
  { id: 'for-creators', title: 'For Creators' },
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
              <strong>Instant Payments</strong> — Creators earn USDC via x402 protocol on Solana
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
