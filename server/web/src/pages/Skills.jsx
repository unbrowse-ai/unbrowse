import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

const API_BASE = 'https://index.unbrowse.ai';

// Badge display component
function BadgeChip({ badge }) {
  if (!badge) return null;

  const badgeStyles = {
    official: { bg: 'rgba(0, 255, 136, 0.15)', color: '#00ff88', icon: '✓', label: 'Official' },
    highlighted: { bg: 'rgba(255, 200, 0, 0.15)', color: '#ffc800', icon: '⭐', label: 'Featured' },
    deprecated: { bg: 'rgba(255, 68, 68, 0.15)', color: '#ff4444', icon: '⚠', label: 'Deprecated' },
    verified: { bg: 'rgba(0, 200, 255, 0.15)', color: '#00c8ff', icon: '✓', label: 'Verified' },
  };

  const style = badgeStyles[badge] || { bg: 'rgba(255,255,255,0.1)', color: '#888', icon: '•', label: badge };

  return (
    <span className="ub-badge-chip" style={{ background: style.bg, color: style.color }}>
      {style.icon} {style.label}
    </span>
  );
}

// Animated code rain effect
function CodeRain() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    const chars = 'GETPOSTPUTDELETEPATCH{}[]":,01'.split('');
    const fontSize = 14;
    const columns = canvas.width / fontSize;
    const drops = Array(Math.floor(columns)).fill(1);

    const draw = () => {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.fillStyle = 'rgba(0, 255, 136, 0.35)';
      ctx.font = `${fontSize}px monospace`;

      for (let i = 0; i < drops.length; i++) {
        const char = chars[Math.floor(Math.random() * chars.length)];
        ctx.fillText(char, i * fontSize, drops[i] * fontSize);

        if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
          drops[i] = 0;
        }
        drops[i]++;
      }
    };

    const interval = setInterval(draw, 50);
    return () => clearInterval(interval);
  }, []);

  return <canvas ref={canvasRef} className="code-rain" />;
}

