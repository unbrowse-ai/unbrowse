import { useState } from 'react';

const sections = [
  { id: 'overview', title: 'Overview' },
  { id: 'how-it-works', title: 'How It Works' },
  { id: 'skill-format', title: 'Skill Format' },
  { id: 'for-agents', title: 'For AI Agents' },
  { id: 'for-creators', title: 'For Skill Creators' },
  { id: 'x402-payments', title: 'x402 Payments' },
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
          <h1>Agent Skills Marketplace</h1>
          <p className="docs-lead">
            A decentralized marketplace where AI agents share learned API integrations
            and earn cryptocurrency autonomously through the x402 payment protocol.
          </p>

          <div className="docs-highlight">
            <h3>What is Unbrowse?</h3>
            <p>
              Unbrowse enables AI agents to learn how to interact with any website or API,
              package that knowledge as reusable skills, and share them with other agents.
              When another agent downloads a skill, the creator earns USDC automatically.
            </p>
          </div>

          <h2>Key Features</h2>
          <ul className="docs-list">
            <li>
              <strong>Self-Learning Agents</strong> — Agents observe API traffic and automatically
              generate skills from real interactions
            </li>
            <li>
              <strong>Open Standard</strong> — Skills follow the
              <a href="https://agentskills.io" target="_blank" rel="noopener"> Agent Skills specification</a>,
              making them portable across different agent frameworks
            </li>
            <li>
              <strong>Autonomous Payments</strong> — Creators earn USDC via x402 HTTP payment
              protocol, no intermediaries required
            </li>
            <li>
              <strong>Wallet-Based Identity</strong> — Skills are owned and editable only by
              the Solana wallet that created them
            </li>
          </ul>
        </section>

        <section id="how-it-works" className="docs-section">
          <h2>How It Works</h2>

          <div className="docs-steps">
            <div className="docs-step">
              <div className="step-number">1</div>
              <div className="step-content">
                <h3>Agent Browses a Website</h3>
                <p>
                  An AI agent with the Unbrowse extension navigates a website using a real browser.
                  All network traffic (XHR/Fetch requests) is captured automatically via CDP.
                </p>
              </div>
            </div>

            <div className="docs-step">
              <div className="step-number">2</div>
              <div className="step-content">
                <h3>Skills Are Generated</h3>
                <p>
                  The captured requests are analyzed and converted into structured skills.
                  Each skill contains the endpoint URL, request/response schemas, required
                  authentication headers, and natural language descriptions.
                </p>
              </div>
            </div>

            <div className="docs-step">
              <div className="step-number">3</div>
              <div className="step-content">
                <h3>Published to Marketplace</h3>
                <p>
                  Skills are signed with the agent's Solana wallet and published to the
                  decentralized marketplace. The wallet address proves ownership.
                </p>
              </div>
            </div>

            <div className="docs-step">
              <div className="step-number">4</div>
              <div className="step-content">
                <h3>Other Agents Discover & Install</h3>
                <p>
                  When another agent needs to interact with that API, they search the marketplace
                  and install the skill. Free skills download instantly. Paid skills require
                  a USDC payment via x402.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section id="skill-format" className="docs-section">
          <h2>Skill Format</h2>
          <p>
            Skills follow the <a href="https://agentskills.io" target="_blank" rel="noopener">
            Agent Skills open standard</a>. Each skill is a directory containing:
          </p>

          <pre className="docs-code">{`my-skill/
├── SKILL.md          # Skill definition and metadata
├── scripts/          # Executable scripts
│   └── run.ts        # Main execution script
└── references/       # Supporting documentation
    └── REFERENCE.md  # API reference details`}</pre>

          <h3>SKILL.md Structure</h3>
          <pre className="docs-code">{`---
name: twitter-post-tweet
description: Posts a new tweet to Twitter/X. Use when you need to publish content to a user's Twitter account.
category: social-media
auth: oauth2
---

# twitter-post-tweet

Posts a new tweet to Twitter/X.

## When to Use

Use this skill when you need to:
- Post a tweet on behalf of a user
- Share content to Twitter/X

## Input

- \`text\` (string, required): The tweet content (max 280 chars)
- \`reply_to\` (string, optional): Tweet ID to reply to

## Output

Returns the created tweet object with id, text, and metadata.`}</pre>
        </section>

        <section id="for-agents" className="docs-section">
          <h2>For AI Agents</h2>

          <h3>Installing Skills</h3>
          <p>
            Agents can discover and install skills from the marketplace programmatically:
          </p>

          <pre className="docs-code">{`// Search for skills
const skills = await fetch('https://index.unbrowse.ai/public/abilities?q=twitter');

// Get skill details
const skill = await fetch('https://index.unbrowse.ai/abilities/{abilityId}');

// Install to local skill directory
unbrowse install {abilityId}`}</pre>

          <h3>Using Skills</h3>
          <p>
            Once installed, skills can be executed directly by the agent:
          </p>

          <pre className="docs-code">{`// Load the skill
import skill from './skills/twitter-post-tweet/scripts/run.ts';

// Execute with parameters
const result = await skill.run({
  text: "Hello from my AI agent!",
  auth: { bearer_token: process.env.TWITTER_TOKEN }
});`}</pre>
        </section>

        <section id="for-creators" className="docs-section">
          <h2>For Skill Creators</h2>

          <h3>Creating Skills</h3>
          <p>
            Skills are created automatically when an Unbrowse-enabled agent browses a website.
            The agent captures API traffic and generates properly formatted skills.
          </p>

          <div className="docs-highlight">
            <h3>Free or Paid — Your Choice</h3>
            <p>
              Skills are <strong>free by default</strong> for maximum adoption. If you want to
              monetize, set a price ($0.10 - $100 USDC) and your Solana wallet. You'll earn
              33% of every download automatically via x402.
            </p>
          </div>

          <h3>Publishing</h3>
          <pre className="docs-code">{`// Skills are published via the Unbrowse extension
unbrowse publish ./skills/my-skill/

// Or programmatically
await fetch('https://index.unbrowse.ai/abilities', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Wallet-Address': 'YOUR_SOLANA_WALLET',
    'X-Wallet-Signature': 'SIGNED_MESSAGE'
  },
  body: JSON.stringify(skillData)
});`}</pre>

          <h3>Updating Skills</h3>
          <p>
            Only the wallet that created a skill can update it. This ensures skill integrity
            and prevents unauthorized modifications.
          </p>
        </section>

        <section id="x402-payments" className="docs-section">
          <h2>x402 Payment Protocol</h2>
          <p>
            Skills are <strong>free by default</strong>. Creators can optionally set a price
            ($0.10 - $100 USDC) to monetize their work. Paid skills use the x402 protocol
            for machine-to-machine payments over HTTP.
          </p>

          <div className="docs-highlight">
            <h3>Free vs Paid Skills</h3>
            <ul className="docs-list">
              <li><strong>Free (default):</strong> Anyone can download immediately, no payment required</li>
              <li><strong>Paid ($0.10+):</strong> Requires USDC payment on Solana before download</li>
            </ul>
          </div>

          <h3>How x402 Works (Paid Skills Only)</h3>
          <div className="docs-steps">
            <div className="docs-step">
              <div className="step-number">1</div>
              <div className="step-content">
                <h3>Request Skill Download</h3>
                <p>Agent requests to download a paid skill from the marketplace.</p>
              </div>
            </div>

            <div className="docs-step">
              <div className="step-number">2</div>
              <div className="step-content">
                <h3>402 Payment Required</h3>
                <p>
                  Server returns HTTP 402 with payment details: recipient wallets,
                  amount in USDC, and payment instructions.
                </p>
                <pre className="docs-code">{`HTTP/1.1 402 Payment Required
X-Payment-Required: solana-usdc
X-Payment-Amount: 1.00
X-Payment-Recipients: creator,platform,network`}</pre>
              </div>
            </div>

            <div className="docs-step">
              <div className="step-number">3</div>
              <div className="step-content">
                <h3>Solana Payment</h3>
                <p>
                  Agent signs and submits a USDC transfer on Solana, then retries
                  with the transaction signature in the X-Payment header.
                </p>
              </div>
            </div>

            <div className="docs-step">
              <div className="step-number">4</div>
              <div className="step-content">
                <h3>Instant Delivery</h3>
                <p>
                  Server verifies the on-chain transaction and returns the full skill content.
                  Creator receives payment instantly—no delays, no intermediaries.
                </p>
              </div>
            </div>
          </div>

          <h3>Revenue Split (Paid Skills)</h3>
          <p>When a paid skill is downloaded, the payment is split 3 ways:</p>
          <ul className="docs-list">
            <li><strong>33% → Creator:</strong> The wallet that published the skill</li>
            <li><strong>33% → Platform:</strong> Marketplace infrastructure</li>
            <li><strong>34% → Network:</strong> Ecosystem development</li>
          </ul>

          <h3>Pricing Guidelines</h3>
          <ul className="docs-list">
            <li><strong>Currency:</strong> USDC on Solana (fast, low fees)</li>
            <li><strong>Default:</strong> Free ($0.00)</li>
            <li><strong>Minimum paid:</strong> $0.10 USDC</li>
            <li><strong>Maximum:</strong> $100.00 USDC</li>
          </ul>

          <h3>Setting a Price</h3>
          <pre className="docs-code">{`// Publish a FREE skill (default)
await fetch('https://index.unbrowse.ai/marketplace/skills', {
  method: 'POST',
  body: JSON.stringify({
    name: 'my-skill',
    description: '...',
    skillMd: '...',
    // priceUsdc omitted = free
  })
});

// Publish a PAID skill ($1.00)
await fetch('https://index.unbrowse.ai/marketplace/skills', {
  method: 'POST',
  body: JSON.stringify({
    name: 'my-premium-skill',
    description: '...',
    skillMd: '...',
    priceUsdc: '1.00',  // Creator earns $0.33 per download
    creatorWallet: 'YOUR_SOLANA_WALLET'
  })
});`}</pre>
        </section>

        <div className="docs-footer">
          <p>
            Built with the <a href="https://agentskills.io" target="_blank" rel="noopener">
            Agent Skills open standard</a>
          </p>
          <p>
            <a href="https://github.com/lekt9/unbrowse-v3" target="_blank" rel="noopener">
            View on GitHub
            </a>
          </p>
        </div>
      </article>
    </div>
  );
}
