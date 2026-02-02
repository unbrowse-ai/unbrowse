import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

const API_BASE = 'https://index.unbrowse.ai';

// Chat-style demo showing the workflow
function ChatDemo() {
  const [step, setStep] = useState(0);
  const messages = [
    { type: 'user', text: 'can you learn meteora.ag?' },
    { type: 'assistant', text: 'I\'ll capture the Meteora API. Opening browser...' },
    { type: 'assistant', text: 'Intercepted 23 endpoints from app.meteora.ag' },
    { type: 'assistant', text: 'Generated skill: meteora-pools with getLbPairs, getPositions, swap' },
    { type: 'status', text: 'Skill learned: meteora-pools' },
    { type: 'user', text: 'publish it for 1 USDC' },
    { type: 'assistant', text: 'Published to marketplace. You\'ll earn $0.70 per download.' },
  ];

  useEffect(() => {
    if (step < messages.length) {
      const delay = messages[step]?.type === 'user' ? 1200 : 900;
      const timer = setTimeout(() => setStep(s => s + 1), delay);
      return () => clearTimeout(timer);
    }
    const resetTimer = setTimeout(() => setStep(0), 4000);
    return () => clearTimeout(resetTimer);
  }, [step]);

  return (
    <div className="ub-chat">
      <div className="ub-chat-header">
        <div className="ub-chat-avatar">🤖</div>
        <div className="ub-chat-info">
          <span className="ub-chat-name">OpenClaw</span>
          <span className="ub-chat-status">with unbrowse</span>
        </div>
      </div>
      <div className="ub-chat-body">
        {messages.slice(0, step).map((msg, i) => (
          <div key={i} className={`ub-chat-msg ub-chat-${msg.type}`}>
            {msg.type === 'status' ? (
              <div className="ub-chat-status-badge">{msg.text}</div>
            ) : (
              <div className="ub-chat-bubble">{msg.text}</div>
            )}
          </div>
        ))}
        {step < messages.length && step > 0 && (
          <div className="ub-chat-msg ub-chat-assistant">
            <div className="ub-chat-typing">
              <span></span><span></span><span></span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Skills() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState(searchParams.get('q') || '');
  const [hasSearched, setHasSearched] = useState(!!searchParams.get('q'));
  const [activeFilter, setActiveFilter] = useState('all');
  const [stats, setStats] = useState({ total: 0, free: 0, downloads: 0 });
  const [popularSkills, setPopularSkills] = useState([]);
  const [allSkills, setAllSkills] = useState([]);
  const [services, setServices] = useState([]);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const searchInputRef = useRef(null);

  useEffect(() => {
    // Load initial stats and popular skills
    loadStats();
    // If there's a query param, search immediately
    if (searchParams.get('q')) {
      performSearch(searchParams.get('q'));
    }
  }, []);

  const loadStats = async () => {
    try {
      const res = await fetch(`${API_BASE}/marketplace/skills?limit=100`);
      if (res.ok) {
        const data = await res.json();
        const skillsList = data.skills || [];
        setAllSkills(skillsList);

        const freeCount = skillsList.filter(s => parseFloat(s.priceUsdc || '0') === 0).length;
        const totalDownloads = skillsList.reduce((sum, s) => sum + (s.downloadCount || 0), 0);
        setStats({ total: skillsList.length, free: freeCount, downloads: totalDownloads });

        // Get top 8 skills by downloads for popular section
        const popular = [...skillsList]
          .sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0))
          .slice(0, 8);
        setPopularSkills(popular);

        // Extract unique services for browsing
        const serviceMap = new Map();
        skillsList.forEach(s => {
          const name = s.serviceName || s.domain;
          if (name && !serviceMap.has(name)) {
            serviceMap.set(name, { name, count: 1 });
          } else if (name) {
            serviceMap.get(name).count++;
          }
        });
        const topServices = [...serviceMap.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 8);
        setServices(topServices);
      }
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  };

  const performSearch = async (searchQuery) => {
    setLoading(true);
    setHasSearched(true);
    try {
      let url = `${API_BASE}/marketplace/skills?limit=100`;
      if (searchQuery.trim()) {
        url += `&q=${encodeURIComponent(searchQuery)}`;
      }
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills || []);
      }
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    if (query.trim()) {
      setSearchParams({ q: query });
      performSearch(query);
    }
  };

  const handleRandomSkill = async () => {
    // If we already have popular skills loaded, use those
    if (popularSkills.length > 0) {
      const randomSkill = popularSkills[Math.floor(Math.random() * popularSkills.length)];
      window.location.href = `/skill/${randomSkill.skillId}`;
      return;
    }

    // Otherwise fetch
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/marketplace/skills?limit=100`);
      if (res.ok) {
        const data = await res.json();
        const skillsList = data.skills || [];
        if (skillsList.length > 0) {
          const randomSkill = skillsList[Math.floor(Math.random() * skillsList.length)];
          window.location.href = `/skill/${randomSkill.skillId}`;
        }
      }
    } catch (err) {
      console.error('Random skill failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const clearSearch = () => {
    setQuery('');
    setHasSearched(false);
    setSkills([]);
    setSearchParams({});
    searchInputRef.current?.focus();
  };

  const browseAll = () => {
    setSkills(allSkills);
    setHasSearched(true);
    setQuery('');
    setSearchParams({});
  };

  const browseService = (serviceName) => {
    const filtered = allSkills.filter(s =>
      s.serviceName === serviceName || s.domain === serviceName
    );
    setSkills(filtered);
    setHasSearched(true);
    setQuery(serviceName);
    setSearchParams({ q: serviceName });
  };

  const filteredSkills = skills.filter(skill => {
    const priceOk = activeFilter === 'all' ? true :
      activeFilter === 'free' ? parseFloat(skill.priceUsdc || '0') === 0 :
      parseFloat(skill.priceUsdc || '0') > 0;

    const categoryOk = categoryFilter === 'all' ? true :
      categoryFilter === 'api' ? skill.category !== 'workflow' :
      skill.category === 'workflow';

    return priceOk && categoryOk;
  });

  // Homepage view (Google-style)
  if (!hasSearched) {
    return (
      <div className="ub-home">
        {/* Top bar */}
        <header className="ub-home-header">
          <nav className="ub-home-nav">
            <Link to="/docs" className="ub-home-link">Docs</Link>
            <a href="https://github.com/lekt9/unbrowse-openclaw" target="_blank" rel="noopener" className="ub-home-link">GitHub</a>
          </nav>
        </header>

        {/* Centered content */}
        <main className="ub-home-main">
          {/* Logo */}
          <h1 className="ub-logo">
            <span className="ub-logo-u">u</span>
            <span className="ub-logo-n">n</span>
            <span className="ub-logo-b">b</span>
            <span className="ub-logo-r">r</span>
            <span className="ub-logo-o">o</span>
            <span className="ub-logo-w">w</span>
            <span className="ub-logo-s">s</span>
            <span className="ub-logo-e">e</span>
          </h1>

          {/* Tagline */}
          <p className="ub-tagline">One agent learns. All agents know.</p>

          {/* Search bar */}
          <form onSubmit={handleSearch} className="ub-search-box">
            <div className="ub-search-wrapper">
              <svg className="ub-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills, APIs, services..."
                className="ub-search-input"
                autoFocus
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} className="ub-search-clear">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </form>

          {/* Action buttons */}
          <div className="ub-home-actions">
            <button onClick={browseAll} className="ub-home-btn ub-home-btn-primary">
              Explore Skills
            </button>
            <a href="https://github.com/lekt9/unbrowse-openclaw" target="_blank" rel="noopener" className="ub-home-btn">
              Start Learning
            </a>
          </div>

          {/* Service chips for quick browsing */}
          {services.length > 0 && (
            <div className="ub-service-chips">
              {services.map(svc => (
                <button
                  key={svc.name}
                  className="ub-service-chip"
                  onClick={() => browseService(svc.name)}
                >
                  {svc.name}
                </button>
              ))}
            </div>
          )}

          {/* Stats */}
          <p className="ub-home-stats">
            <strong>{stats.total}</strong> skills indexed
            {stats.free > 0 && <> · <strong>{stats.free}</strong> free</>}
          </p>

          {/* Chat Demo */}
          <ChatDemo />

          {/* Why Unbrowse */}
          <div className="ub-value-grid">
            <div className="ub-value-card">
              <div className="ub-value-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                  <path d="M2 12h20"/>
                </svg>
              </div>
              <h3>Collective Memory</h3>
              <p>What one agent learns, all agents know. Skills compound across the network.</p>
            </div>

            <div className="ub-value-card">
              <div className="ub-value-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                </svg>
              </div>
              <h3>200x Faster</h3>
              <p>API calls in 50ms vs 10+ seconds for GUI automation. No more waiting.</p>
            </div>

            <div className="ub-value-card">
              <div className="ub-value-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                </svg>
              </div>
              <h3>Earn USDC</h3>
              <p>Publish skills to marketplace. Earn 70% of every download. Skills work while you sleep.</p>
            </div>
          </div>

          {/* Install command */}
          <div className="ub-install-box">
            <span className="ub-install-label">Install for OpenClaw</span>
            <div className="ub-install-cmd">
              <code>openclaw plugins install @getfoundry/unbrowse-openclaw</code>
              <button
                className="ub-install-copy"
                onClick={() => {
                  navigator.clipboard.writeText('openclaw plugins install @getfoundry/unbrowse-openclaw');
                }}
                title="Copy to clipboard"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
            </div>
          </div>

          {/* Popular Skills */}
          {popularSkills.length > 0 && (
            <div className="ub-popular">
              <h3 className="ub-popular-title">Popular Skills</h3>
              <div className="ub-popular-grid">
                {popularSkills.map(skill => {
                  const isFree = parseFloat(skill.priceUsdc || '0') === 0;
                  return (
                    <Link
                      key={skill.skillId}
                      to={`/skill/${skill.skillId}`}
                      className="ub-popular-card"
                    >
                      <div className="ub-popular-name">
                        {skill.name}
                        {isFree && <span className="ub-popular-free">FREE</span>}
                      </div>
                      <div className="ub-popular-desc">
                        {skill.serviceName || skill.domain || 'API Skill'}
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}
        </main>

        {/* Footer */}
        <footer className="ub-home-footer">
          <div className="ub-footer-section">
            <span className="ub-footer-location">Google for OpenClaw — The Skill Layer for AI Agents</span>
          </div>
          <div className="ub-footer-divider" />
          <div className="ub-footer-links">
            <a href="https://agentskills.io" target="_blank" rel="noopener">Agent Skills Spec</a>
            <Link to="/docs">Documentation</Link>
            <a href="https://github.com/lekt9/unbrowse-openclaw" target="_blank" rel="noopener">Open Source</a>
          </div>
        </footer>
      </div>
    );
  }

  // Results view (Google results style)
  return (
    <div className="ub-results">
      {/* Header with search */}
      <header className="ub-results-header">
        <Link to="/" className="ub-results-logo" onClick={clearSearch}>
          <span className="ub-logo-u">u</span>
          <span className="ub-logo-n">n</span>
          <span className="ub-logo-b">b</span>
          <span className="ub-logo-r">r</span>
          <span className="ub-logo-o">o</span>
          <span className="ub-logo-w">w</span>
          <span className="ub-logo-s">s</span>
          <span className="ub-logo-e">e</span>
        </Link>

        <form onSubmit={handleSearch} className="ub-results-search">
          <div className="ub-search-wrapper">
            <svg className="ub-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="ub-search-input"
            />
            {query && (
              <button type="button" onClick={clearSearch} className="ub-search-clear">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
            <button type="submit" className="ub-search-submit">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </button>
          </div>
        </form>

        <nav className="ub-results-nav">
          <Link to="/docs" className="ub-results-link">Docs</Link>
        </nav>
      </header>

      {/* Filter tabs */}
      <div className="ub-results-tabs">
        <div className="ub-tabs-inner">
          {/* Category filters */}
          {[
            { key: 'all', label: 'All' },
            { key: 'api', label: 'APIs' },
            { key: 'workflow', label: 'Workflows' },
          ].map(tab => (
            <button
              key={tab.key}
              className={`ub-tab ${categoryFilter === tab.key ? 'active' : ''}`}
              onClick={() => setCategoryFilter(tab.key)}
            >
              {tab.label}
            </button>
          ))}
          <span className="ub-tab-divider">|</span>
          {/* Price filters */}
          {[
            { key: 'all', label: 'Any Price' },
            { key: 'free', label: 'Free' },
            { key: 'paid', label: 'Paid' },
          ].map(tab => (
            <button
              key={`price-${tab.key}`}
              className={`ub-tab ${activeFilter === tab.key ? 'active' : ''}`}
              onClick={() => setActiveFilter(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      <main className="ub-results-main">
        {loading ? (
          <div className="ub-results-loading">
            <div className="ub-spinner" />
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="ub-results-empty">
            <p>No skills found for "<strong>{query}</strong>"</p>
            <p className="ub-results-hint">Try different keywords or browse all skills</p>
          </div>
        ) : (
          <>
            <p className="ub-results-count">
              About {filteredSkills.length} results
            </p>
            <div className="ub-results-list">
              {filteredSkills.map(skill => {
                const price = parseFloat(skill.priceUsdc || '0');
                const isFree = price === 0;

                return (
                  <article key={skill.skillId} className="ub-result">
                    <div className="ub-result-url">
                      <span className="ub-result-domain">unbrowse.ai</span>
                      <span className="ub-result-path"> › skill › {skill.name}</span>
                    </div>
                    <Link to={`/skill/${skill.skillId}`} className="ub-result-title">
                      {skill.name}
                      {isFree && <span className="ub-result-free">FREE</span>}
                    </Link>
                    <p className="ub-result-desc">
                      {skill.description || `${skill.name} API skill for OpenClaw.`}
                      {skill.domain && <> Service: <strong>{skill.domain}</strong>.</>}
                      {skill.authType && skill.authType !== 'none' && <> Auth: {skill.authType}.</>}
                    </p>
                    <div className="ub-result-meta">
                      {skill.category && (
                        <span className="ub-result-tag">{skill.category === 'workflow' ? 'Workflow' : 'API'}</span>
                      )}
                      {skill.downloadCount > 0 && (
                        <span className="ub-result-downloads">{skill.downloadCount.toLocaleString()} downloads</span>
                      )}
                      {!isFree && (
                        <span className="ub-result-price">${price.toFixed(2)} USDC</span>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="ub-results-footer">
        <div className="ub-footer-links">
          <a href="https://github.com/lekt9/unbrowse-openclaw" target="_blank" rel="noopener">GitHub</a>
          <Link to="/docs">Docs</Link>
          <a href="https://agentskills.io" target="_blank" rel="noopener">Agent Skills Spec</a>
        </div>
      </footer>
    </div>
  );
}
