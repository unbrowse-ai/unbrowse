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
  const [featuredSkills, setFeaturedSkills] = useState([]);
  const [trendingSkills, setTrendingSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [stats, setStats] = useState({ total: 0, services: 0, downloads: 0 });
  const [activeFilter, setActiveFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [badgeFilter, setBadgeFilter] = useState('all');
  const [showMarketplace, setShowMarketplace] = useState(false);
  const marketplaceRef = useRef(null);

  useEffect(() => {
    loadAllData();
  }, []);

  const loadAllData = async () => {
    setLoading(true);
    try {
      // Fetch all data in parallel
      const [skillsRes, featuredRes, trendingRes] = await Promise.all([
        fetch(`${API_BASE}/marketplace/skills?limit=100`),
        fetch(`${API_BASE}/marketplace/featured?limit=20`).catch(() => null),
        fetch(`${API_BASE}/marketplace/trending?period=7d&limit=10`).catch(() => null),
      ]);

      if (skillsRes.ok) {
        const data = await skillsRes.json();
        const skillsList = data.skills || [];
        setSkills(skillsList);

        const services = new Set(skillsList.map(s => s.serviceName).filter(Boolean)).size;
        const totalDownloads = skillsList.reduce((sum, s) => sum + (s.downloadCount || 0), 0);
        setStats({ total: skillsList.length, services, downloads: totalDownloads });
      }

      if (featuredRes?.ok) {
        const data = await featuredRes.json();
        setFeaturedSkills(data.skills || []);
      }

      if (trendingRes?.ok) {
        const data = await trendingRes.json();
        setTrendingSkills(data.skills || []);
      }
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

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
  }).filter(skill => {
    if (badgeFilter === 'all') return true;
    return skill.badge === badgeFilter;
  });

  // Sort by downloads, but put badged skills first
  const sortedSkills = [...filteredSkills].sort((a, b) => {
    // Official/highlighted badges first
    const badgePriority = { official: 0, highlighted: 1, verified: 2 };
    const aPriority = a.badge ? (badgePriority[a.badge] ?? 3) : 4;
    const bPriority = b.badge ? (badgePriority[b.badge] ?? 3) : 4;
    if (aPriority !== bPriority) return aPriority - bPriority;
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
            <span>EVERY WEBSITE HAS A HIDDEN API. WE CAPTURE IT.</span>
          </div>

          <h1 className="ub-headline">
            <span className="ub-headline-top">INTERNAL APIs</span>
            <span className="ub-headline-main">
              <span className="ub-glitch" data-text="FOR OPENCLAW.">FOR OPENCLAW.</span>
            </span>
          </h1>

          <p className="ub-tagline">
            When you click a button, your browser calls an internal API. We capture those endpoints —
            <strong> your agent skips the browser and calls APIs directly. 100x faster.</strong>
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
              <span className="ub-hero-stat-label">Internal APIs Captured</span>
            </div>
            <div className="ub-hero-stat-divider" />
            <div className="ub-hero-stat">
              <span className="ub-hero-stat-num">{stats.services}</span>
              <span className="ub-hero-stat-label">Websites</span>
            </div>
            <div className="ub-hero-stat-divider" />
            <div className="ub-hero-stat">
              <span className="ub-hero-stat-num">{stats.downloads.toLocaleString()}</span>
              <span className="ub-hero-stat-label">Agent Downloads</span>
            </div>
          </div>
        </div>
      </section>

      {/* What is an Internal API? - Educational Section */}
      <section className="ub-internal-api-explainer">
        <div className="ub-explainer-header">
          <span className="ub-explainer-label">// THE HIDDEN LAYER</span>
          <h2>What is an Internal API?</h2>
          <p>Every website you use is powered by hidden API calls. Unbrowse makes them visible to your agent.</p>
        </div>

        <div className="ub-explainer-demo">
          {/* Website UI Mock */}
          <div className="ub-website-mock">
            <div className="ub-mock-header">
              <div className="ub-mock-dots"><span /><span /><span /></div>
              <div className="ub-mock-url">polymarket.com</div>
            </div>
            <div className="ub-mock-content">
              <div className="ub-mock-card">
                <div className="ub-mock-title">2024 Election</div>
                <div className="ub-mock-odds">
                  <span className="ub-mock-candidate">Trump <strong>54¢</strong></span>
                  <span className="ub-mock-candidate">Harris <strong>46¢</strong></span>
                </div>
                <button className="ub-mock-btn">Buy Shares</button>
              </div>
            </div>
            <div className="ub-mock-caption">What you see</div>
          </div>

          {/* Arrow */}
          <div className="ub-explainer-arrow">
            <div className="ub-arrow-line" />
            <div className="ub-arrow-label">
              <span>When you click</span>
              <span>"Buy Shares"</span>
              <span>the browser sends:</span>
            </div>
          </div>

          {/* Internal API Request */}
          <div className="ub-api-reveal">
            <div className="ub-api-header">
              <span className="ub-api-method ub-method-post">POST</span>
              <span className="ub-api-endpoint">/api/v1/orders</span>
            </div>
            <div className="ub-api-body">
              <pre>{`{
  "market_id": "election-2024",
  "outcome": "trump",
  "shares": 100,
  "price": 0.54
}`}</pre>
            </div>
            <div className="ub-api-response">
              <span className="ub-response-status">200 OK</span>
              <span className="ub-response-time">89ms</span>
            </div>
            <div className="ub-mock-caption">The internal API call</div>
          </div>
        </div>

        <div className="ub-explainer-insight">
          <div className="ub-insight-icon">💡</div>
          <div className="ub-insight-text">
            <strong>This is the internal API.</strong> Every button, every page load, every action on a website triggers API calls.
            Unbrowse captures these endpoints so your agent can call them directly — no browser needed.
          </div>
        </div>
      </section>

      {/* Speed Comparison */}
      <section className="ub-comparison-section">
        <div className="ub-comparison-header">
          <h2>Browser Automation vs Internal APIs</h2>
          <p>Why wait 45 seconds when the data is one API call away?</p>
        </div>

        <div className="ub-comparison-grid">
          {/* Without Unbrowse */}
          <div className="ub-comparison-card ub-comparison-slow">
            <div className="ub-comparison-label">
              <span className="ub-label-icon">🐌</span>
              WITHOUT UNBROWSE
            </div>
            <div className="ub-comparison-flow">
              <div className="ub-flow-step">
                <span className="ub-step-icon">🌐</span>
                <span className="ub-step-text">Launch browser</span>
                <span className="ub-step-time">5s</span>
              </div>
              <div className="ub-flow-step">
                <span className="ub-step-icon">📄</span>
                <span className="ub-step-text">Load page</span>
                <span className="ub-step-time">3s</span>
              </div>
              <div className="ub-flow-step">
                <span className="ub-step-icon">⏳</span>
                <span className="ub-step-text">Wait for JavaScript</span>
                <span className="ub-step-time">2s</span>
              </div>
              <div className="ub-flow-step">
                <span className="ub-step-icon">🔍</span>
                <span className="ub-step-text">Find element</span>
                <span className="ub-step-time">1s</span>
              </div>
              <div className="ub-flow-step">
                <span className="ub-step-icon">🖱️</span>
                <span className="ub-step-text">Click & extract</span>
                <span className="ub-step-time">1s</span>
              </div>
            </div>
            <div className="ub-comparison-total">
              <span className="ub-total-label">Total time</span>
              <span className="ub-total-value ub-total-slow">~12 seconds</span>
            </div>
            <div className="ub-comparison-issues">
              <span>❌ Fragile selectors</span>
              <span>❌ JS rendering delays</span>
              <span>❌ Heavy memory usage</span>
            </div>
          </div>

          {/* With Unbrowse */}
          <div className="ub-comparison-card ub-comparison-fast">
            <div className="ub-comparison-label">
              <span className="ub-label-icon">⚡</span>
              WITH UNBROWSE
            </div>
            <div className="ub-comparison-flow ub-flow-simple">
              <div className="ub-flow-step ub-step-highlight">
                <span className="ub-step-icon">📡</span>
                <span className="ub-step-text">Call internal API</span>
                <span className="ub-step-time ub-time-fast">200ms</span>
              </div>
              <div className="ub-flow-step ub-step-highlight">
                <span className="ub-step-icon">📦</span>
                <span className="ub-step-text">Get JSON response</span>
                <span className="ub-step-time ub-time-fast">done</span>
              </div>
            </div>
            <div className="ub-comparison-total">
              <span className="ub-total-label">Total time</span>
              <span className="ub-total-value ub-total-fast">~200ms</span>
            </div>
            <div className="ub-comparison-benefits">
              <span>✓ Clean JSON data</span>
              <span>✓ 100x faster</span>
              <span>✓ Reliable & stable</span>
            </div>
            <div className="ub-speed-badge">60x FASTER</div>
          </div>
        </div>
      </section>

      {/* How It Works - With Demo */}
      <section className="ub-how-it-works">
        <div className="ub-how-header">
          <h2>Capture Any Website's Internal API</h2>
          <p>Log in once. We discover every endpoint. <strong>Your agent calls APIs directly — forever.</strong></p>
        </div>

        {/* 3-Step Flow */}
        <div className="ub-capture-flow">
          <div className="ub-capture-step">
            <div className="ub-step-number">1</div>
            <div className="ub-step-content">
              <h3>Browse & Capture</h3>
              <p>Navigate the site normally. Unbrowse intercepts every internal API call the browser makes.</p>
              <div className="ub-step-visual">
                <code>GET /api/markets → captured</code>
                <code>POST /api/orders → captured</code>
                <code>Auth headers → captured</code>
              </div>
            </div>
          </div>
          <div className="ub-capture-step">
            <div className="ub-step-number">2</div>
            <div className="ub-step-content">
              <h3>Generate Skill</h3>
              <p>We analyze the captured traffic and create a reusable "skill" — a complete map of the site's internal API.</p>
              <div className="ub-step-visual">
                <code>polymarket.getMarkets()</code>
                <code>polymarket.placeOrder()</code>
                <code>polymarket.getPortfolio()</code>
              </div>
            </div>
          </div>
          <div className="ub-capture-step">
            <div className="ub-step-number">3</div>
            <div className="ub-step-content">
              <h3>Call APIs Directly</h3>
              <p>Your agent calls the internal API. No browser, no waiting, no fragile selectors.</p>
              <div className="ub-step-visual ub-step-result">
                <span className="ub-result-time">200ms</span>
                <span className="ub-result-label">Clean JSON response</span>
              </div>
            </div>
          </div>
        </div>

        {/* Demo: Chat + Terminal */}
        <div className="ub-demo-split">
          {/* Chat Interface */}
          <div className="ub-chat">
            <div className="ub-chat-header">
              <div className="ub-chat-avatar">⚡</div>
              <span className="ub-chat-title">Agent Demo</span>
            </div>
            <div className="ub-chat-body">
              <div className="ub-chat-msg ub-chat-user">
                <span className="ub-msg-text">What are the odds on the election on Polymarket?</span>
              </div>
              <div className="ub-chat-msg ub-chat-agent">
                <span className="ub-msg-text">I'll capture Polymarket's internal API. Log in once:</span>
              </div>
              <div className="ub-chat-msg ub-chat-system">
                <span className="ub-msg-browser">🌐 Browser opened → Log in to Polymarket</span>
              </div>
              <div className="ub-chat-msg ub-chat-agent">
                <span className="ub-msg-text"><strong>12 internal API endpoints discovered.</strong> Browser closed forever.</span>
                <span className="ub-msg-status">✓ polymarket skill saved</span>
              </div>
              <div className="ub-chat-msg ub-chat-agent">
                <span className="ub-msg-text">Trump 54¢, Harris 46¢. Want to place a bet?</span>
                <span className="ub-msg-status">✓ Called GET /api/markets in 89ms</span>
              </div>
            </div>
          </div>

          {/* Terminal */}
          <div className="ub-terminal">
            <div className="ub-terminal-header">
              <div className="ub-terminal-dots">
                <span /><span /><span />
              </div>
              <span className="ub-terminal-title">internal API discovery</span>
            </div>
            <div className="ub-terminal-body">
              <div className="ub-term-line ub-term-comment"># One-time: capture internal APIs</div>
              <div className="ub-term-line">
                <span className="ub-term-prompt">→</span>
                <span className="ub-term-cmd">unbrowse_capture <span className="ub-term-arg">"polymarket.com"</span></span>
              </div>
              <div className="ub-term-line ub-term-output">
                <span className="ub-term-success">[DISCOVERED]</span> GET /api/markets
              </div>
              <div className="ub-term-line ub-term-output">
                <span className="ub-term-success">[DISCOVERED]</span> POST /api/orders
              </div>
              <div className="ub-term-line ub-term-output">
                <span className="ub-term-success">[AUTH]</span> Bearer token + 8 cookies
              </div>
              <div className="ub-term-line ub-term-comment"># Forever after: direct API calls</div>
              <div className="ub-term-line">
                <span className="ub-term-prompt">→</span>
                <span className="ub-term-cmd">unbrowse_replay <span className="ub-term-arg">"get_markets"</span></span>
              </div>
              <div className="ub-term-line ub-term-output ub-term-final">
                <span className="ub-term-success">[INTERNAL API]</span> 200 OK <span className="ub-term-money">89ms</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Featured Skills (badged) */}
      {featuredSkills.length > 0 && !search && (
        <section className="ub-featured-section">
          <div className="ub-section-header">
            <h2>⭐ Featured Skills</h2>
            <p>Official and verified skills from the community</p>
          </div>
          <div className="ub-featured-grid">
            {featuredSkills.slice(0, 4).map((skill) => {
              const price = parseFloat(skill.priceUsdc || '0');
              const isFree = price === 0;
              return (
                <Link key={skill.skillId} to={`/skill/${skill.skillId}`} className="ub-featured-card">
                  <div className="ub-featured-badge">
                    <BadgeChip badge={skill.badge} />
                  </div>
                  <h3>{skill.name}</h3>
                  <p>{skill.description || `API skill for ${skill.serviceName || skill.domain}`}</p>
                  <div className="ub-featured-footer">
                    <span className="ub-service-name">{skill.serviceName || skill.domain}</span>
                    <span className={`ub-price ${isFree ? 'free' : ''}`}>
                      {isFree ? 'FREE' : `$${price.toFixed(2)}`}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Trending Skills */}
      {trendingSkills.length > 0 && !search && (
        <section className="ub-trending-section">
          <div className="ub-section-header">
            <h2>🔥 Trending This Week</h2>
            <p>Skills with the highest download velocity</p>
          </div>
          <div className="ub-trending-grid">
            {trendingSkills.slice(0, 6).map((skill) => {
              const price = parseFloat(skill.priceUsdc || '0');
              const isFree = price === 0;
              return (
                <Link key={skill.skillId} to={`/skill/${skill.skillId}`} className="ub-trending-card">
                  <div className="ub-trending-header">
                    <span className="ub-service-name">{skill.serviceName || skill.domain}</span>
                    {skill.velocity > 0 && (
                      <span className="ub-velocity">↑{Math.round(skill.velocity * 100)}%</span>
                    )}
                  </div>
                  <h3>{skill.name}</h3>
                  <div className="ub-trending-footer">
                    <span className="ub-downloads">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                      </svg>
                      {(skill.downloadCount || 0).toLocaleString()}
                    </span>
                    <span className={`ub-price ${isFree ? 'free' : ''}`}>
                      {isFree ? 'FREE' : `$${price.toFixed(2)}`}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

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
            <div className="ub-filter-group">
              <span className="ub-filter-label">Badge:</span>
              <div className="ub-filter-tabs">
                {['all', 'official', 'verified', 'highlighted'].map(f => (
                  <button
                    key={f}
                    className={`ub-filter-tab ${badgeFilter === f ? 'active' : ''}`}
                    onClick={() => setBadgeFilter(f)}
                  >
                    {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
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
            <a href="https://www.npmjs.com/package/@getfoundry/unbrowse-openclaw" target="_blank" rel="noopener" className="ub-btn ub-btn-primary">
              npm
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
            <a href="https://www.npmjs.com/package/@getfoundry/unbrowse-openclaw" target="_blank" rel="noopener">npm</a>
            <Link to="/docs">Docs</Link>
            <a href="https://agentskills.io" target="_blank" rel="noopener">Agent Skills Spec</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
