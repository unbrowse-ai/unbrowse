import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

export default function Abilities() {
  const { user } = useAuth();
  const [abilities, setAbilities] = useState([]);
  const [filteredAbilities, setFilteredAbilities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterFavorites, setFilterFavorites] = useState(false);
  const [filterPublished, setFilterPublished] = useState(false);
  const [selectedAbility, setSelectedAbility] = useState(null);

  useEffect(() => {
    fetchAbilities();
  }, []);

  useEffect(() => {
    filterAbilities();
  }, [abilities, searchQuery, filterFavorites, filterPublished]);

  const fetchAbilities = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/my/abilities', {
        credentials: 'include',
      });

      const data = await response.json();

      if (response.ok) {
        setAbilities(data.abilities || []);
      } else {
        setError(data.error || 'Failed to fetch abilities');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const filterAbilities = () => {
    let filtered = [...abilities];

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (ability) =>
          ability.name.toLowerCase().includes(query) ||
          ability.description?.toLowerCase().includes(query) ||
          ability.domain?.toLowerCase().includes(query)
      );
    }

    if (filterFavorites) {
      filtered = filtered.filter((ability) => ability.isFavorite);
    }

    if (filterPublished) {
      filtered = filtered.filter((ability) => ability.isPublished);
    }

    setFilteredAbilities(filtered);
  };

  const toggleFavorite = async (abilityId, currentStatus) => {
    try {
      const response = await fetch(`/my/abilities/${abilityId}/favorite`, {
        method: currentStatus ? 'DELETE' : 'POST',
        credentials: 'include',
      });

      if (response.ok) {
        setAbilities(
          abilities.map((ability) =>
            ability.abilityId === abilityId
              ? { ...ability, isFavorite: !currentStatus }
              : ability
          )
        );
      } else {
        const data = await response.json();
        setError(data.error || 'Failed to update favorite status');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const publishAbility = async (abilityId) => {
    try {
      const response = await fetch(`/my/abilities/${abilityId}/publish`, {
        method: 'POST',
        credentials: 'include',
      });

      if (response.ok) {
        setAbilities(
          abilities.map((ability) =>
            ability.abilityId === abilityId
              ? { ...ability, isPublished: true }
              : ability
          )
        );
      } else {
        const data = await response.json();
        setError(data.error || 'Failed to publish ability');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteAbility = async (abilityId) => {
    if (!confirm('Are you sure you want to delete this ability?')) {
      return;
    }

    try {
      const response = await fetch(`/my/abilities/${abilityId}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (response.ok) {
        setAbilities(abilities.filter((ability) => ability.abilityId !== abilityId));
        setSelectedAbility(null);
      } else {
        const data = await response.json();
        setError(data.error || 'Failed to delete ability');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <div className="page">
        <div className="loading">Loading abilities...</div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>My Abilities</h1>
        <p>Manage your discovered API abilities</p>
      </header>

      {error && (
        <div className="card error">
          <h3>✗ Error</h3>
          <p>{error}</p>
          <button onClick={() => setError(null)} className="btn btn-secondary">
            Dismiss
          </button>
        </div>
      )}

      <div className="card">
        <div className="abilities-controls">
          <div className="search-bar">
            <input
              type="text"
              placeholder="Search abilities by name, description, or domain..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
            />
          </div>

          <div className="filter-controls">
            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={filterFavorites}
                onChange={(e) => setFilterFavorites(e.target.checked)}
              />
              <span>⭐ Favorites Only</span>
            </label>

            <label className="filter-checkbox">
              <input
                type="checkbox"
                checked={filterPublished}
                onChange={(e) => setFilterPublished(e.target.checked)}
              />
              <span>🌐 Published Only</span>
            </label>
          </div>

          <div className="stats-bar">
            <span>
              Showing {filteredAbilities.length} of {abilities.length} abilities
            </span>
          </div>
        </div>
      </div>

      {filteredAbilities.length === 0 ? (
        <div className="card">
          <p className="no-results">
            {searchQuery || filterFavorites || filterPublished
              ? 'No abilities match your filters'
              : 'No abilities found. Start by ingesting HAR files or API endpoints.'}
          </p>
        </div>
      ) : (
        <div className="abilities-grid">
          {filteredAbilities.map((ability) => (
            <div
              key={ability.abilityId}
              className={`ability-card ${selectedAbility?.abilityId === ability.abilityId ? 'selected' : ''}`}
              onClick={() => setSelectedAbility(ability)}
            >
              <div className="ability-header">
                <h3>{ability.name}</h3>
                <div className="ability-badges">
                  {ability.isFavorite && <span className="badge favorite">⭐</span>}
                  {ability.isPublished && <span className="badge published">🌐</span>}
                  {ability.dynamicHeadersRequired && (
                    <span className="badge auth-required">🔒</span>
                  )}
                </div>
              </div>

              {ability.description && (
                <p className="ability-description">{ability.description}</p>
              )}

              <div className="ability-meta">
                <div className="meta-item">
                  <span className="meta-label">Domain:</span>
                  <span className="meta-value">{ability.domain || 'N/A'}</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Method:</span>
                  <span className="meta-value method-badge">{ability.method}</span>
                </div>
                {ability.endpoint && (
                  <div className="meta-item">
                    <span className="meta-label">Endpoint:</span>
                    <span className="meta-value endpoint">{ability.endpoint}</span>
                  </div>
                )}
              </div>

              <div className="ability-actions">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFavorite(ability.abilityId, ability.isFavorite);
                  }}
                  className="btn btn-icon"
                  title={ability.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                >
                  {ability.isFavorite ? '⭐' : '☆'}
                </button>

                {!ability.isPublished && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      publishAbility(ability.abilityId);
                    }}
                    className="btn btn-secondary btn-sm"
                  >
                    Publish
                  </button>
                )}

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteAbility(ability.abilityId);
                  }}
                  className="btn btn-danger btn-sm"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedAbility && (
        <div className="modal-overlay" onClick={() => setSelectedAbility(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{selectedAbility.name}</h2>
              <button onClick={() => setSelectedAbility(null)} className="btn-close">
                ✕
              </button>
            </div>

            <div className="modal-body">
              {selectedAbility.description && (
                <div className="detail-section">
                  <h3>Description</h3>
                  <p>{selectedAbility.description}</p>
                </div>
              )}

              <div className="detail-section">
                <h3>Request Details</h3>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">Domain:</span>
                    <span className="detail-value">{selectedAbility.domain || 'N/A'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Method:</span>
                    <span className="detail-value method-badge">{selectedAbility.method}</span>
                  </div>
                  {selectedAbility.endpoint && (
                    <div className="detail-item full-width">
                      <span className="detail-label">Endpoint:</span>
                      <code className="detail-value">{selectedAbility.endpoint}</code>
                    </div>
                  )}
                </div>
              </div>

              {selectedAbility.dynamicHeaders && selectedAbility.dynamicHeaders.length > 0 && (
                <div className="detail-section">
                  <h3>Dynamic Headers</h3>
                  <div className="code-block">
                    {selectedAbility.dynamicHeaders.map((header, idx) => (
                      <div key={idx} className="code-line">
                        <span className="key">{header.key}:</span>{' '}
                        <span className="value">{header.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selectedAbility.queryParams && Object.keys(selectedAbility.queryParams).length > 0 && (
                <div className="detail-section">
                  <h3>Query Parameters</h3>
                  <div className="code-block">
                    <pre>{JSON.stringify(selectedAbility.queryParams, null, 2)}</pre>
                  </div>
                </div>
              )}

              {selectedAbility.requestBody && (
                <div className="detail-section">
                  <h3>Request Body Schema</h3>
                  <div className="code-block">
                    <pre>{JSON.stringify(selectedAbility.requestBody, null, 2)}</pre>
                  </div>
                </div>
              )}

              {selectedAbility.responseSchema && (
                <div className="detail-section">
                  <h3>Response Schema</h3>
                  <div className="code-block">
                    <pre>{JSON.stringify(selectedAbility.responseSchema, null, 2)}</pre>
                  </div>
                </div>
              )}

              <div className="detail-section">
                <h3>Status</h3>
                <div className="status-badges">
                  {selectedAbility.isFavorite && (
                    <span className="status-badge favorite">⭐ Favorited</span>
                  )}
                  {selectedAbility.isPublished && (
                    <span className="status-badge published">🌐 Published</span>
                  )}
                  {selectedAbility.dynamicHeadersRequired && (
                    <span className="status-badge auth">🔒 Requires Credentials</span>
                  )}
                </div>
              </div>

              <div className="detail-section">
                <h3>Metadata</h3>
                <div className="detail-grid">
                  <div className="detail-item">
                    <span className="detail-label">Created:</span>
                    <span className="detail-value">
                      {new Date(selectedAbility.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Updated:</span>
                    <span className="detail-value">
                      {new Date(selectedAbility.updatedAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-label">Ability ID:</span>
                    <span className="detail-value code">{selectedAbility.abilityId}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button
                onClick={() => toggleFavorite(selectedAbility.abilityId, selectedAbility.isFavorite)}
                className="btn btn-secondary"
              >
                {selectedAbility.isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
              </button>
              {!selectedAbility.isPublished && (
                <button
                  onClick={() => publishAbility(selectedAbility.abilityId)}
                  className="btn btn-primary"
                >
                  Publish Ability
                </button>
              )}
              <button
                onClick={() => deleteAbility(selectedAbility.abilityId)}
                className="btn btn-danger"
              >
                Delete Ability
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
