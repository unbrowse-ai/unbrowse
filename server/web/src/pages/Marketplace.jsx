import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

const API_BASE = 'https://index.unbrowse.ai';

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

export default function Marketplace() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [skills, setSkills] = useState([]);
  const [featuredSkills, setFeaturedSkills] = useState([]);
  const [trendingSkills, setTrendingSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(searchParams.get('q') || '');
  const [activeFilter, setActiveFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [badgeFilter, setBadgeFilter] = useState('all');

  useEffect(() => {
    loadAllData();
  }, []);

  // Sync search from URL params on mount
  useEffect(() => {
    const q = searchParams.get('q');
    if (q) {
      setSearch(q);
      loadMarketplaceSkills(q);
    }
  }, []);

  const loadAllData = async () => {
    setLoading(true);
    try {
      const [skillsRes, featuredRes, trendingRes] = await Promise.all([
        fetch(`${API_BASE}/marketplace/skills?limit=100`),
        fetch(`${API_BASE}/marketplace/featured?limit=20`).catch(() => null),
        fetch(`${API_BASE}/marketplace/trending?period=7d&limit=10`).catch(() => null),
      ]);

      if (skillsRes.ok) {
        const data = await skillsRes.json();
        setSkills(data.skills || []);
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

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills || []);
      }
    } catch (err) {
      console.error('Failed to load skills:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    if (search.trim()) {
      setSearchParams({ q: search });
    } else {
      setSearchParams({});
    }
    loadMarketplaceSkills(search);
  };

  const clearSearch = () => {
    setSearch('');
    setSearchParams({});
    loadMarketplaceSkills('');
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

  const sortedSkills = [...filteredSkills].sort((a, b) => {
    const badgePriority = { official: 0, highlighted: 1, verified: 2 };
    const aPriority = a.badge ? (badgePriority[a.badge] ?? 3) : 4;
    const bPriority = b.badge ? (badgePriority[b.badge] ?? 3) : 4;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return (b.downloadCount || 0) - (a.downloadCount || 0);
  });

  return (
    <div className="ub-page">
      {/* Search Header */}
      <section className="ub-marketplace-hero">
        <div className="ub-marketplace-hero-inner">
          <h1 className="ub-marketplace-heading">
            <span className="ub-title-accent">//</span> Skill Marketplace
          </h1>
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
        </div>
      </section>

      {/* Featured Skills */}
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

      {/* All Skills */}
      <section className="ub-marketplace">
        <div className="ub-marketplace-header">
          <div className="ub-marketplace-title-row">
            <h2 className="ub-marketplace-title">
              <span className="ub-title-accent">//</span>
              {search ? `Results for "${search}"` : 'ALL SKILLS'}
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
              <button onClick={clearSearch} className="ub-clear-search">
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
              <button onClick={clearSearch} className="ub-btn ub-btn-ghost">
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
            <span className="ub-footer-tagline">Google for OpenClaw</span>
          </div>
          <nav className="ub-footer-nav">
            <Link to="/">Home</Link>
            <a href="https://www.npmjs.com/package/@getfoundry/unbrowse-openclaw" target="_blank" rel="noopener">npm</a>
            <Link to="/docs">Docs</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