export default function Skills() {
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [stats, setStats] = useState({ total: 0, services: 0, downloads: 0 });
  const [activeFilter, setActiveFilter] = useState('free');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [trendingSkills, setTrendingSkills] = useState([]);

  useEffect(() => {
    loadMarketplaceSkills();
  }, [categoryFilter]);

  const loadMarketplaceSkills = async (query = '') => {
    setLoading(true);
    try {
      let url = `${API_BASE}/marketplace/skills?limit=100`;
      if (query.trim()) {
        url += `&q=${encodeURIComponent(query)}`;
      }
      if (categoryFilter !== 'all') {
        url += `&category=${encodeURIComponent(categoryFilter)}`;
      }

      // Fetch skills and trending in parallel
      const [skillsRes, trendingRes] = await Promise.all([
        fetch(url),
        fetch(`${API_BASE}/marketplace/trending?limit=6`).catch(() => null),
      ]);

      if (skillsRes.ok) {
        const data = await skillsRes.json();
        const skillsList = data.skills || [];
        setSkills(skillsList);

        const services = new Set(skillsList.map(s => s.serviceName).filter(Boolean)).size;
        const totalDownloads = skillsList.reduce((sum, s) => sum + (s.downloadCount || 0), 0);
        setStats({ total: skillsList.length, services, downloads: totalDownloads });
      }

      // Set trending skills if available
      if (trendingRes?.ok) {
        const trendingData = await trendingRes.json();
        setTrendingSkills(trendingData.skills || []);
      }
    } catch (err) {
      console.error('Failed to load skills:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    loadMarketplaceSkills(search);
  };

  const filteredSkills = skills.filter(skill => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      skill.name?.toLowerCase().includes(q) ||
      skill.description?.toLowerCase().includes(q) ||
      skill.domain?.toLowerCase().includes(q) ||
      skill.serviceName?.toLowerCase().includes(q) ||
      skill.category?.toLowerCase().includes(q)
    );
  }).filter(skill => {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'free') return parseFloat(skill.priceUsdc || '0') === 0;
    if (activeFilter === 'paid') return parseFloat(skill.priceUsdc || '0') > 0;
    return true;
  }).filter(skill => {
    if (categoryFilter === 'all') return true;
    if (categoryFilter === 'api-package') return skill.category === 'api-package' || !skill.category;
    if (categoryFilter === 'workflow') return skill.category === 'workflow';
    return true;
  });

  // Sort: free skills first, then by downloads
  const sortedSkills = [...filteredSkills].sort((a, b) => {
    const aFree = parseFloat(a.priceUsdc || '0') === 0;
    const bFree = parseFloat(b.priceUsdc || '0') === 0;
    if (aFree !== bFree) return aFree ? -1 : 1;
    return (b.downloadCount || 0) - (a.downloadCount || 0);
  });

  // Get free skills for featured section
  const freeSkills = skills
    .filter(s => parseFloat(s.priceUsdc || '0') === 0)
    .sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0))
    .slice(0, 6);

  return (
    <div className="ub-page">
      {/* Hero - The Hook */}
      <section className="ub-hero">
        <div className="ub-hero-bg">
          <div className="ub-grid-overlay" />
          <CodeRain />
          <div className="ub-scanlines" />
        </div>

        <div className="ub-hero-content">
          <div className="ub-hero-badge">
            <span className="ub-pulse" />
            <span>OPEN SOURCE API REVERSE ENGINEERING FOR OPENCLAW</span>
          </div>

          <h1 className="ub-headline">
            <span className="ub-headline-top">INTERCEPT.</span>
            <span className="ub-headline-main">
              <span className="ub-glitch" data-text="EXTRACT.">EXTRACT.</span>
            </span>
            <span className="ub-headline-accent">MONETIZE.</span>
          </h1>

          <p className="ub-tagline">
            Capture APIs. Record cross-site workflows. Share what works.
            <strong> Earn USDC on every successful execution.</strong>
          </p>

          {/* Install Command */}
          <div className="ub-install-cmd">
            <code>openclaw plugins install @getfoundry/unbrowse-openclaw</code>
            <button
              className="ub-copy-cmd"
              onClick={() => {
                navigator.clipboard.writeText('openclaw plugins install @getfoundry/unbrowse-openclaw');
                const btn = document.querySelector('.ub-copy-cmd');
                btn.classList.add('copied');
                setTimeout(() => btn.classList.remove('copied'), 2000);
              }}
              title="Copy to clipboard"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          </div>

          {/* Hero Search Bar - Primary CTA */}
          <form onSubmit={handleSearch} className="ub-hero-search">
            <div className="ub-hero-search-wrapper">
              <svg className="ub-hero-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="text"
                placeholder="Search APIs, workflows, services..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="ub-hero-search-input"
              />
              <button type="submit" className="ub-hero-search-btn">
                SEARCH
              </button>
            </div>
            {/* Quick filter tags */}
            <div className="ub-hero-tags">
              {['Twitter', 'LinkedIn', 'Discord', 'Notion', 'Shopify', 'Stripe'].map(tag => (
                <button
                  key={tag}
                  type="button"
                  className="ub-hero-tag"
                  onClick={() => {
                    setSearch(tag.toLowerCase());
                    loadMarketplaceSkills(tag.toLowerCase());
                  }}
                >
                  {tag}
                </button>
              ))}
            </div>
          </form>

          <div className="ub-hero-actions">
            <a
              href="https://github.com/lekt9/unbrowse-openclaw"
              target="_blank"
              rel="noopener"
              className="ub-btn ub-btn-primary"
            >
              <span className="ub-btn-glow" />
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
              </svg>
              VIEW ON GITHUB
            </a>
            <Link to="/docs" className="ub-btn ub-btn-ghost">
              READ THE DOCS
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </Link>
          </div>
        </div>

        {/* Terminal Demo */}
        <div className="ub-terminal">
          <div className="ub-terminal-header">
            <div className="ub-terminal-dots">
              <span />
              <span />
              <span />
            </div>
            <span className="ub-terminal-title">unbrowse — zsh</span>
          </div>
          <div className="ub-terminal-body">
            <div className="ub-term-line">
              <span className="ub-term-prompt">~</span>
              <span className="ub-term-cmd">unbrowse_capture <span className="ub-term-arg">url="api.twitter.com"</span></span>
            </div>
            <div className="ub-term-line ub-term-output">
              <span className="ub-term-success">[OK]</span> Intercepted 47 API endpoints
            </div>
            <div className="ub-term-line ub-term-output">
              <span className="ub-term-success">[OK]</span> Generated skill: <span className="ub-term-highlight">twitter-timeline</span>
            </div>
            <div className="ub-term-line ub-term-output">
              <span className="ub-term-success">[OK]</span> Generated skill: <span className="ub-term-highlight">twitter-post-tweet</span>
            </div>
            <div className="ub-term-line">
              <span className="ub-term-prompt">~</span>
              <span className="ub-term-cmd">unbrowse_publish <span className="ub-term-arg">name="twitter-timeline" price="2.50"</span></span>
            </div>
            <div className="ub-term-line ub-term-output ub-term-final">
              <span className="ub-term-accent">[$$]</span> Published. Earning <span className="ub-term-money">$0.83</span>/download
            </div>
          </div>
        </div>
      </section>

      {/* Value Props */}
      <section className="ub-value-section">
        <div className="ub-value-grid">
          <div className="ub-value-card">
            <div className="ub-value-num">01</div>
            <div className="ub-value-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/>
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
              </svg>
            </div>
            <h3>CAPTURE</h3>
            <p>Browse any website. We intercept all API traffic — endpoints, auth headers, payloads. Everything.</p>
          </div>

          <div className="ub-value-card">
            <div className="ub-value-num">02</div>
            <div className="ub-value-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
              </svg>
            </div>
            <h3>GENERATE</h3>
            <p>AI transforms raw traffic into production-ready skills with schemas, auth handling, and docs.</p>
          </div>

          <div className="ub-value-card ub-value-featured">
            <div className="ub-value-num">03</div>
            <div className="ub-value-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
              </svg>
            </div>
            <h3>MONETIZE</h3>
            <p>Publish to marketplace. Earn 70% of every download in USDC. Your skills work while you sleep.</p>
            <div className="ub-value-stat">
              <span className="ub-stat-value">{stats.downloads.toLocaleString()}</span>
              <span className="ub-stat-label">TOTAL DOWNLOADS</span>
            </div>
          </div>
        </div>
      </section>

      {/* Stats Strip */}
      <section className="ub-stats-strip">
        <div className="ub-stat-block">
          <div className="ub-stat-num">{stats.total}</div>
          <div className="ub-stat-text">SKILLS<br/>INDEXED</div>
        </div>
        <div className="ub-stat-divider" />
        <div className="ub-stat-block">
          <div className="ub-stat-num">{stats.services}</div>
          <div className="ub-stat-text">APIS<br/>CAPTURED</div>
        </div>
        <div className="ub-stat-divider" />
        <div className="ub-stat-block">
          <div className="ub-stat-num">70%</div>
          <div className="ub-stat-text">CREATOR<br/>REVENUE</div>
        </div>
        <div className="ub-stat-divider" />
        <div className="ub-stat-block">
          <div className="ub-stat-num">USDC</div>
          <div className="ub-stat-text">INSTANT<br/>PAYOUTS</div>
        </div>
      </section>

      {/* Trending Skills */}
      {trendingSkills.length > 0 && (
        <section className="ub-trending-section">
          <div className="ub-section-header">
            <div className="ub-section-badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
              </svg>
              TRENDING NOW
            </div>
            <h2>Hot Skills</h2>
            <p>Skills gaining momentum in the last 24 hours</p>
          </div>
          <div className="ub-trending-grid">
            {trendingSkills.map((skill) => {
              const isFree = parseFloat(skill.priceUsdc || '0') === 0;
              return (
                <Link
                  key={skill.skillId}
                  to={`/skill/${skill.skillId}`}
                  className="ub-trending-card"
                >
                  <div className="ub-trending-header">
                    <span className={`ub-tag ${skill.category === 'workflow' ? 'ub-tag-workflow' : 'ub-tag-api'}`}>
                      {skill.category === 'workflow' ? 'WORKFLOW' : 'API'}
                    </span>
                    <BadgeChip badge={skill.badge} />
                    {skill.velocity > 0 && (
                      <span className="ub-velocity">+{Math.round(skill.velocity * 100)}%</span>
                    )}
                  </div>
                  <h3>{skill.name}</h3>
                  <p>{skill.serviceName || skill.domain || 'API Skill'}</p>
                  <div className="ub-trending-footer">
                    <span className={`ub-price ${isFree ? 'free' : ''}`}>
                      {isFree ? 'FREE' : `$${parseFloat(skill.priceUsdc).toFixed(2)}`}
                    </span>
                    {skill.downloadCount > 0 && (
                      <span className="ub-downloads">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                        </svg>
                        {skill.downloadCount.toLocaleString()}
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Featured Free Skills */}
      {freeSkills.length > 0 && (
        <section className="ub-free-skills">
          <div className="ub-free-header">
            <div className="ub-free-badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
              FREE TO USE
            </div>
            <h2>Start Building Now</h2>
            <p>These skills are completely free. No wallet required. Just install and use.</p>
          </div>
          <div className="ub-free-grid">
            {freeSkills.map((skill) => (
              <Link
                key={skill.skillId}
                to={`/skill/${skill.skillId}`}
                className="ub-free-card"
              >
                <div className="ub-free-card-header">
                  <span className={`ub-tag ${skill.category === 'workflow' ? 'ub-tag-workflow' : 'ub-tag-api'}`}>
                    {skill.category === 'workflow' ? 'WORKFLOW' : 'API'}
                  </span>
                  <BadgeChip badge={skill.badge} />
                  <span className="ub-free-tag">FREE</span>
                </div>
                <h3>{skill.name}</h3>
                <p>{skill.description || 'No description available'}</p>
                <div className="ub-free-card-footer">
                  <span className="ub-card-domain">{skill.domain || skill.serviceName || 'API'}</span>
                  {skill.downloadCount > 0 && (
                    <span className="ub-card-downloads">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                      </svg>
                      {skill.downloadCount.toLocaleString()}
                    </span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Marketplace */}
      <section className="ub-marketplace">
        <div className="ub-marketplace-header">
          <div className="ub-marketplace-title">
            <span className="ub-title-accent">//</span>
            SKILL MARKETPLACE
          </div>

          <div className="ub-marketplace-controls">
            <div className="ub-filter-tabs">
              {['all', 'api-package', 'workflow'].map(f => (
                <button
                  key={f}
                  className={`ub-filter-tab ${categoryFilter === f ? 'active' : ''}`}
                  onClick={() => setCategoryFilter(f)}
                >
                  {f === 'api-package' ? 'APIs' : f === 'workflow' ? 'WORKFLOWS' : 'ALL'}
                </button>
              ))}
            </div>
            <div className="ub-filter-tabs" style={{ marginLeft: '1rem' }}>
              {['all', 'free', 'paid'].map(f => (
                <button
                  key={f}
                  className={`ub-filter-tab ${activeFilter === f ? 'active' : ''}`}
                  onClick={() => setActiveFilter(f)}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>

            <form onSubmit={handleSearch} className="ub-search-form">
              <svg className="ub-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="text"
                placeholder="Search APIs, services..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="ub-search-input"
              />
            </form>
          </div>
        </div>

        {loading ? (
          <div className="ub-loading">
            <div className="ub-loader" />
            <span>SCANNING MARKETPLACE...</span>
          </div>
        ) : sortedSkills.length === 0 ? (
          <div className="ub-empty">
            <div className="ub-empty-icon">NULL</div>
            <p>No skills match your query</p>
          </div>
        ) : (
          <div className="ub-skills-grid">
            {sortedSkills.map((skill) => {
              const price = parseFloat(skill.priceUsdc || '0');
              const isFree = price === 0;

              return (
                <Link
                  key={skill.skillId}
                  to={`/skill/${skill.skillId}`}
                  className="ub-skill-card"
                >
                  <div className="ub-card-stripe" />

                  <div className="ub-card-header">
                    <div className="ub-card-tags">
                      <span className={`ub-tag ${skill.category === 'workflow' ? 'ub-tag-workflow' : 'ub-tag-api'}`}>
                        {skill.category === 'workflow' ? 'WORKFLOW' : 'API'}
                      </span>
                      <BadgeChip badge={skill.badge} />
                      {skill.authType && skill.authType !== 'none' && (
                        <span className="ub-tag ub-tag-auth">{skill.authType}</span>
                      )}
                    </div>
                    <div className={`ub-card-price ${isFree ? 'free' : ''}`}>
                      {isFree ? 'FREE' : `$${price.toFixed(2)}`}
                    </div>
                  </div>

                  <h3 className="ub-card-name">{skill.name}</h3>

                  <p className="ub-card-desc">
                    {skill.description || 'No description available'}
                  </p>

                  <div className="ub-card-footer">
                    <span className="ub-card-domain">
                      {skill.domain || skill.serviceName || 'API'}
                    </span>
                    <div className="ub-card-stats">
                      {skill.downloadCount > 0 && (
                        <span className="ub-card-downloads">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                          </svg>
                          {skill.downloadCount.toLocaleString()}
                        </span>
                      )}
                      {skill.qualityScore >= 80 && (
                        <span className="ub-quality">VERIFIED</span>
                      )}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Final CTA */}
      <section className="ub-cta">
        <div className="ub-cta-bg" />
        <div className="ub-cta-content">
          <h2>EVERY API YOU'VE EVER WORKED WITH<br/>IS AN OPPORTUNITY.</h2>
          <p>Capture it once. Earn forever.</p>
          <div className="ub-cta-buttons">
            <a
              href="https://github.com/lekt9/unbrowse-openclaw"
              target="_blank"
              rel="noopener"
              className="ub-btn ub-btn-primary"
            >
              <span className="ub-btn-glow" />
              START EARNING
            </a>
            <Link to="/docs" className="ub-btn ub-btn-ghost">
              READ DOCS
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="ub-footer">
        <div className="ub-footer-inner">
          <div className="ub-footer-brand">
            <span className="ub-footer-logo">
              <span className="ub-footer-mark">//</span>
              UNBROWSE
            </span>
            <span className="ub-footer-tagline">Reverse engineer. Monetize. Repeat.</span>
          </div>
          <nav className="ub-footer-nav">
            <a href="https://github.com/lekt9/unbrowse-openclaw" target="_blank" rel="noopener">GitHub</a>
            <Link to="/docs">Docs</Link>
            <a href="https://agentskills.io" target="_blank" rel="noopener">Agent Skills Spec</a>
          </nav>
        </div>
      </footer>

      {/* Copy Page Button (for LLMs) */}
      <button
        className="ub-copy-page-btn"
        onClick={() => window.copyPageAsMarkdown?.()}
        title="Copy page as markdown"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <span>Copy for LLM</span>
      </button>
    </div>
  );
}
