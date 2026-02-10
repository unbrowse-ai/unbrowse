import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Home() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      const response = await fetch('/analytics/my/stats', {
        credentials: 'include'
      });
      if (response.ok) {
        const data = await response.json();
        setStats(data.stats);
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Welcome back, {user?.name?.split(' ')[0]}!</h1>
        <p>Manage your API abilities and credentials</p>
      </header>

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon">🎯</div>
          <div className="stat-info">
            <div className="stat-value">{stats?.totalAbilities || 0}</div>
            <div className="stat-label">Total Abilities</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">⚡</div>
          <div className="stat-info">
            <div className="stat-value">{stats?.totalExecutions || 0}</div>
            <div className="stat-label">Executions</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">✅</div>
          <div className="stat-info">
            <div className="stat-value">
              {stats ? Math.round(stats.successRate * 100) : 0}%
            </div>
            <div className="stat-label">Success Rate</div>
          </div>
        </div>
      </div>

      <div className="quick-actions">
        <h2>Quick Actions</h2>
        <div className="actions-grid">
          <Link to="/ingestion" className="action-card">
            <div className="action-icon">📥</div>
            <h3>Ingest API</h3>
            <p>Upload HAR file or add API endpoint</p>
          </Link>

          <Link to="/abilities" className="action-card">
            <div className="action-icon">🎯</div>
            <h3>View Abilities</h3>
            <p>Browse and manage your API abilities</p>
          </Link>

          <Link to="/credentials" className="action-card">
            <div className="action-icon">🔐</div>
            <h3>Add Credentials</h3>
            <p>Store encrypted API credentials</p>
          </Link>

          <Link to="/api-keys" className="action-card">
            <div className="action-icon">🔑</div>
            <h3>API Keys</h3>
            <p>Manage programmatic access keys</p>
          </Link>
        </div>
      </div>

      {stats?.topAbilities && stats.topAbilities.length > 0 && (
        <div className="top-abilities">
          <h2>Top Abilities</h2>
          <div className="ability-list">
            {stats.topAbilities.map((ability, index) => (
              <div key={index} className="ability-item">
                <div className="ability-rank">#{index + 1}</div>
                <div className="ability-info">
                  <div className="ability-name">{ability.abilityName}</div>
                  <div className="ability-count">{ability.executionCount} executions</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
