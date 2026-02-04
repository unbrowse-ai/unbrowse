import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

export default function Analytics() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [popularAbilities, setPopularAbilities] = useState([]);
  const [selectedAbility, setSelectedAbility] = useState(null);
  const [abilityDetails, setAbilityDetails] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState('overview'); // 'overview' or 'details'

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const fetchAnalytics = async () => {
    setLoading(true);
    setError(null);

    try {
      // Fetch user stats
      const statsResponse = await fetch('/analytics/my/stats', {
        credentials: 'include',
      });

      if (statsResponse.ok) {
        const statsData = await statsResponse.json();
        setStats(statsData.stats);
      } else {
        const data = await statsResponse.json();
        setError(data.error || 'Failed to fetch analytics');
      }

      // Fetch popular public abilities
      const popularResponse = await fetch('/analytics/public/popular', {
        credentials: 'include',
      });

      if (popularResponse.ok) {
        const popularData = await popularResponse.json();
        setPopularAbilities(popularData.abilities || []);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchAbilityDetails = async (abilityId) => {
    setError(null);

    try {
      const response = await fetch(`/analytics/my/abilities/${abilityId}`, {
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        setAbilityDetails(data);
        setView('details');
      } else {
        const data = await response.json();
        setError(data.error || 'Failed to fetch ability details');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const formatNumber = (num) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num?.toString() || '0';
  };

  const formatDuration = (ms) => {
    if (!ms) return 'N/A';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const getSuccessRate = (total, successful) => {
    if (!total || total === 0) return 0;
    return ((successful / total) * 100).toFixed(1);
  };

  if (loading) {
    return (
      <div className="page">
        <div className="loading">Loading analytics...</div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Analytics Dashboard</h1>
        <p>Track your API usage and performance metrics</p>
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

      {view === 'overview' ? (
        <>
          {/* Overview Stats */}
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-icon">📊</div>
              <div className="stat-content">
                <h3>{formatNumber(stats?.totalAbilities || 0)}</h3>
                <p>Total Abilities</p>
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon">🚀</div>
              <div className="stat-content">
                <h3>{formatNumber(stats?.totalExecutions || 0)}</h3>
                <p>Total Executions</p>
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon">✅</div>
              <div className="stat-content">
                <h3>{getSuccessRate(stats?.totalExecutions, stats?.successfulExecutions)}%</h3>
                <p>Success Rate</p>
              </div>
            </div>

            <div className="stat-card">
              <div className="stat-icon">⏱️</div>
              <div className="stat-content">
                <h3>{formatDuration(stats?.averageExecutionTime)}</h3>
                <p>Avg Execution Time</p>
              </div>
            </div>
          </div>

          {/* Top Abilities */}
          {stats?.topAbilities && stats.topAbilities.length > 0 && (
            <div className="card">
              <h2>🏆 Your Top Abilities</h2>
              <div className="top-abilities-list">
                {stats.topAbilities.map((ability, index) => (
                  <div
                    key={ability.abilityId}
                    className="top-ability-item"
                    onClick={() => fetchAbilityDetails(ability.abilityId)}
                  >
                    <div className="ability-rank">#{index + 1}</div>
                    <div className="ability-info">
                      <h4>{ability.name}</h4>
                      <p className="ability-domain">{ability.domain}</p>
                    </div>
                    <div className="ability-stats">
                      <span className="stat">
                        {formatNumber(ability.executionCount)} executions
                      </span>
                      <span className="stat">
                        {getSuccessRate(ability.executionCount, ability.successCount)}% success
                      </span>
                    </div>
                    <button className="btn btn-secondary btn-sm">View Details →</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Popular Public Abilities */}
          {popularAbilities.length > 0 && (
            <div className="card">
              <h2>🌐 Popular Public Abilities</h2>
              <p className="help-text">
                Discover what other users are using most frequently
              </p>
              <div className="popular-abilities-grid">
                {popularAbilities.map((ability, index) => (
                  <div key={ability.abilityId} className="popular-ability-card">
                    <div className="popular-badge">#{index + 1}</div>
                    <h4>{ability.name}</h4>
                    {ability.description && (
                      <p className="ability-description">{ability.description}</p>
                    )}
                    <div className="ability-meta">
                      <span className="meta-item">🌐 {ability.domain}</span>
                      <span className="meta-item">{ability.method}</span>
                    </div>
                    <div className="popularity-stats">
                      <div className="popularity-stat">
                        <span className="stat-label">Executions:</span>
                        <span className="stat-value">
                          {formatNumber(ability.executionCount)}
                        </span>
                      </div>
                      <div className="popularity-stat">
                        <span className="stat-label">Success Rate:</span>
                        <span className="stat-value">
                          {getSuccessRate(ability.executionCount, ability.successCount)}%
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent Activity */}
          {stats?.recentExecutions && stats.recentExecutions.length > 0 && (
            <div className="card">
              <h2>📅 Recent Activity</h2>
              <div className="activity-timeline">
                {stats.recentExecutions.map((execution, index) => (
                  <div key={index} className="activity-item">
                    <div className={`activity-status ${execution.success ? 'success' : 'failed'}`}>
                      {execution.success ? '✅' : '❌'}
                    </div>
                    <div className="activity-details">
                      <h4>{execution.abilityName}</h4>
                      <p className="activity-time">
                        {new Date(execution.executedAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="activity-metrics">
                      <span className="metric">
                        {formatDuration(execution.executionTime)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Empty State */}
          {(!stats || stats.totalAbilities === 0) && (
            <div className="card">
              <div className="empty-state">
                <h3>📊 No Analytics Yet</h3>
                <p>Start ingesting APIs and executing abilities to see your analytics here.</p>
                <a href="/ingestion" className="btn btn-primary">
                  Get Started with Ingestion →
                </a>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {/* Ability Details View */}
          <div className="card">
            <div className="detail-header">
              <button
                onClick={() => {
                  setView('overview');
                  setAbilityDetails(null);
                }}
                className="btn btn-secondary"
              >
                ← Back to Overview
              </button>
            </div>
          </div>

          {abilityDetails && (
            <>
              <div className="card">
                <h2>{abilityDetails.ability?.name}</h2>
                {abilityDetails.ability?.description && (
                  <p className="ability-description">{abilityDetails.ability.description}</p>
                )}
                <div className="ability-meta-grid">
                  <div className="meta-item">
                    <span className="meta-label">Domain:</span>
                    <span className="meta-value">{abilityDetails.ability?.domain}</span>
                  </div>
                  <div className="meta-item">
                    <span className="meta-label">Method:</span>
                    <span className="meta-value">{abilityDetails.ability?.method}</span>
                  </div>
                </div>
              </div>

              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-icon">🚀</div>
                  <div className="stat-content">
                    <h3>{formatNumber(abilityDetails.stats?.totalExecutions || 0)}</h3>
                    <p>Total Executions</p>
                  </div>
                </div>

                <div className="stat-card">
                  <div className="stat-icon">✅</div>
                  <div className="stat-content">
                    <h3>
                      {getSuccessRate(
                        abilityDetails.stats?.totalExecutions,
                        abilityDetails.stats?.successfulExecutions
                      )}
                      %
                    </h3>
                    <p>Success Rate</p>
                  </div>
                </div>

                <div className="stat-card">
                  <div className="stat-icon">⏱️</div>
                  <div className="stat-content">
                    <h3>{formatDuration(abilityDetails.stats?.averageExecutionTime)}</h3>
                    <p>Avg Execution Time</p>
                  </div>
                </div>

                <div className="stat-card">
                  <div className="stat-icon">⚡</div>
                  <div className="stat-content">
                    <h3>{formatDuration(abilityDetails.stats?.fastestExecution)}</h3>
                    <p>Fastest Execution</p>
                  </div>
                </div>
              </div>

              {abilityDetails.usage && abilityDetails.usage.length > 0 && (
                <div className="card">
                  <h3>📜 Execution History</h3>
                  <div className="usage-table-container">
                    <table className="usage-table">
                      <thead>
                        <tr>
                          <th>Status</th>
                          <th>Executed At</th>
                          <th>Duration</th>
                          <th>Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {abilityDetails.usage.map((record, index) => (
                          <tr key={index}>
                            <td>
                              <span className={`status-badge ${record.success ? 'success' : 'failed'}`}>
                                {record.success ? '✅ Success' : '❌ Failed'}
                              </span>
                            </td>
                            <td>{new Date(record.executedAt).toLocaleString()}</td>
                            <td>{formatDuration(record.executionTime)}</td>
                            <td>
                              {record.errorMessage && (
                                <span className="error-message">{record.errorMessage}</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
