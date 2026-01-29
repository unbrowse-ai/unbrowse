import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getLeaderboard, type LeaderboardEntry } from '../lib/api';

export function Leaderboard() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getLeaderboard(10)
      .then((result) => setEntries(result.entries))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const formatNumber = (num: number) => {
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return String(num);
  };

  if (loading) {
    return (
      <aside className="leaderboard glass-card" style={{ padding: 'var(--space-6)' }}>
        <h3 className="leaderboard-title">
          <span>🏆</span> Top Skills
        </h3>
        <div className="leaderboard-list">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="leaderboard-item" style={{ cursor: 'default' }}>
              <div className="skeleton" style={{ width: 28, height: 24 }} />
              <div className="skeleton skeleton-text" style={{ flex: 1 }} />
              <div className="skeleton" style={{ width: 40, height: 16 }} />
            </div>
          ))}
        </div>
      </aside>
    );
  }

  if (entries.length === 0) {
    return null;
  }

  return (
    <aside className="leaderboard glass-card" style={{ padding: 'var(--space-6)' }}>
      <h3 className="leaderboard-title">
        <span>🏆</span> Top Skills
      </h3>
      <div className="leaderboard-list">
        {entries.map((entry, index) => (
          <Link
            key={entry.skill.id}
            to={`/skill/${encodeURIComponent(entry.skill.id)}`}
            className="leaderboard-item"
          >
            <span
              className={`leaderboard-rank ${
                index < 3 ? 'leaderboard-rank-top' : ''
              }`}
            >
              {index + 1}
            </span>
            <span className="leaderboard-skill-name">{entry.skill.name}</span>
            <span className="leaderboard-downloads">
              {formatNumber(entry.downloads)}
            </span>
          </Link>
        ))}
      </div>
    </aside>
  );
}
