import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiUrl } from '../lib/api-base';

function formatValidationStatus(status) {
  if (!status) return 'Unknown';
  return status
    .toString()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function normalizeMethod(method) {
  return String(method || 'GET').toUpperCase();
}

function methodClassName(method) {
  return `method-${normalizeMethod(method).toLowerCase()}`;
}

function isProxyPath(path) {
  if (typeof path !== 'string') return false;
  return path.startsWith('/marketplace/endpoints/') || path.startsWith('/__endpoint/');
}

function collectKeys(keys) {
  if (!Array.isArray(keys)) return [];
  return keys.map((k) => String(k || '').trim()).filter(Boolean);
}

function collectPathKeys(pathParams) {
  if (!Array.isArray(pathParams)) return [];
  return pathParams
    .map((p) => String(p?.name || '').trim())
    .filter(Boolean);
}

function collectBodyKeys(bodySchema) {
  if (!bodySchema) return [];
  if (Array.isArray(bodySchema)) return collectKeys(bodySchema);
  if (typeof bodySchema === 'string') {
    const raw = bodySchema.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return collectKeys(parsed);
      if (parsed && typeof parsed === 'object') {
        const props = parsed.properties && typeof parsed.properties === 'object'
          ? Object.keys(parsed.properties)
          : Object.keys(parsed);
        return collectKeys(props);
      }
    } catch {
      // ignore
    }
  }
  return [];
}

function isWorkingEndpoint(endpoint) {
  const status = String(endpoint?.validationStatus || '').toLowerCase();
  if (status) {
    return status === 'verified' || status === 'auth_required';
  }
  return Number(endpoint?.successfulExecutions || 0) > 0;
}

