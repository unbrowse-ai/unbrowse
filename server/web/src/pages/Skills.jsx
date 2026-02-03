import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';

const API_BASE = 'https://index.unbrowse.ai';

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
  const [search, setSearch] = useState('');
  const [stats, setStats] = useState({ total: 0, services: 0, downloads: 0 });
  const navigate = useNavigate();

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      const res = await fetch(`${API_BASE}/marketplace/skills?limit=100`);
      if (res.ok) {
        const data = await res.json();
        const skillsList = data.skills || [];
        const services = new Set(skillsList.map(s => s.serviceName).filter(Boolean)).size;
        const totalDownloads = skillsList.reduce((sum, s) => sum + (s.downloadCount || 0), 0);
        setStats({ total: skillsList.length, services, downloads: totalDownloads });
      }
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    navigate(search.trim() ? `/marketplace?q=${encodeURIComponent(search)}` : '/marketplace');
  };

  return (
    <div className="ub-page">
      {/* Hero */}
      <section className="ub-hero ub-hero-compact">
        <div className="ub-hero-bg">
          <div className="ub-grid-overlay" />
          <CodeRain />
          <div className="ub-scanlines" />
        </div>

        <div className="ub-hero-content">
          <div className="ub-hero-badge">
            <span className="ub-pulse" />
            <span>GOOGLE FOR OPENCLAW</span>
          </div>

          <div className="ub-hero-headline-row">
            <h1 className="ub-headline">
              <span className="ub-headline-top">ONE AGENT LEARNS.</span>
              <span className="ub-headline-main">
                <span className="ub-glitch" data-text="ALL AGENTS KNOW.">ALL AGENTS KNOW.</span>
              </span>
            </h1>
            <img src="/mascot.png" alt="Unbrowse mascot" className="ub-mascot" />
          </div>

          <p className="ub-tagline">
            Search for skills. Download. Your agent calls internal APIs in 200ms instead of browser automation in 45 seconds.
          </p>

          {/* Search — navigates to /marketplace */}
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

          {/* Quick links */}
          <div className="ub-hero-tags">
            <Link to="/marketplace" className="ub-hero-tag ub-hero-tag-browse">
              Browse All Skills →
            </Link>
          </div>

          {/* Stats */}
          <div className="ub-hero-stats">
            <div className="ub-hero-stat">
              <span className="ub-hero-stat-num">{stats.total}</span>
              <span className="ub-hero-stat-label">Skills</span>
            </div>
            <div className="ub-hero-stat-divider" />
            <div className="ub-hero-stat">
              <span className="ub-hero-stat-num">{stats.services}</span>
              <span className="ub-hero-stat-label">Websites</span>
            </div>
            <div className="ub-hero-stat-divider" />
            <div className="ub-hero-stat">
              <span className="ub-hero-stat-num">{stats.downloads.toLocaleString()}</span>
              <span className="ub-hero-stat-label">Downloads</span>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works — concise */}
      <section className="ub-how-it-works">
        <div className="ub-how-header">
          <h2>How It Works</h2>
          <p>Every website has internal APIs. We capture them so your OpenClaw agent can skip the browser.</p>
        </div>

        <div className="ub-capture-flow">
          <div className="ub-capture-step">
            <div className="ub-step-number">1</div>
            <div className="ub-step-content">
              <h3>Browse & Capture</h3>
              <p>Navigate any site. Unbrowse intercepts every internal API call.</p>
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
              <p>We create a reusable skill — a complete map of the site's API.</p>
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
              <h3>200ms API Calls</h3>
              <p>Your agent calls internal APIs directly. No browser. No waiting.</p>
              <div className="ub-step-visual ub-step-result">
                <span className="ub-result-time">200ms</span>
                <span className="ub-result-label">vs 45s with browser automation</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Install CTA */}
      <section className="ub-install-section">
        <div className="ub-install-content">
          <h2>Get started</h2>
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

      {/* Footer */}
      <footer className="ub-footer">
        <div className="ub-footer-inner">
          <div className="ub-footer-brand">
            <span className="ub-footer-logo">// UNBROWSE</span>
            <span className="ub-footer-tagline">Google for OpenClaw</span>
          </div>
          <nav className="ub-footer-nav">
            <Link to="/marketplace">Marketplace</Link>
            <a href="https://www.npmjs.com/package/@getfoundry/unbrowse-openclaw" target="_blank" rel="noopener">npm</a>
            <Link to="/docs">Docs</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
