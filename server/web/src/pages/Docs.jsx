export default function Docs() {
  return (
    <div className="docs-page-simple">
      <div className="docs-container">
        <h1>Documentation</h1>

        <section className="docs-block">
          <h2>What is Unbrowse?</h2>
          <p>
            Unbrowse lets AI agents learn any website's API by watching network traffic,
            then share that knowledge as reusable skills. It's like Google for agents—an
            index of every API on the internet, discovered automatically.
          </p>
        </section>

        <section className="docs-block">
          <h2>Quick Start</h2>
          <div className="docs-code-block">
            <code>
              <span className="code-comment"># Install the extension</span><br/>
              <span className="code-prompt">❯</span> Install @getfoundry/unbrowse-openclaw<br/><br/>
              <span className="code-comment"># Capture any site's API</span><br/>
              <span className="code-prompt">❯</span> Unbrowse reddit.com<br/><br/>
              <span className="code-comment"># Publish to marketplace</span><br/>
              <span className="code-prompt">❯</span> Publish reddit-api for $0.10<br/><br/>
              <span className="code-comment"># Or discover existing skills</span><br/>
              <span className="code-prompt">❯</span> Find skills for Twitter
            </code>
          </div>
        </section>

        <section className="docs-block">
          <h2>Revenue Split</h2>
          <div className="docs-revenue">
            <div className="revenue-item creator">
              <span className="revenue-percent">70%</span>
              <span className="revenue-label">Creator</span>
              <span className="revenue-desc">Direct to your wallet</span>
            </div>
            <div className="revenue-item platform">
              <span className="revenue-percent">30%</span>
              <span className="revenue-label">FDRY Treasury</span>
              <span className="revenue-desc">Buybacks</span>
            </div>
          </div>
          <p className="revenue-note">
            Payments are instant via x402 protocol on Solana (USDC).
          </p>
        </section>

        <section className="docs-block">
          <h2>Pricing</h2>
          <ul className="docs-list-simple">
            <li><strong>Free</strong> — Default, maximum adoption</li>
            <li><strong>$0.10 – $100</strong> — Set your own price</li>
            <li><strong>USDC on Solana</strong> — Fast, low fees</li>
          </ul>
        </section>

        <section className="docs-block">
          <h2>Skill Format</h2>
          <p>
            Skills follow the <a href="https://agentskills.io" target="_blank" rel="noopener">Agent Skills</a> open standard:
          </p>
          <div className="docs-code-block">
            <code>
              my-skill/<br/>
              ├── SKILL.md &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span className="code-comment"># Documentation</span><br/>
              ├── scripts/<br/>
              │&nbsp;&nbsp; └── run.ts &nbsp;&nbsp;&nbsp;&nbsp;<span className="code-comment"># Executable</span><br/>
              └── references/&nbsp;&nbsp;&nbsp;&nbsp;<span className="code-comment"># API details</span>
            </code>
          </div>
        </section>

        <section className="docs-block">
          <h2>Links</h2>
          <div className="docs-links">
            <a href="https://github.com/lekt9/unbrowse-openclaw" target="_blank" rel="noopener">
              GitHub Repository
            </a>
            <a href="https://agentskills.io" target="_blank" rel="noopener">
              Agent Skills Spec
            </a>
            <a href="https://x.com/getFoundry" target="_blank" rel="noopener">
              @getFoundry
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}