export default function SkillDetail() {
  const { id } = useParams();
  const [skill, setSkill] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copiedStep, setCopiedStep] = useState(null);
  const [skillContent, setSkillContent] = useState(null);
  const [loadingContent, setLoadingContent] = useState(false);

  const [endpoints, setEndpoints] = useState([]);
  const [loadingEndpoints, setLoadingEndpoints] = useState(false);
  const [endpointError, setEndpointError] = useState(null);
  const [endpointMethodFilter, setEndpointMethodFilter] = useState('all');
  const [endpointSearch, setEndpointSearch] = useState('');

  useEffect(() => {
    setLoading(true);
    setSkill(null);
    setSkillContent(null);
    setEndpoints([]);
    setEndpointMethodFilter('all');
    setEndpointSearch('');
    loadSkill();
    loadSkillEndpoints(id);
  }, [id]);

  const loadSkill = async () => {
    try {
      const res = await fetch(apiUrl(`/marketplace/skills/${id}`));
      if (res.ok) {
        const data = await res.json();
        setSkill(data.skill);

        const price = parseFloat(data.skill?.priceUsdc || '0');
        if (price === 0) {
          loadSkillContent(id);
        }
      }
    } catch (err) {
      console.error('Failed to load skill:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadSkillContent = async (skillId) => {
    setLoadingContent(true);
    try {
      const res = await fetch(apiUrl(`/marketplace/skill-downloads/${skillId}`));
      if (res.ok) {
        const data = await res.json();
        setSkillContent(data.skill || data);
      }
    } catch (err) {
      console.error('Failed to load skill content:', err);
    } finally {
      setLoadingContent(false);
    }
  };

  const loadSkillEndpoints = async (skillId) => {
    setLoadingEndpoints(true);
    setEndpointError(null);
    try {
      const res = await fetch(apiUrl(`/marketplace/skills/${skillId}/endpoints`));
      if (!res.ok) {
        throw new Error(`Failed to load endpoints (${res.status})`);
      }

      const data = await res.json();
      const normalized = (data.endpoints || [])
        .map((ep, index) => ({
          id: ep.endpointId || `${ep.method || 'GET'}-${ep.normalizedPath || ep.rawPath || index}`,
          endpointId: ep.endpointId || null,
          method: normalizeMethod(ep.method),
          path: ep.rawPath || ep.normalizedPath || '/',
          normalizedPath: ep.normalizedPath || ep.rawPath || '/',
          domain: ep.domain || '',
          operationName: ep.operationName || ep.methodName || null,
          category: ep.category || null,
          description: ep.description || null,
          pathKeys: collectKeys(ep.pathKeys).length > 0 ? collectKeys(ep.pathKeys) : collectPathKeys(ep.pathParams),
          queryKeys: collectKeys(ep.queryKeys),
          bodyKeys: collectKeys(ep.bodyKeys).length > 0 ? collectKeys(ep.bodyKeys) : collectBodyKeys(ep.bodySchema),
          validationStatus: ep.validationStatus || null,
          qualityScore: typeof ep.qualityScore === 'number' ? ep.qualityScore : null,
          healthScore: typeof ep.healthScore === 'number' ? ep.healthScore : null,
          totalExecutions: typeof ep.totalExecutions === 'number' ? ep.totalExecutions : 0,
          successfulExecutions: typeof ep.successfulExecutions === 'number' ? ep.successfulExecutions : 0,
        }))
        .sort((a, b) => {
          if (b.totalExecutions !== a.totalExecutions) {
            return b.totalExecutions - a.totalExecutions;
          }
          if (a.method !== b.method) {
            return a.method.localeCompare(b.method);
          }
          return a.path.localeCompare(b.path);
        });

      setEndpoints(normalized);
    } catch (err) {
      const message = err?.message || 'Failed to load endpoints';
      setEndpointError(message);
      console.error('Failed to load endpoint list:', err);
    } finally {
      setLoadingEndpoints(false);
    }
  };

  const copyToClipboard = async (text, stepId) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedStep(stepId);
      setTimeout(() => setCopiedStep(null), 2000);
    } catch (err) {
      alert(`Copy this command:\n\n${text}`);
    }
  };

  const handlePurchase = () => {
    alert('x402 execution flow is handled in agent runtime.\n\nUse unbrowse_search to install metadata and execute via proxy routes.');
  };

  if (loading) {
    return (
      <div className="loading">
        <div className="loading-spinner" />
        Loading skill...
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="skill-not-found">
        <h2>Skill not found</h2>
        <p>The skill you're looking for doesn't exist or has been removed.</p>
        <Link to="/" className="btn btn-primary">Back to Marketplace</Link>
      </div>
    );
  }

  const fallbackEndpointSource = Array.isArray(skillContent?.endpoints)
    ? skillContent.endpoints
    : (Array.isArray(skill.endpoints) ? skill.endpoints : []);

  const fallbackEndpoints = fallbackEndpointSource.map((ep, index) => ({
    id: `${ep.method || 'GET'}-${ep.path || ep.endpoint || ep.url || index}`,
    endpointId: ep.endpointId || null,
    method: normalizeMethod(ep.method),
    path: ep.path || ep.endpoint || ep.url || '/',
    normalizedPath: ep.path || ep.endpoint || ep.url || '/',
    domain: skill.domain || '',
    operationName: ep.operationName || null,
    category: ep.category || null,
    description: ep.description || null,
    pathKeys: collectKeys(ep.pathKeys),
    queryKeys: collectKeys(ep.queryKeys),
    bodyKeys: collectKeys(ep.bodyKeys),
    validationStatus: null,
    qualityScore: null,
    healthScore: null,
    totalExecutions: 0,
    successfulExecutions: 0,
  }));

  const endpointRecords = endpoints.length > 0 ? endpoints : fallbackEndpoints;
  const workingEndpointRecords = endpointRecords.filter(isWorkingEndpoint);

  const methodOptions = [
    'all',
    ...new Set(workingEndpointRecords.map((ep) => ep.method).filter(Boolean)),
  ];

	  const filteredEndpoints = workingEndpointRecords.filter((ep) => {
	    if (endpointMethodFilter !== 'all' && ep.method !== endpointMethodFilter) {
	      return false;
	    }

	    if (!endpointSearch.trim()) {
	      return true;
	    }

	    const q = endpointSearch.toLowerCase();
	    return (
	      ep.path.toLowerCase().includes(q)
	      || ep.normalizedPath.toLowerCase().includes(q)
	      || ep.domain.toLowerCase().includes(q)
	      || String(ep.operationName || '').toLowerCase().includes(q)
	      || String(ep.description || '').toLowerCase().includes(q)
	      || String(ep.category || '').toLowerCase().includes(q)
	    );
	  });

  const price = parseFloat(skill.priceUsdc || '0');
  const isFree = price === 0;

  const listedEndpointCount = workingEndpointRecords.length;
  const fallbackEndpointCount = Number(skill.verifiedEndpointCount || 0);
  const endpointCount = listedEndpointCount || fallbackEndpointCount;

  const verifiedEndpoints = endpointCount;
  const methodCount = new Set(workingEndpointRecords.map((ep) => ep.method).filter(Boolean)).size;
  const totalExecutions = workingEndpointRecords.reduce((sum, ep) => sum + (ep.totalExecutions || 0), 0);
  const executionCount = Number(skill.executionCount || totalExecutions || 0);

  const searchCommand = `unbrowse_search query="${skill.name}"`;
  const installCommand = `unbrowse_install id="${skill.skillId}"`;
  const replayCommand = `unbrowse_replay service="${skill.name}" endpoint="<endpoint-name>" params={...}`;

  return (
    <div className="skill-detail">
      <Link to="/" className="back-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Back to marketplace
      </Link>

      <div className="detail-hero">
        <div className="detail-header">
          <div className="detail-title-row">
            {skill.category && (
              <span className="detail-category">{skill.category}</span>
            )}
            <h1 className="detail-title">{skill.name}</h1>
            {isFree && <span className="detail-free-badge">FREE</span>}
          </div>
          <p className="detail-description">
            {skill.description || 'No description available'}
          </p>
        </div>
      </div>

      <div className="detail-meta-grid">
        {skill.serviceName && (
          <div className="meta-card">
            <div className="meta-label">Service</div>
            <div className="meta-value">{skill.serviceName}</div>
          </div>
        )}
        {skill.domain && (
          <div className="meta-card">
            <div className="meta-label">Domain</div>
            <div className="meta-value">{skill.domain}</div>
          </div>
        )}
        {skill.authType && (
          <div className="meta-card">
            <div className="meta-label">Auth Type</div>
            <div className="meta-value">{skill.authType}</div>
          </div>
        )}
        <div className="meta-card">
          <div className="meta-label">Endpoints</div>
          <div className="meta-value">{endpointCount.toLocaleString()}</div>
        </div>
        <div className="meta-card">
          <div className="meta-label">Executions</div>
          <div className="meta-value">{executionCount.toLocaleString()}</div>
        </div>
        <div className="meta-card">
          <div className="meta-label">Price</div>
          <div className="meta-value">{isFree ? 'Free' : `$${price.toFixed(2)} USDC`}</div>
        </div>
      </div>

      <section className="detail-section endpoint-radar-section">
        <div className="endpoint-radar-head">
          <div>
            <h2>Endpoint Radar</h2>
            <p className="endpoint-radar-subtitle">Paths + methods this skill can replay.</p>
          </div>
          <span className="endpoint-total-pill">{endpointCount.toLocaleString()} total</span>
        </div>

        {loadingEndpoints ? (
          <div className="content-loading">
            <div className="loading-spinner small" />
            Loading endpoint map...
          </div>
        ) : (
          <>
            <div className="endpoint-insights-grid">
              <div className="endpoint-insight-card">
                <span className="endpoint-insight-label">Verified</span>
                <strong>{verifiedEndpoints.toLocaleString()}</strong>
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

            {endpointError && (
              <p className="endpoint-inline-error">
                {endpointError}
              </p>
            )}

            {workingEndpointRecords.length > 0 ? (
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
                      onChange={(event) => setEndpointSearch(event.target.value)}
                      placeholder="Filter paths or domains"
                    />
                  </label>
                </div>

                <div className="endpoint-list-head">
                  Showing {filteredEndpoints.length.toLocaleString()} of {workingEndpointRecords.length.toLocaleString()} verified endpoints
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
	                    const showOperation = hasOperation;
	                    const title = hasOperation ? `${ep.operationName}()` : ep.path;
	
	                    return (
	                      <article key={ep.id} className="endpoint-radar-item">
	                        <div className="endpoint-radar-main">
	                          <span className={`endpoint-method ${methodClassName(ep.method)}`}>
	                            {ep.method}
	                          </span>
	                          <code className={`endpoint-path ${showOperation ? 'endpoint-operation' : ''}`}>{title}</code>
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
	                          {Array.isArray(ep.pathKeys) && ep.pathKeys.length > 0 && (
	                            <span className="endpoint-chip muted">path: {ep.pathKeys.slice(0, 6).join(', ')}</span>
	                          )}
	                          {Array.isArray(ep.queryKeys) && ep.queryKeys.length > 0 && (
	                            <span className="endpoint-chip muted">query: {ep.queryKeys.slice(0, 6).join(', ')}</span>
	                          )}
	                          {Array.isArray(ep.bodyKeys) && ep.bodyKeys.length > 0 && (
	                            <span className="endpoint-chip muted">body: {ep.bodyKeys.slice(0, 6).join(', ')}</span>
	                          )}
	                          {ep.endpointId && (
	                            <span className="endpoint-chip muted">id: {String(ep.endpointId).slice(0, 8)}…</span>
	                          )}
	                          {(ep.domain || skill.domain) && (
	                            <span className="endpoint-chip muted">{ep.domain || skill.domain}</span>
	                          )}
	                        </div>
	                      </article>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="endpoint-empty-state">
                No verified endpoints available yet for this skill.
              </p>
            )}
          </>
        )}
      </section>

      {isFree ? (
        <>
          <section className="detail-section skill-content-section">
            <h2>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
              </svg>
              SKILL.md
            </h2>
            {loadingContent ? (
              <div className="content-loading">
                <div className="loading-spinner small" />
                Loading skill documentation...
              </div>
            ) : skillContent?.skillMd ? (
              <div className="skill-md-content">
                <pre>{skillContent.skillMd}</pre>
              </div>
            ) : skill.skillMd ? (
              <div className="skill-md-content">
                <pre>{skill.skillMd}</pre>
              </div>
            ) : (
              <div className="skill-md-content">
                <p className="no-content">SKILL.md content not available. Install the skill to view full documentation.</p>
              </div>
            )}
          </section>

          <section className="detail-section free-download-section">
            <div className="free-download-content">
              <div className="free-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                </svg>
              </div>
              <div className="free-text">
                <h3>Free to Install</h3>
                <p>This skill is free. Install it directly using your agent.</p>
              </div>
              <div className="free-command">
                <code>{installCommand}</code>
                <button
                  className={`copy-btn ${copiedStep === 'free-install' ? 'copied' : ''}`}
                  onClick={() => copyToClipboard(installCommand, 'free-install')}
                >
                  {copiedStep === 'free-install' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          </section>
        </>
      ) : (
        <section className="paywall-section">
          <div className="paywall-content">
            <div className="paywall-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
            </div>
            <div className="paywall-text">
              <h3>Full Skill Package</h3>
              <p>
                Get complete access to SKILL.md documentation, generated wrappers,
                and reference materials. Runtime execution is still routed through backend abstraction.
              </p>
            </div>
            <div className="paywall-price">
              <span className="price-amount">${price.toFixed(2)}</span>
              <span className="price-currency">USDC</span>
            </div>
            <button className="btn btn-purchase" onClick={handlePurchase}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v12M6 12h12" />
              </svg>
              Purchase Skill
            </button>
            <div className="paywall-split">
              33% Creator • 30% Website Owner • 20% Platform • 17% Network
            </div>
          </div>
        </section>
      )}

      <section className="detail-section">
        <h2>How to Use</h2>
        <p className="section-intro">
          Use these tools in <strong>Claude Code</strong>, <strong>OpenClaw</strong>, or any agent with the unbrowse extension installed.
        </p>

        <div className="quickstart-steps">
          <div className="quickstart-step">
            <span className="step-num">1</span>
            <div className="step-body">
              <h3>Search for this skill</h3>
              <p className="step-description">Find available skills in the marketplace</p>
              <div className="code-block">
                <code>{searchCommand}</code>
                <button
                  className={`copy-btn ${copiedStep === 'search' ? 'copied' : ''}`}
                  onClick={() => copyToClipboard(searchCommand, 'search')}
                >
                  {copiedStep === 'search' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>

          <div className="quickstart-step">
            <span className="step-num">2</span>
            <div className="step-body">
              <h3>Install the skill</h3>
              <p className="step-description">
                {isFree
                  ? 'Install metadata into your local skills directory (Free)'
                  : `Install metadata package ($${price.toFixed(2)} USDC policy)`
                }
              </p>
              <div className="code-block">
                <code>{installCommand}</code>
                <button
                  className={`copy-btn ${copiedStep === 'install' ? 'copied' : ''}`}
                  onClick={() => copyToClipboard(installCommand, 'install')}
                >
                  {copiedStep === 'install' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>

          {skill.authType && skill.authType !== 'none' && (
            <div className="quickstart-step">
              <span className="step-num">3</span>
              <div className="step-body">
                <h3>Add your credentials</h3>
                <p className="step-description">
                  After installing, add your auth credentials to <code className="inline-code">auth.json</code> or
                  use <code className="inline-code">unbrowse_capture</code> to extract from a live browser session
                </p>
              </div>
            </div>
          )}

          <div className="quickstart-step">
            <span className="step-num">{skill.authType && skill.authType !== 'none' ? '4' : '3'}</span>
            <div className="step-body">
              <h3>Execute API calls</h3>
              <p className="step-description">Replay captured endpoints with your credentials</p>
              <div className="code-block">
                <code>{replayCommand}</code>
                <button
                  className={`copy-btn ${copiedStep === 'replay' ? 'copied' : ''}`}
                  onClick={() => copyToClipboard(replayCommand, 'replay')}
                >
                  {copiedStep === 'replay' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="detail-section">
        <h2>Prerequisites</h2>
        <div className="prereq-grid">
          <div className="prereq-item">
            <div className="prereq-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
              </svg>
            </div>
            <div className="prereq-content">
              <strong>Unbrowse Extension</strong>
              <span>Install in Claude Code or OpenClaw</span>
            </div>
          </div>
          {!isFree && (
            <div className="prereq-item">
              <div className="prereq-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6l4 2" />
                </svg>
              </div>
              <div className="prereq-content">
                <strong>Solana Wallet</strong>
                <span>USDC/FDRY balance for paid execution flows</span>
              </div>
            </div>
          )}
          {skill.authType && skill.authType !== 'none' && (
            <div className="prereq-item">
              <div className="prereq-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M13.8 12H3" />
                </svg>
              </div>
              <div className="prereq-content">
                <strong>{skill.authType} Credentials</strong>
                <span>Account access for {skill.domain || skill.serviceName || 'this service'}</span>
              </div>
            </div>
          )}
        </div>
      </section>

      {skill.creatorWallet && (
        <section className="detail-section creator-section">
          <h2>Creator</h2>
          <div className="creator-info">
            <div className="creator-avatar">
              {skill.creatorWallet[0].toUpperCase()}
            </div>
            <div className="creator-details">
              <span className="creator-name">
                {`${skill.creatorWallet.slice(0, 6)}...${skill.creatorWallet.slice(-4)}`}
              </span>
              <span className="creator-note">Eligible for weighted creator share on paid usage events</span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
