import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiUrl } from '../lib/api-base';

function normalizeMethod(method) {
  return String(method || 'GET').toUpperCase();
}

function methodClassName(method) {
  return `method-${normalizeMethod(method).toLowerCase()}`;
}

function formatValidationStatus(status) {
  if (!status) return 'Unknown';
  return status
    .toString()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function isWorkingEndpoint(endpoint) {
  const status = String(endpoint?.validationStatus || '').toLowerCase();
  if (status) {
    return status === 'verified' || status === 'auth_required';
  }
  return Number(endpoint?.successfulExecutions || 0) > 0;
}

export default function DomainPage() {
  const { domain } = useParams();
  const [domainData, setDomainData] = useState(null);
  const [endpoints, setEndpoints] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingEndpoints, setLoadingEndpoints] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [endpointMethodFilter, setEndpointMethodFilter] = useState('all');
  const [endpointSearch, setEndpointSearch] = useState('');

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    setDomainData(null);
    setEndpoints([]);
    setEndpointMethodFilter('all');
    setEndpointSearch('');
    loadDomain();
    loadEndpoints();
  }, [domain]);

  const loadDomain = async () => {
    try {
      const res = await fetch(apiUrl(`/domains/${encodeURIComponent(domain)}`));
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (res.ok) {
        const data = await res.json();
        if (data.stats?.skillCount === 0) {
          setNotFound(true);
          return;
        }
        setDomainData(data);
      }
    } catch (err) {
      console.error('Failed to load domain:', err);
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  };

  const loadEndpoints = async () => {
    setLoadingEndpoints(true);
    try {
      const res = await fetch(apiUrl(`/domains/${encodeURIComponent(domain)}/endpoints`));
      if (res.ok) {
        const data = await res.json();
        const normalized = (data.endpoints || []).map((ep, index) => ({
          id: ep.endpointId || `${ep.method || 'GET'}-${ep.normalizedPath || index}`,
          endpointId: ep.endpointId || null,
          skillId: ep.skillId || null,
          method: normalizeMethod(ep.method),
          path: ep.rawPath || ep.normalizedPath || '/',
          normalizedPath: ep.normalizedPath || ep.rawPath || '/',
          domain: ep.domain || '',
          operationName: ep.methodName || null,
          category: ep.category || null,
          description: ep.description || null,
          validationStatus: ep.validationStatus || null,
          qualityScore: typeof ep.qualityScore === 'number' ? ep.qualityScore : null,
          healthScore: typeof ep.healthScore === 'number' ? ep.healthScore : null,
          totalExecutions: typeof ep.totalExecutions === 'number' ? ep.totalExecutions : 0,
          successfulExecutions: typeof ep.successfulExecutions === 'number' ? ep.successfulExecutions : 0,
          queryKeys: Array.isArray(ep.queryKeys) ? ep.queryKeys : [],
          bodyKeys: [],
          pathParams: Array.isArray(ep.pathParams) ? ep.pathParams : [],
        }));
        setEndpoints(normalized);
      }
    } catch (err) {
      console.error('Failed to load domain endpoints:', err);
    } finally {
      setLoadingEndpoints(false);
    }
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
        Loading domain...
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="domain-page">
        <Link to="/" className="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back to marketplace
        </Link>

        <div className="domain-empty">
          <div className="domain-empty-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          </div>
          <h2>Domain Not Indexed</h2>
          <p><strong>{domain}</strong> hasn't been mapped yet.</p>
          <p className="domain-empty-sub">
            Be the first to capture this domain's internal APIs and publish them to the marketplace.
          </p>
          <div className="domain-empty-actions">
            <Link to="/" className="ub-btn ub-btn-primary">
              Browse Indexed Domains
            </Link>
            <a
              href="https://github.com/lekt9/unbrowse-openclaw"
              target="_blank"
              rel="noopener"
              className="ub-btn ub-btn-ghost"
            >
              Start Mapping
            </a>
          </div>
        </div>
      </div>
    );
  }

  const { stats, skills: domainSkills } = domainData;

  const workingEndpoints = endpoints.filter(isWorkingEndpoint);

  const methodOptions = [
    'all',
    ...new Set(workingEndpoints.map((ep) => ep.method).filter(Boolean)),
  ];

  const filteredEndpoints = workingEndpoints.filter((ep) => {
    if (endpointMethodFilter !== 'all' && ep.method !== endpointMethodFilter) {
      return false;
    }
    if (!endpointSearch.trim()) return true;
    const q = endpointSearch.toLowerCase();
    return (
      ep.path.toLowerCase().includes(q)
      || ep.normalizedPath.toLowerCase().includes(q)
      || String(ep.operationName || '').toLowerCase().includes(q)
      || String(ep.description || '').toLowerCase().includes(q)
      || String(ep.category || '').toLowerCase().includes(q)
    );
  });

  const totalExecutions = workingEndpoints.reduce((sum, ep) => sum + (ep.totalExecutions || 0), 0);
  const methodCount = new Set(workingEndpoints.map((ep) => ep.method).filter(Boolean)).size;

  return (
    <div className="domain-page">
      <Link to="/" className="back-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Back to marketplace
      </Link>

      {/* Domain Hero */}
      <div className="domain-hero">
        <div className="domain-hero-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" />
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
        </div>
        <h1 className="domain-hero-title">{domain}</h1>
        <p className="domain-hero-subtitle">
          Internal API endpoints discovered across {stats.skillCount} skill{stats.skillCount !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Stats Grid */}
      <div className="detail-meta-grid">
        <div className="meta-card">
          <div className="meta-label">Skills</div>
          <div className="meta-value">{stats.skillCount}</div>
        </div>
        <div className="meta-card">
          <div className="meta-label">Endpoints</div>
          <div className="meta-value">{stats.endpointCount}</div>
        </div>
        <div className="meta-card">
          <div className="meta-label">Executions</div>
          <div className="meta-value">{stats.executionCount.toLocaleString()}</div>
        </div>
        {stats.authTypes.length > 0 && (
          <div className="meta-card">
            <div className="meta-label">Auth</div>
            <div className="meta-value">{stats.authTypes.join(', ')}</div>
          </div>
        )}
        {stats.categories.length > 0 && (
          <div className="meta-card">
            <div className="meta-label">Categories</div>
            <div className="meta-value">{stats.categories.join(', ')}</div>
          </div>
        )}
      </div>

      {/* Skills for this domain */}
      <section className="detail-section">
        <h2>Skills</h2>
        <div className="domain-skills-grid">
          {domainSkills.map((skill) => {
            const price = parseFloat(skill.priceUsdc || '0');
            const isFree = price === 0;
            const endpointCount = Number(skill.verifiedEndpointCount || 0);

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
                  <span className="ub-card-domain">{skill.domain || skill.serviceName || 'API'}</span>
                  <div className="ub-card-stats">
                    {endpointCount > 0 && (
                      <span className="ub-card-endpoints">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M9 3H5a2 2 0 0 0-2 2v4" />
                          <path d="M15 3h4a2 2 0 0 1 2 2v4" />
                          <path d="M21 15v4a2 2 0 0 1-2 2h-4" />
                          <path d="M3 15v4a2 2 0 0 0 2 2h4" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                        {endpointCount} verified
                      </span>
                    )}
                    {Number(skill.executionCount || 0) > 0 && (
                      <span className="ub-card-downloads">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                        </svg>
                        {Number(skill.executionCount || 0).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Endpoint Radar */}
      <section className="detail-section endpoint-radar-section">
        <div className="endpoint-radar-head">
          <div>
            <h2>Endpoint Radar</h2>
            <p className="endpoint-radar-subtitle">All API paths discovered across skills for {domain}.</p>
          </div>
          <span className="endpoint-total-pill">{workingEndpoints.length.toLocaleString()} verified</span>
        </div>

        {loadingEndpoints ? (
          <div className="content-loading">
            <div className="loading-spinner small" />
            Loading endpoints...
          </div>
        ) : (
          <>
            <div className="endpoint-insights-grid">
              <div className="endpoint-insight-card">
                <span className="endpoint-insight-label">Verified</span>
                <strong>{workingEndpoints.length.toLocaleString()}</strong>
              </div>
              <div className="endpoint-insight-card">
                <span className="endpoint-insight-label">Methods</span>
                <strong>{methodCount.toLocaleString()}</strong>
              </div>
              <div className="endpoint-insight-card">
                <span className="endpoint-insight-label">Executions</span>
                <strong>{totalExecutions.toLocaleString()}</strong>
              </div>
            </div>

            {workingEndpoints.length > 0 ? (
              <>
                <div className="endpoint-toolbar">
                  <div className="endpoint-method-tabs">
                    {methodOptions.map((method) => (
                      <button
                        key={method}
                        className={`endpoint-method-tab ${endpointMethodFilter === method ? 'active' : ''}`}
                        onClick={() => setEndpointMethodFilter(method)}
                      >
                        {method === 'all' ? 'ALL' : method}
                      </button>
                    ))}
                  </div>

                  <label className="endpoint-search-input-wrap">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.3-4.3" />
                    </svg>
                    <input
                      type="text"
                      value={endpointSearch}
                      onChange={(e) => setEndpointSearch(e.target.value)}
                      placeholder="Filter paths..."
                    />
                  </label>
                </div>

                <div className="endpoint-list-head">
                  Showing {filteredEndpoints.length.toLocaleString()} of {workingEndpoints.length.toLocaleString()} verified endpoints
                </div>

                <div className="endpoint-radar-list">
                  {filteredEndpoints.map((ep) => {
                    const hasExecutions = ep.totalExecutions > 0;
                    const successRate = hasExecutions
                      ? Math.round((ep.successfulExecutions / ep.totalExecutions) * 100)
                      : null;
                    const statusClass = ep.validationStatus
                      ? `status-${String(ep.validationStatus).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`
                      : 'status-unknown';
                    const hasOperation = Boolean(ep.operationName);
                    const title = hasOperation ? `${ep.operationName}()` : ep.path;

                    return (
                      <article key={ep.id} className="endpoint-radar-item">
                        <div className="endpoint-radar-main">
                          <span className={`endpoint-method ${methodClassName(ep.method)}`}>
                            {ep.method}
                          </span>
                          <code className={`endpoint-path ${hasOperation ? 'endpoint-operation' : ''}`}>{title}</code>
                        </div>

                        {hasOperation && (
                          <code className="endpoint-path endpoint-subpath">{ep.path}</code>
                        )}

                        {ep.description && (
                          <p className="endpoint-radar-desc">{ep.description}</p>
                        )}

                        <div className="endpoint-radar-meta">
                          <span className={`endpoint-status ${statusClass}`}>
                            {formatValidationStatus(ep.validationStatus || 'unknown')}
                          </span>
                          {ep.category && (
                            <span className="endpoint-chip">{ep.category}</span>
                          )}
                          {hasExecutions && (
                            <span className="endpoint-chip">{ep.totalExecutions.toLocaleString()} runs</span>
                          )}
                          {successRate !== null && (
                            <span className="endpoint-chip">{successRate}% success</span>
                          )}
                          {typeof ep.qualityScore === 'number' && (
                            <span className="endpoint-chip">Q {ep.qualityScore}</span>
                          )}
                          {ep.skillId && (
                            <Link
                              to={`/skill/${ep.skillId}`}
                              className="endpoint-chip endpoint-chip-link"
                              onClick={(e) => e.stopPropagation()}
                            >
                              View Skill
                            </Link>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="endpoint-empty-state">
                No verified endpoints available yet for this domain.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
