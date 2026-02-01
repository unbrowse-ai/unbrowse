import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

const API_BASE = 'https://index.unbrowse.ai';

// Animated terminal typing effect
function TerminalDemo() {
  const [step, setStep] = useState(0);
  const lines = [
    { type: 'cmd', text: 'unbrowse_capture url="api.twitter.com"' },
    { type: 'out', text: '[OK] Intercepted 47 API endpoints' },
    { type: 'out', text: '[OK] Generated skill: twitter-timeline' },
    { type: 'out', text: '[OK] Generated skill: twitter-post-tweet' },
    { type: 'cmd', text: 'unbrowse_publish name="twitter-timeline" price="2.50"' },
    { type: 'final', text: '[$$] Published. Earning $0.83/download' },
  ];

  useEffect(() => {
    if (step < lines.length) {
      const timer = setTimeout(() => setStep(s => s + 1), 800);
      return () => clearTimeout(timer);
    }
    // Reset after showing all
    const resetTimer = setTimeout(() => setStep(0), 3000);
    return () => clearTimeout(resetTimer);
  }, [step]);

  return (
    <div className="ub-terminal">
      <div className="ub-terminal-header">
        <div className="ub-terminal-dots">
          <span></span><span></span><span></span>
        </div>
        <span className="ub-terminal-title">unbrowse — zsh</span>
      </div>
      <div className="ub-terminal-body">
        {lines.slice(0, step).map((line, i) => (
          <div key={i} className={`ub-term-line ${line.type === 'out' || line.type === 'final' ? 'ub-term-output' : ''} ${line.type === 'final' ? 'ub-term-final' : ''}`}>
            {line.type === 'cmd' && <span className="ub-term-prompt">~</span>}
            {line.type === 'cmd' ? (
              <span className="ub-term-cmd">{line.text}</span>
            ) : line.type === 'final' ? (
              <>
                <span className="ub-term-accent">[$$]</span>
                <span> Published. Earning </span>
                <span className="ub-term-money">$0.83</span>
                <span>/download</span>
              </>
            ) : (
              <>
                <span className="ub-term-success">[OK]</span>
                <span>{line.text.replace('[OK]', '')}</span>
              </>
            )}
          </div>
        ))}
        {step < lines.length && (
          <div className="ub-term-line">
            <span className="ub-term-cursor">▌</span>
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
        const freeCount = skillsList.filter(s => parseFloat(s.priceUsdc || '0') === 0).length;
        const totalDownloads = skillsList.reduce((sum, s) => sum + (s.downloadCount || 0), 0);
        setStats({ total: skillsList.length, free: freeCount, downloads: totalDownloads });

        // Get top 8 skills by downloads for popular section
        const popular = [...skillsList]
          .sort((a, b) => (b.downloadCount || 0) - (a.downloadCount || 0))
          .slice(0, 8);
        setPopularSkills(popular);
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

  const filteredSkills = skills.filter(skill => {
    if (activeFilter === 'free') return parseFloat(skill.priceUsdc || '0') === 0;
    if (activeFilter === 'paid') return parseFloat(skill.priceUsdc || '0') > 0;
    return true;
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
          <p className="ub-tagline">Search engine for AI agent skills</p>

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
            <button onClick={handleSearch} className="ub-home-btn">
              Search Skills
            </button>
            <button onClick={handleRandomSkill} className="ub-home-btn">
              I'm Feeling Lucky
            </button>
          </div>

          {/* Stats */}
          <p className="ub-home-stats">
            <strong>{stats.total}</strong> skills indexed
            {stats.free > 0 && <> · <strong>{stats.free}</strong> free</>}
          </p>

          {/* Terminal Demo */}
          <TerminalDemo />

          {/* How it works */}
          <div className="ub-value-grid">
            <div className="ub-value-card">
              <div className="ub-value-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/>
                  <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
                </svg>
              </div>
              <h3>Capture</h3>
              <p>Browse any website. Unbrowse intercepts all API traffic — endpoints, auth headers, payloads.</p>
            </div>

            <div className="ub-value-card">
              <div className="ub-value-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                </svg>
              </div>
              <h3>Generate</h3>
              <p>AI transforms raw traffic into production-ready skills with schemas, auth handling, and docs.</p>
            </div>

            <div className="ub-value-card">
              <div className="ub-value-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
                </svg>
              </div>
              <h3>Monetize</h3>
              <p>Publish to marketplace. Earn 33% of every download in USDC. Skills work while you sleep.</p>
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
            <span className="ub-footer-location">Skill Marketplace for AI Agents</span>
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
          {[
            { key: 'all', label: 'All' },
            { key: 'free', label: 'Free' },
            { key: 'paid', label: 'Paid' },
          ].map(tab => (
            <button
              key={tab.key}
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
