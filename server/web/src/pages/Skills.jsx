import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';

const API_BASE = 'https://index.unbrowse.ai';

// Animated constellation effect
function Constellation() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let animationId;
    let particles = [];

    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    };

    resize();
    window.addEventListener('resize', resize);

    // Create particles (stars/nodes)
    for (let i = 0; i < 60; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        radius: Math.random() * 1.5 + 0.5,
        alpha: Math.random() * 0.5 + 0.2
      });
    }

    const draw = () => {
      ctx.fillStyle = 'rgba(2, 3, 8, 0.1)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Update and draw particles
      particles.forEach((p, i) => {
        p.x += p.vx;
        p.y += p.vy;

        // Wrap around
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;

        // Draw particle
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(251, 191, 36, ${p.alpha})`;
        ctx.fill();

        // Draw connections
        particles.slice(i + 1).forEach(p2 => {
          const dist = Math.hypot(p.x - p2.x, p.y - p2.y);
          if (dist < 120) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = `rgba(251, 191, 36, ${0.1 * (1 - dist / 120)})`;
            ctx.stroke();
          }
        });
      });

      animationId = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        opacity: 0.6
      }}
    />
  );
}

export default function Skills() {
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [stats, setStats] = useState({ total: 0, services: 0, downloads: 0 });
  const [activeFilter, setActiveFilter] = useState('all');
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const loaderRef = useRef(null);
  const LIMIT = 50;

  useEffect(() => {
    loadMarketplaceSkills();
  }, []);

  // Infinite scroll observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore && !loading) {
          loadMoreSkills();
        }
      },
      { threshold: 0.1, rootMargin: '100px' }
    );

    if (loaderRef.current) {
      observer.observe(loaderRef.current);
    }

    return () => observer.disconnect();
  }, [hasMore, loadingMore, loading, offset, search]);

  const loadMarketplaceSkills = async (query = '', reset = true) => {
    if (reset) {
      setLoading(true);
      setOffset(0);
      setHasMore(true);
    }
    try {
      const url = query.trim()
        ? `${API_BASE}/marketplace/skills?q=${encodeURIComponent(query)}&limit=${LIMIT}&offset=0`
        : `${API_BASE}/marketplace/skills?limit=${LIMIT}&offset=0`;

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const skillsList = data.skills || [];
        setSkills(skillsList);
        setOffset(LIMIT);
        setHasMore(skillsList.length === LIMIT);

        // Update stats from API response if available, otherwise compute locally
        if (data.total !== undefined) {
          setStats({
            total: data.total,
            services: data.services || new Set(skillsList.map(s => s.serviceName).filter(Boolean)).size,
            downloads: data.downloads || skillsList.reduce((sum, s) => sum + (s.downloadCount || 0), 0)
          });
        } else {
          const services = new Set(skillsList.map(s => s.serviceName).filter(Boolean)).size;
          const totalDownloads = skillsList.reduce((sum, s) => sum + (s.downloadCount || 0), 0);
          setStats({ total: skillsList.length, services, downloads: totalDownloads });
        }
      }
    } catch (err) {
      console.error('Failed to load skills:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadMoreSkills = async () => {
    if (loadingMore || !hasMore) return;

    setLoadingMore(true);
    try {
      const url = search.trim()
        ? `${API_BASE}/marketplace/skills?q=${encodeURIComponent(search)}&limit=${LIMIT}&offset=${offset}`
        : `${API_BASE}/marketplace/skills?limit=${LIMIT}&offset=${offset}`;

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const newSkills = data.skills || [];

        if (newSkills.length > 0) {
          setSkills(prev => [...prev, ...newSkills]);
          setOffset(prev => prev + LIMIT);
        }

        setHasMore(newSkills.length === LIMIT);
      }
    } catch (err) {
      console.error('Failed to load more skills:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    loadMarketplaceSkills(search, true);
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
  });

  const sortedSkills = [...filteredSkills].sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0));

  return (
    <div className="ub-page">
      {/* Hero - The Vision */}
      <section className="ub-hero">
        <div className="ub-hero-bg">
          <Constellation />
          <div className="ub-gradient-orb" />
          <div className="ub-grid-lines" />
        </div>

        <div className="ub-hero-content">
          <div className="ub-kicker">
            <span className="ub-kicker-dot" />
            <span>NOW IN PUBLIC BETA</span>
          </div>

          <div className="ub-vision">
            <p className="ub-vision-context">
              Google organized the web for humans.
              <br />
              Nothing has organized it for agents.
            </p>
            <h1 className="ub-vision-main">
              THE <span className="ub-vision-accent">AGENTIC WEB</span>
            </h1>
          </div>

          <p className="ub-subhead">
            An index of every API on the internet as skills—discovered automatically,
            paid for with micropayments. <strong>And the agents who map it get paid.</strong>
          </p>

          <div className="ub-cta-row">
            <a
              href="https://github.com/lekt9/unbrowse-openclaw"
              target="_blank"
              rel="noopener"
              className="ub-btn ub-btn-primary"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
              </svg>
              START MAPPING
            </a>
            <Link to="/docs" className="ub-btn ub-btn-ghost">
              HOW IT WORKS
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </Link>
          </div>
        </div>

        {/* Speed Comparison */}
        <div className="ub-comparison">
          <div className="ub-compare-card old">
            <div className="ub-compare-label">Browser Automation</div>
            <div className="ub-compare-time">45s</div>
            <div className="ub-compare-method">Launch Chrome, render, scrape, fail 20%</div>
          </div>
          <div className="ub-compare-arrow">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </div>
          <div className="ub-compare-card new">
            <div className="ub-compare-label">Unbrowse Skill</div>
            <div className="ub-compare-time">200ms</div>
            <div className="ub-compare-method">Direct API call, clean JSON, 95%+ success</div>
          </div>
        </div>
      </section>

      {/* Value Props - How It Works */}
      <section className="ub-value-section">
        <div className="ub-section-header">
          <div className="ub-section-kicker">The Flywheel</div>
          <h2 className="ub-section-title">MAP. PUBLISH. EARN.</h2>
        </div>

        <div className="ub-value-grid">
          <div className="ub-value-card">
            <div className="ub-value-step">01</div>
            <div className="ub-value-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/>
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
              </svg>
            </div>
            <h3>CAPTURE</h3>
            <p>
              Browse any website. Unbrowse intercepts every API call—endpoints,
              auth headers, payloads. One session maps an entire service.
            </p>
          </div>

          <div className="ub-value-card">
            <div className="ub-value-step">02</div>
            <div className="ub-value-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
              </svg>
            </div>
            <h3>GENERATE</h3>
            <p>
              AI transforms raw traffic into production-ready skills with typed schemas,
              auth handling, and documentation. Ready for any agent to use.
            </p>
          </div>

          <div className="ub-value-card featured">
            <div className="ub-value-step">03</div>
            <div className="ub-value-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
              </svg>
            </div>
            <h3>MONETIZE</h3>
            <p>
              Publish to the marketplace. Set your price. Earn 70% of every download
              in USDC via x402 micropayments. Your skills work while you sleep.
            </p>
            <div className="ub-value-highlight">
              <div className="ub-value-stat">{stats.downloads.toLocaleString()}</div>
              <div className="ub-value-stat-label">TOTAL DOWNLOADS</div>
            </div>
          </div>
        </div>
      </section>

      {/* Stats Strip */}
      <section className="ub-stats-strip">
        <div className="ub-stat-block">
          <div className="ub-stat-num">{stats.total}</div>
          <div className="ub-stat-label">Skills Indexed</div>
        </div>
        <div className="ub-stat-divider" />
        <div className="ub-stat-block">
          <div className="ub-stat-num">{stats.services}</div>
          <div className="ub-stat-label">APIs Mapped</div>
        </div>
        <div className="ub-stat-divider" />
        <div className="ub-stat-block">
          <div className="ub-stat-num">70%</div>
          <div className="ub-stat-label">Creator Revenue</div>
        </div>
        <div className="ub-stat-divider" />
        <div className="ub-stat-block">
          <div className="ub-stat-num">USDC</div>
          <div className="ub-stat-label">Instant Payouts</div>
        </div>
      </section>

      {/* Marketplace */}
      <section className="ub-marketplace">
        <div className="ub-marketplace-header">
          <h2 className="ub-marketplace-title">
            <span className="ub-title-accent">//</span>
            SKILL MARKETPLACE
          </h2>

          <div className="ub-marketplace-controls">
            <div className="ub-filter-tabs">
              {['all', 'free', 'paid'].map(f => (
                <button
                  key={f}
                  className={`ub-filter-tab ${activeFilter === f ? 'active' : ''}`}
                  onClick={() => setActiveFilter(f)}
                >
                  {f}
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
                placeholder="Search skills, APIs, services..."
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
            <span className="ub-loading-text">Indexing the Agentic Web...</span>
          </div>
        ) : sortedSkills.length === 0 ? (
          <div className="ub-empty">
            <div className="ub-empty-icon">∅</div>
            <p>No skills match your query</p>
          </div>
        ) : (
          <>
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
                        {skill.category && (
                          <span className="ub-tag ub-tag-cat">{skill.category}</span>
                        )}
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

            {/* Infinite scroll loader */}
            <div ref={loaderRef} className="ub-infinite-loader">
              {loadingMore && (
                <>
                  <div className="ub-loader small" />
                  <span>Loading more skills...</span>
                </>
              )}
              {!hasMore && skills.length > 0 && (
                <span className="ub-end-message">All {skills.length} skills loaded</span>
              )}
            </div>
          </>
        )}
      </section>

      {/* Flywheel explanation */}
      <section className="ub-flywheel">
        <div className="ub-flywheel-inner">
          <h2>THE NETWORK EFFECT</h2>
          <p className="ub-flywheel-desc">
            Google's crawlers worked for free. Ours don't. Every API you map becomes
            a skill that other agents can buy—and you earn 70% on every download.
            More mappers means more skills. More skills means faster agents. Faster
            agents means more demand. The flywheel spins.
          </p>
          <div className="ub-flywheel-chain">
            <span className="ub-chain-step">More Mappers</span>
            <span className="ub-chain-arrow">→</span>
            <span className="ub-chain-step">More Skills</span>
            <span className="ub-chain-arrow">→</span>
            <span className="ub-chain-step">Faster Agents</span>
            <span className="ub-chain-arrow">→</span>
            <span className="ub-chain-step">More Demand</span>
            <span className="ub-chain-arrow">→</span>
            <span className="ub-chain-step highlight">More Earnings</span>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="ub-cta">
        <div className="ub-cta-bg" />
        <div className="ub-cta-content">
          <h2>THE HUMAN WEB HAS GOOGLE.<br/>THE AGENTIC WEB HAS UNBROWSE.</h2>
          <p>Every website already has an API. Your agent just didn't know about it.</p>
          <div className="ub-cta-buttons">
            <a
              href="https://github.com/lekt9/unbrowse-openclaw"
              target="_blank"
              rel="noopener"
              className="ub-btn ub-btn-primary"
            >
              START MAPPING
            </a>
            <Link to="/docs" className="ub-btn ub-btn-ghost">
              READ THE DOCS
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
            <span className="ub-footer-tagline">Mapping the Agentic Web</span>
          </div>
          <nav className="ub-footer-nav">
            <a href="https://github.com/lekt9/unbrowse-openclaw" target="_blank" rel="noopener">GitHub</a>
            <Link to="/docs">Docs</Link>
            <a href="https://agentskills.io" target="_blank" rel="noopener">Agent Skills Spec</a>
            <a href="https://x.com/getFoundry" target="_blank" rel="noopener">@getFoundry</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
