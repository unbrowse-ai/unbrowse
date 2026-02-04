import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';

const API_BASE = 'https://index.unbrowse.ai';

export default function SkillDetail() {
  const { id } = useParams();
  const [skill, setSkill] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copiedStep, setCopiedStep] = useState(null);

  useEffect(() => {
    loadSkill();
  }, [id]);

  const loadSkill = async () => {
    try {
      const res = await fetch(`${API_BASE}/marketplace/skills/${id}`);
      if (res.ok) {
        const data = await res.json();
        setSkill(data.skill);
      }
    } catch (err) {
      console.error('Failed to load skill:', err);
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async (text, stepId) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedStep(stepId);
      setTimeout(() => setCopiedStep(null), 2000);
    } catch (err) {
      alert(`Copy this command:\n\n${text}`);
    }
  };

  const handlePurchase = () => {
    // TODO: Implement x402 payment flow
    alert('x402 payment flow coming soon!\n\nFor now, use unbrowse_search in Claude/OpenClaw to install skills.');
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
        Loading skill...
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="skill-not-found">
        <h2>Skill not found</h2>
        <p>The skill you're looking for doesn't exist or has been removed.</p>
        <Link to="/" className="btn btn-primary">Back to Marketplace</Link>
      </div>
    );
  }

  const searchCommand = `unbrowse_search query="${skill.name}"`;
  const installCommand = `unbrowse_search install="${skill.skillId}"`;
  const replayCommand = `unbrowse_replay service="${skill.name}" endpoint="<endpoint-name>" params={...}`;

  return (
    <div className="skill-detail">
      <Link to="/" className="back-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Back to marketplace
      </Link>

      <div className="detail-hero">
        <div className="detail-header">
          <div className="detail-title-row">
            {skill.category && (
              <span className="detail-category">{skill.category}</span>
            )}
            <h1 className="detail-title">{skill.name}</h1>
          </div>
          <p className="detail-description">
            {skill.description || 'No description available'}
          </p>
        </div>
      </div>

      {/* Metadata Grid - Always visible */}
      <div className="detail-meta-grid">
        {skill.serviceName && (
          <div className="meta-card">
            <div className="meta-label">Service</div>
            <div className="meta-value">{skill.serviceName}</div>
          </div>
        )}
        {skill.domain && (
          <div className="meta-card">
            <div className="meta-label">Domain</div>
            <div className="meta-value">{skill.domain}</div>
          </div>
        )}
        {skill.authType && (
          <div className="meta-card">
            <div className="meta-label">Auth Type</div>
            <div className="meta-value">{skill.authType}</div>
          </div>
        )}
        <div className="meta-card">
          <div className="meta-label">Downloads</div>
          <div className="meta-value">{(skill.downloadCount || 0).toLocaleString()}</div>
        </div>
      </div>

      {/* Paywall Section - Premium purchase gate */}
      <section className="paywall-section">
        <div className="paywall-content">
          <div className="paywall-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
          </div>
          <div className="paywall-text">
            <h3>Full Skill Package</h3>
            <p>
              Get complete access to SKILL.md documentation, API scripts,
              and reference materials. Includes all endpoints and implementation code.
            </p>
          </div>
          <div className="paywall-price">
            <span className="price-amount">${parseFloat(skill.priceUsdc || '1.00').toFixed(2)}</span>
            <span className="price-currency">USDC</span>
          </div>
          <button className="btn btn-purchase" onClick={handlePurchase}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v12M6 12h12" />
            </svg>
            Purchase Skill
          </button>
          <div className="paywall-split">
            Revenue split: Creator 33% • Platform 33% • Network 34%
          </div>
        </div>
      </section>

      {/* How to Use - Actual unbrowse workflow */}
      <section className="detail-section">
        <h2>How to Use</h2>
        <p className="section-intro">
          Use these tools in <strong>Claude Code</strong>, <strong>OpenClaw</strong>, or any agent with the unbrowse extension installed.
        </p>

        <div className="quickstart-steps">
          <div className="quickstart-step">
            <span className="step-num">1</span>
            <div className="step-body">
              <h3>Search for this skill</h3>
              <p className="step-description">Find available skills in the marketplace</p>
              <div className="code-block">
                <code>{searchCommand}</code>
                <button
                  className={`copy-btn ${copiedStep === 'search' ? 'copied' : ''}`}
                  onClick={() => copyToClipboard(searchCommand, 'search')}
                >
                  {copiedStep === 'search' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>

          <div className="quickstart-step">
            <span className="step-num">2</span>
            <div className="step-body">
              <h3>Install the skill</h3>
              <p className="step-description">Download and save to your local skills directory (${parseFloat(skill.priceUsdc || '1.00').toFixed(2)} USDC)</p>
              <div className="code-block">
                <code>{installCommand}</code>
                <button
                  className={`copy-btn ${copiedStep === 'install' ? 'copied' : ''}`}
                  onClick={() => copyToClipboard(installCommand, 'install')}
                >
                  {copiedStep === 'install' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>

          {skill.authType && skill.authType !== 'none' && (
            <div className="quickstart-step">
              <span className="step-num">3</span>
              <div className="step-body">
                <h3>Add your credentials</h3>
                <p className="step-description">
                  After installing, add your auth credentials to <code className="inline-code">auth.json</code> or
                  use <code className="inline-code">unbrowse_capture</code> to extract from a live browser session
                </p>
              </div>
            </div>
          )}

          <div className="quickstart-step">
            <span className="step-num">{skill.authType && skill.authType !== 'none' ? '4' : '3'}</span>
            <div className="step-body">
              <h3>Execute API calls</h3>
              <p className="step-description">Replay captured endpoints with your credentials</p>
              <div className="code-block">
                <code>{replayCommand}</code>
                <button
                  className={`copy-btn ${copiedStep === 'replay' ? 'copied' : ''}`}
                  onClick={() => copyToClipboard(replayCommand, 'replay')}
                >
                  {copiedStep === 'replay' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Prerequisites */}
      <section className="detail-section">
        <h2>Prerequisites</h2>
        <div className="prereq-grid">
          <div className="prereq-item">
            <div className="prereq-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
              </svg>
            </div>
            <div className="prereq-content">
              <strong>Unbrowse Extension</strong>
              <span>Install in Claude Code or OpenClaw</span>
            </div>
          </div>
          <div className="prereq-item">
            <div className="prereq-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            </div>
            <div className="prereq-content">
              <strong>Solana Wallet</strong>
              <span>USDC balance for skill purchases</span>
            </div>
          </div>
          {skill.authType && skill.authType !== 'none' && (
            <div className="prereq-item">
              <div className="prereq-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M13.8 12H3" />
                </svg>
              </div>
              <div className="prereq-content">
                <strong>{skill.authType} Credentials</strong>
                <span>Account access for {skill.domain || skill.serviceName || 'this service'}</span>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Creator */}
      {skill.creatorWallet && (
        <section className="detail-section creator-section">
          <h2>Creator</h2>
          <div className="creator-info">
            <div className="creator-avatar">
              {skill.creatorWallet[0].toUpperCase()}
            </div>
            <div className="creator-details">
              <span className="creator-name">
                {`${skill.creatorWallet.slice(0, 6)}...${skill.creatorWallet.slice(-4)}`}
              </span>
              <span className="creator-note">Earns 33% of each purchase in USDC</span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
