import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { apiUrl } from '../lib/api-base';

export default function Search() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const query = searchParams.get('q') || '';

  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const [totalResults, setTotalResults] = useState(0);
  const [searchInput, setSearchInput] = useState(query);
  const loaderRef = useRef(null);
  const LIMIT = 30;

  useEffect(() => {
    if (query) {
      setSearchInput(query);
      searchSkills(query, true);
    } else {
      setLoading(false);
    }
  }, [query]);

  // Infinite scroll
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore && !loading && query) {
          loadMoreSkills();
        }
      },
      { threshold: 0.1, rootMargin: '100px' }
    );

    if (loaderRef.current) {
      observer.observe(loaderRef.current);
    }

    return () => observer.disconnect();
  }, [hasMore, loadingMore, loading, offset, query]);

  const searchSkills = async (q, reset = true) => {
    if (reset) {
      setLoading(true);
      setOffset(0);
      setHasMore(true);
    }

    try {
      const res = await fetch(
        apiUrl(`/marketplace/skills?q=${encodeURIComponent(q)}&limit=${LIMIT}&offset=0`)
      );
      if (res.ok) {
        const data = await res.json();
        setSkills(data.skills || []);
        setTotalResults(data.total || data.skills?.length || 0);
        setOffset(LIMIT);
        setHasMore((data.skills?.length || 0) === LIMIT);
      }
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadMoreSkills = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);

    try {
      const res = await fetch(
        apiUrl(`/marketplace/skills?q=${encodeURIComponent(query)}&limit=${LIMIT}&offset=${offset}`)
      );
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
      console.error('Load more failed:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    if (searchInput.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchInput.trim())}`);
    }
  };

  return (
    <div className="search-page">
      {/* Search Header */}
      <div className="search-header">
        <Link to="/" className="search-back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </Link>

        <form onSubmit={handleSearch} className="search-form-large">
          <svg className="search-icon-large" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search skills, APIs, services..."
            autoFocus
          />
          {searchInput && (
            <button
              type="button"
              className="search-clear"
              onClick={() => {
                setSearchInput('');
                navigate('/search');
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </form>
      </div>

      {/* Results */}
      <div className="search-results">
        {!query ? (
          <div className="search-empty-state">
            <div className="search-empty-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </div>
            <h2>Search the Agentic Web</h2>
            <p>Find skills for any API, service, or workflow</p>
            <div className="search-suggestions">
              <span className="suggestion-label">Try:</span>
              {['twitter', 'reddit', 'stripe', 'github'].map(term => (
                <button
                  key={term}
                  className="suggestion-chip"
                  onClick={() => navigate(`/search?q=${term}`)}
                >
                  {term}
                </button>
              ))}
            </div>
          </div>
        ) : loading ? (
          <div className="search-loading">
            <div className="search-loader" />
            <span>Searching {totalResults > 0 ? totalResults : ''} skills...</span>
          </div>
        ) : skills.length === 0 ? (
          <div className="search-no-results">
            <div className="no-results-icon">∅</div>
            <h2>No skills found for "{query}"</h2>
            <p>Try a different search term or browse all skills</p>
            <Link to="/" className="btn-browse-all">
              Browse All Skills
            </Link>
          </div>
        ) : (
          <>
            <div className="search-meta">
              <span className="results-count">
                {totalResults > 0 ? totalResults.toLocaleString() : skills.length} results for "<strong>{query}</strong>"
              </span>
            </div>

            <div className="search-grid">
              {skills.map((skill) => {
                const price = parseFloat(skill.priceUsdc || '0');
                const isFree = price === 0;
                const workingEndpointCount = Number(skill.verifiedEndpointCount || 0);
                const endpointCount = workingEndpointCount;

                return (
                  <Link
                    key={skill.skillId}
                    to={`/skill/${skill.skillId}`}
                    className="search-result-card"
                  >
                    <div className="result-header">
                      <h3 className="result-name">{skill.name}</h3>
                      <span className={`result-price ${isFree ? 'free' : ''}`}>
                        {isFree ? 'FREE' : `$${price.toFixed(2)}`}
                      </span>
                    </div>

                    <p className="result-description">
                      {skill.description || 'No description available'}
                    </p>

                    <div className="result-meta">
                      <span className="result-domain">
                        {skill.domain || skill.serviceName || 'API'}
                      </span>
                      {endpointCount > 0 && (
                        <span className="result-endpoints">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M9 3H5a2 2 0 0 0-2 2v4" />
                            <path d="M15 3h4a2 2 0 0 1 2 2v4" />
                            <path d="M21 15v4a2 2 0 0 1-2 2h-4" />
                            <path d="M3 15v4a2 2 0 0 0 2 2h4" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                          {endpointCount} verified endpoints
                        </span>
                      )}
                      {skill.authType && skill.authType !== 'none' && (
                        <span className="result-auth">{skill.authType}</span>
                      )}
                      {(skill.executionCount || skill.downloadCount) > 0 && (
                        <span className="result-downloads">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                          </svg>
                          {(skill.executionCount || skill.downloadCount || 0).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>

            {/* Infinite scroll loader */}
            <div ref={loaderRef} className="search-loader-more">
              {loadingMore && (
                <>
                  <div className="search-loader small" />
                  <span>Loading more...</span>
                </>
              )}
              {!hasMore && skills.length > 0 && (
                <span className="search-end">All results loaded</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
