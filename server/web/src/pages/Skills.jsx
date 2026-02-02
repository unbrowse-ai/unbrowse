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
  const [activeFilter, setActiveFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [showMarketplace, setShowMarketplace] = useState(false);
  const marketplaceRef = useRef(null);

  useEffect(() => {
    loadMarketplaceSkills();
  }, []);

  const loadMarketplaceSkills = async (query = '') => {
    setLoading(true);
    try {
      let url = `${API_BASE}/marketplace/skills?limit=100`;
      if (query.trim()) {
        url += `&q=${encodeURIComponent(query)}`;
      }

      const skillsRes = await fetch(url);

      if (skillsRes.ok) {
        const data = await skillsRes.json();
        const skillsList = data.skills || [];
        setSkills(skillsList);

        const services = new Set(skillsList.map(s => s.serviceName).filter(Boolean)).size;
        const totalDownloads = skillsList.reduce((sum, s) => sum + (s.downloadCount || 0), 0);
        setStats({ total: skillsList.length, services, downloads: totalDownloads });
      }
    } catch (err) {
      console.error('Failed to load skills:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    setShowMarketplace(true);
    loadMarketplaceSkills(search);
    // Scroll to marketplace
    setTimeout(() => {
      marketplaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  const scrollToMarketplace = () => {
    setShowMarketplace(true);
    setTimeout(() => {
      marketplaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  const filteredSkills = skills.filter(skill => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      skill.name?.toLowerCase().includes(q) ||
      skill.description?.toLowerCase().includes(q) ||
      skill.domain?.toLowerCase().includes(q) ||
      skill.serviceName?.toLowerCase().includes(q)
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

  // Sort by downloads
  const sortedSkills = [...filteredSkills].sort((a, b) => {
    return (b.downloadCount || 0) - (a.downloadCount || 0);
  });

  // Get unique services for tags
  const topServices = Array.from(new Set(skills.map(s => s.serviceName).filter(Boolean))).slice(0, 8);

  return (
    <div className="ub-page">
      {/* Hero - Compact */}
      <section className="ub-hero ub-hero-compact">
        <div className="ub-hero-bg">
          <div className="ub-grid-overlay" />
          <CodeRain />
          <div className="ub-scanlines" />
        </div>

        <div className="ub-hero-content">
          <div className="ub-hero-badge">
            <span className="ub-pulse" />
            <span>API REVERSE ENGINEERING FOR AI AGENTS</span>
          </div>

          <h1 className="ub-headline">
            <span className="ub-headline-top">BROWSE ONCE.</span>
            <span className="ub-headline-main">
              <span className="ub-glitch" data-text="API FOREVER.">API FOREVER.</span>
            </span>
          </h1>

          <p className="ub-tagline">
            Log in once. We capture cookies, tokens, and headers.
            <strong> Your agent calls APIs directly — no browser needed.</strong>
          </p>

          {/* Primary Search */}
          <form onSubmit={handleSearch} className="ub-hero-search">
            <div className="ub-hero-search-wrapper">
              <svg className="ub-hero-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                type="text"
                placeholder="Search skills... polymarket, stripe, notion..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="ub-hero-search-input"
              />
              <button type="submit" className="ub-hero-search-btn">
                SEARCH
              </button>
            </div>
          </form>

          {/* Quick tags */}
          <div className="ub-hero-tags">
            {topServices.map(tag => (
              <button
                key={tag}
                type="button"
                className="ub-hero-tag"
                onClick={() => {
                  setSearch(tag);
                  setShowMarketplace(true);
                  loadMarketplaceSkills(tag);
                  setTimeout(() => {
                    marketplaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }, 100);
                }}
              >
                {tag}
              </button>
            ))}
            <button
              type="button"
              className="ub-hero-tag ub-hero-tag-browse"
              onClick={scrollToMarketplace}
            >
              Browse All →
            </button>
          </div>

          {/* Stats inline */}
          <div className="ub-hero-stats">
            <div className="ub-hero-stat">
              <span className="ub-hero-stat-num">{stats.total}</span>
              <span className="ub-hero-stat-label">Skills</span>
            </div>
            <div className="ub-hero-stat-divider" />
            <div className="ub-hero-stat">
              <span className="ub-hero-stat-num">{stats.services}</span>
              <span className="ub-hero-stat-label">APIs</span>
            </div>
            <div className="ub-hero-stat-divider" />
            <div className="ub-hero-stat">
              <span className="ub-hero-stat-num">{stats.downloads.toLocaleString()}</span>
              <span className="ub-hero-stat-label">Downloads</span>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works - Mini */}
      <section className="ub-how-it-works">
        <div className="ub-how-grid">
          <div className="ub-how-step">
            <div className="ub-how-num">1</div>
            <div className="ub-how-content">
              <h3>Login Once</h3>
              <p>Browser opens, you authenticate. We capture cookies & tokens.</p>
            </div>
          </div>
          <div className="ub-how-arrow">→</div>
          <div className="ub-how-step">
            <div className="ub-how-num">2</div>
            <div className="ub-how-content">
              <h3>Browser Closes</h3>
              <p>That's it. Never opened again for this service.</p>
            </div>
          </div>
          <div className="ub-how-arrow">→</div>
          <div className="ub-how-step">
            <div className="ub-how-num">3</div>
            <div className="ub-how-content">
              <h3>Direct API Calls</h3>
              <p>Agent calls HTTP APIs directly. 100x faster.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Marketplace - Full Width */}
      <section className="ub-marketplace" ref={marketplaceRef}>
        <div className="ub-marketplace-header">
          <div className="ub-marketplace-title-row">
            <h2 className="ub-marketplace-title">
              <span className="ub-title-accent">//</span>
              {search ? `Results for "${search}"` : 'SKILL MARKETPLACE'}
            </h2>
            <span className="ub-marketplace-count">{sortedSkills.length} skills</span>
          </div>

          <div className="ub-marketplace-controls">
            <div className="ub-filter-group">
              <span className="ub-filter-label">Type:</span>
              <div className="ub-filter-tabs">
                {['all', 'api-package', 'workflow'].map(f => (
                  <button
                    key={f}
                    className={`ub-filter-tab ${categoryFilter === f ? 'active' : ''}`}
                    onClick={() => setCategoryFilter(f)}
                  >
                    {f === 'api-package' ? 'APIs' : f === 'workflow' ? 'Workflows' : 'All'}
                  </button>
                ))}
              </div>
            </div>
            <div className="ub-filter-group">
              <span className="ub-filter-label">Price:</span>
              <div className="ub-filter-tabs">
                {['all', 'free', 'paid'].map(f => (
                  <button
                    key={f}
                    className={`ub-filter-tab ${activeFilter === f ? 'active' : ''}`}
                    onClick={() => setActiveFilter(f)}
                  >
                    {f === 'all' ? 'All' : f === 'free' ? 'Free' : 'Paid'}
                  </button>
                ))}
              </div>
            </div>
            {search && (
              <button
                onClick={() => { setSearch(''); loadMarketplaceSkills(''); }}
                className="ub-clear-search"
              >
                Clear search ✕
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="ub-loading">
            <div className="ub-loader" />
            <span>Loading skills...</span>
          </div>
        ) : sortedSkills.length === 0 ? (
          <div className="ub-empty">
            <div className="ub-empty-icon">∅</div>
            <p>No skills found{search ? ` for "${search}"` : ''}</p>
            {search && (
              <button onClick={() => { setSearch(''); loadMarketplaceSkills(''); }} className="ub-btn ub-btn-ghost">
                View all skills
              </button>
            )}
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
                  <div className="ub-card-top">
                    <div className="ub-card-service">
                      <span className="ub-service-icon">
                        {(skill.serviceName || skill.domain || 'API').charAt(0).toUpperCase()}
                      </span>
                      <span className="ub-service-name">{skill.serviceName || skill.domain || 'API'}</span>
                    </div>
                    <div className={`ub-card-price ${isFree ? 'free' : ''}`}>
                      {isFree ? 'FREE' : `$${price.toFixed(2)}`}
                    </div>
                  </div>

                  <h3 className="ub-card-name">{skill.name}</h3>

                  <p className="ub-card-desc">
                    {skill.description || 'API skill for ' + (skill.serviceName || skill.domain || 'this service')}
                  </p>

                  <div className="ub-card-meta">
                    <div className="ub-card-tags">
                      <span className={`ub-tag ${skill.category === 'workflow' ? 'ub-tag-workflow' : 'ub-tag-api'}`}>
                        {skill.category === 'workflow' ? 'Workflow' : 'API'}
                      </span>
                      <BadgeChip badge={skill.badge} />
                    </div>
                  </div>

                  <div className="ub-card-footer">
                    <div className="ub-card-stats">
                      <span className="ub-card-downloads">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                        </svg>
                        {(skill.downloadCount || 0).toLocaleString()}
                      </span>
                      {skill.endpointCount > 0 && (
                        <span className="ub-card-endpoints">
                          {skill.endpointCount} endpoints
                        </span>
                      )}
                    </div>
                    <span className="ub-card-action">View →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* Install CTA */}
      <section className="ub-install-section">
        <div className="ub-install-content">
          <h2>Ready to use these skills?</h2>
          <p>Install the Unbrowse plugin for OpenClaw</p>
          <div className="ub-install-cmd">
            <code>openclaw plugins install @getfoundry/unbrowse-openclaw</code>
            <button
              className="ub-copy-cmd"
              onClick={() => {
                navigator.clipboard.writeText('openclaw plugins install @getfoundry/unbrowse-openclaw');
              }}
            >
              Copy
            </button>
          </div>
          <div className="ub-install-links">
            <a href="https://github.com/lekt9/unbrowse-openclaw" target="_blank" rel="noopener" className="ub-btn ub-btn-primary">
              GitHub
            </a>
            <Link to="/docs" className="ub-btn ub-btn-ghost">
              Documentation
            </Link>
          </div>
        </div>
      </section>

      {/* Creator CTA */}
      <section className="ub-creator-cta">
        <div className="ub-creator-content">
          <div className="ub-creator-text">
            <h2>Want to earn from your API skills?</h2>
            <p>Publish your captured APIs to the marketplace. Earn <strong>70% of every download</strong> in USDC.</p>
          </div>
          <Link to="/docs#publishing" className="ub-btn ub-btn-accent">
            Learn to Publish →
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="ub-footer">
        <div className="ub-footer-inner">
          <div className="ub-footer-brand">
            <span className="ub-footer-logo">// UNBROWSE</span>
            <span className="ub-footer-tagline">API reverse engineering for AI agents</span>
          </div>
          <nav className="ub-footer-nav">
            <a href="https://github.com/lekt9/unbrowse-openclaw" target="_blank" rel="noopener">GitHub</a>
            <Link to="/docs">Docs</Link>
            <a href="https://agentskills.io" target="_blank" rel="noopener">Agent Skills Spec</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
