import { Link } from 'react-router-dom';

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer-content">
        <div className="footer-brand">
          <span className="footer-brand-text">Clawd Skills</span>
          <p className="footer-brand-description">
            AI-powered browser automation skills marketplace. Build once, sell forever with x402 Solana micropayments.
          </p>
        </div>

        <div className="footer-section">
          <h4 className="footer-section-title">Product</h4>
          <div className="footer-links">
            <Link to="/" className="footer-link">Marketplace</Link>
            <a href="https://github.com/clawdbot" className="footer-link" target="_blank" rel="noopener noreferrer">
              Documentation
            </a>
            <a href="#" className="footer-link">Pricing</a>
          </div>
        </div>

        <div className="footer-section">
          <h4 className="footer-section-title">Developers</h4>
          <div className="footer-links">
            <a href="https://github.com/clawdbot" className="footer-link" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <a href="#" className="footer-link">API Reference</a>
            <a href="#" className="footer-link">SDK</a>
          </div>
        </div>

        <div className="footer-section">
          <h4 className="footer-section-title">Company</h4>
          <div className="footer-links">
            <a href="#" className="footer-link">About</a>
            <a href="https://twitter.com/clawdbot" className="footer-link" target="_blank" rel="noopener noreferrer">
              Twitter
            </a>
            <a href="https://discord.gg/clawdbot" className="footer-link" target="_blank" rel="noopener noreferrer">
              Discord
            </a>
          </div>
        </div>
      </div>

      <div className="footer-bottom">
        <div className="footer-bottom-content">
          <span>&copy; {new Date().getFullYear()} Clawd Skills. All rights reserved.</span>
          <div className="footer-solana">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.84 5.34a.63.63 0 0 1 .45.18l3.53 3.6a.63.63 0 0 1 0 .88l-3.53 3.6a.63.63 0 0 1-.45.19H4.32a.38.38 0 0 1-.27-.65l3.28-3.35a.63.63 0 0 1 .45-.18h10.06zm0 13.32a.63.63 0 0 0 .45-.18l3.53-3.6a.63.63 0 0 0 0-.88l-3.53-3.6a.63.63 0 0 0-.45-.18H4.32a.38.38 0 0 0-.27.65l3.28 3.34a.63.63 0 0 0 .45.19h10.06z"/>
            </svg>
            <span>Powered by Solana</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
