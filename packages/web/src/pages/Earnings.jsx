import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { apiUrl } from '../lib/api-base';

export default function Earnings() {
  const [wallet, setWallet] = useState('');
  const [walletInput, setWalletInput] = useState('');
  const [balance, setBalance] = useState(null);
  const [distributions, setDistributions] = useState([]);
  const [distPage, setDistPage] = useState(1);
  const [distTotal, setDistTotal] = useState(0);
  const [leaderboard, setLeaderboard] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    loadStats();
    loadLeaderboard();
  }, []);

  useEffect(() => {
    if (wallet) {
      loadBalance();
      loadDistributions();
    }
  }, [wallet, distPage]);

  const loadBalance = async () => {
    try {
      const res = await fetch(apiUrl(`/fdry/balance/${wallet}`));
      if (res.ok) {
        const data = await res.json();
        setBalance(data);
      }
    } catch (err) {
      console.error('Failed to load balance:', err);
    }
  };

  const loadDistributions = async () => {
    try {
      const res = await fetch(apiUrl(`/fdry/distributions/${wallet}?page=${distPage}&limit=10`));
      if (res.ok) {
        const data = await res.json();
        setDistributions(data.distributions || data.items || []);
        setDistTotal(data.total || 0);
      }
    } catch (err) {
      console.error('Failed to load distributions:', err);
    }
  };

  const loadLeaderboard = async () => {
    try {
      const res = await fetch(apiUrl('/fdry/leaderboard'));
      if (res.ok) {
        const data = await res.json();
        setLeaderboard(data.leaderboard || data || []);
      }
    } catch (err) {
      console.error('Failed to load leaderboard:', err);
    }
  };

  const loadStats = async () => {
    try {
      const res = await fetch(apiUrl('/fdry/stats'));
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  };

  const handleWalletSubmit = (e) => {
    e.preventDefault();
    if (walletInput.trim()) {
      setWallet(walletInput.trim());
      setDistPage(1);
      setLoading(true);
      setTimeout(() => setLoading(false), 500);
    }
  };

  const formatNumber = (num) => {
    if (num == null) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return Math.floor(num).toLocaleString();
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '--';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const truncateWallet = (w) => {
    if (!w || w.length < 12) return w || '--';
    return w.slice(0, 6) + '...' + w.slice(-4);
  };

  const dailyEarned = balance?.dailyEarned ?? 0;
  const dailyCap = balance?.dailyCap ?? 100;
  const dailyProgress = dailyCap > 0 ? Math.min((dailyEarned / dailyCap) * 100, 100) : 0;

  return (
    <div className="earnings-page">
      <div className="earnings-header">
        <div className="earnings-header-left">
          <Link to="/" className="earnings-back">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </Link>
          <div>
            <h1>FDRY Earnings</h1>
            <p className="earnings-subtitle">Track your contributions and credits</p>
          </div>
        </div>
      </div>

      {/* Wallet Input */}
      {!wallet && (
        <div className="earnings-wallet-prompt">
          <div className="wallet-prompt-inner">
            <div className="wallet-prompt-icon">F</div>
            <h2>Enter Your Wallet</h2>
            <p>View your FDRY balance, earnings history, and leaderboard position.</p>
            <form onSubmit={handleWalletSubmit} className="wallet-form">
              <input
                type="text"
                value={walletInput}
                onChange={(e) => setWalletInput(e.target.value)}
                placeholder="Solana wallet address..."
                className="wallet-input"
              />
              <button type="submit" className="wallet-submit" disabled={!walletInput.trim()}>
                View Earnings
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Main Dashboard */}
      {wallet && (
        <>
          <div className="earnings-wallet-bar">
            <span className="wallet-bar-label">Wallet</span>
            <span className="wallet-bar-address">{truncateWallet(wallet)}</span>
            <button className="wallet-bar-change" onClick={() => { setWallet(''); setBalance(null); setDistributions([]); }}>
              Change
            </button>
          </div>

          <div className="earnings-tabs">
            {['overview', 'history', 'leaderboard'].map((tab) => (
              <button
                key={tab}
                className={'earnings-tab' + (activeTab === tab ? ' active' : '')}
                onClick={() => setActiveTab(tab)}
              >
                {tab === 'overview' ? 'Overview' : tab === 'history' ? 'History' : 'Leaderboard'}
              </button>
            ))}
          </div>

          {activeTab === 'overview' && (
            <div className="earnings-content">
              {/* Balance Card */}
              <div className="earnings-balance-card">
                <div className="balance-main">
                  <div className="balance-icon">F</div>
                  <div className="balance-info">
                    <span className="balance-label">FDRY Balance</span>
                    <span className="balance-value">
                      {formatNumber(balance?.balance ?? balance?.credits ?? 0)}
                    </span>
                    <span className="balance-sub">1 FDRY = 1 execution</span>
                  </div>
                </div>
              </div>

              {/* Daily Progress */}
              <div className="earnings-daily-card">
                <div className="daily-header">
                  <h3>Daily Earnings</h3>
                  <span className="daily-count">
                    {formatNumber(dailyEarned)} / {formatNumber(dailyCap)} FDRY
                  </span>
                </div>
                <div className="daily-bar-bg">
                  <div
                    className="daily-bar-fill"
                    style={{ width: `${dailyProgress}%` }}
                  />
                </div>
                <p className="daily-note">
                  {dailyProgress >= 100
                    ? 'Daily cap reached. Resets at midnight UTC.'
                    : `${formatNumber(dailyCap - dailyEarned)} FDRY remaining today`}
                </p>
              </div>

              {/* Quick Stats Grid */}
              <div className="earnings-stats-grid">
                <div className="metric-card">
                  <div className="metric-label">Total Earned</div>
                  <div className="metric-value">
                    {formatNumber(balance?.totalEarned ?? 0)}
                  </div>
                  <div className="metric-sub">All time</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">Contributions</div>
                  <div className="metric-value">
                    {formatNumber(balance?.contributions ?? 0)}
                  </div>
                  <div className="metric-sub">Novel endpoints</div>
                </div>
                <div className="metric-card">
                  <div className="metric-label">Executions Used</div>
                  <div className="metric-value">
                    {formatNumber(balance?.executionsUsed ?? 0)}
                  </div>
                  <div className="metric-sub">Skills called</div>
                </div>
                <div className="metric-card highlight">
                  <div className="metric-label">Net Balance</div>
                  <div className="metric-value">
                    {formatNumber(balance?.balance ?? balance?.credits ?? 0)}
                  </div>
                  <div className="metric-sub">Available now</div>
                </div>
              </div>

              {/* FDRY System Info */}
              {stats && (
                <div className="earnings-system-card">
                  <h3>FDRY System</h3>
                  <div className="system-stats">
                    <div className="system-stat">
                      <span className="system-stat-label">Treasury Balance</span>
                      <span className="system-stat-value">{formatNumber(stats.treasuryBalance)} FDRY</span>
                    </div>
                    <div className="system-stat">
                      <span className="system-stat-label">Total Distributed</span>
                      <span className="system-stat-value">{formatNumber(stats.totalDistributed)} FDRY</span>
                    </div>
                    <div className="system-stat">
                      <span className="system-stat-label">Starter Grant</span>
                      <span className="system-stat-value">{stats.starterGrant ?? 10} FDRY</span>
                    </div>
                    <div className="system-stat">
                      <span className="system-stat-label">Daily Cap</span>
                      <span className="system-stat-value">{stats.dailyCap ?? 100} FDRY/day</span>
                    </div>
                    <div className="system-stat">
                      <span className="system-stat-label">Active Earners</span>
                      <span className="system-stat-value">{formatNumber(stats.activeEarners)}</span>
                    </div>
                    <div className="system-stat">
                      <span className="system-stat-label">Total Contributors</span>
                      <span className="system-stat-value">{formatNumber(stats.totalContributors)}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'history' && (
            <div className="earnings-content">
              <div className="earnings-history-card">
                <h3>Distribution History</h3>
                {distributions.length > 0 ? (
                  <>
                    <div className="history-list">
                      {distributions.map((dist, i) => (
                        <div key={dist.id || i} className="history-item">
                          <div className="history-item-left">
                            <span className={'history-type ' + (dist.type === 'earn' || dist.type === 'grant' ? 'earn' : 'spend')}>
                              {dist.type === 'earn' ? '+' : dist.type === 'grant' ? '+' : '-'}
                            </span>
                            <div className="history-detail">
                              <span className="history-reason">{dist.reason || dist.type || 'Distribution'}</span>
                              <span className="history-date">{formatDate(dist.createdAt || dist.date)}</span>
                            </div>
                          </div>
                          <div className="history-item-right">
                            <span className={'history-amount ' + (dist.amount >= 0 ? 'positive' : 'negative')}>
                              {dist.amount >= 0 ? '+' : ''}{formatNumber(dist.amount)} FDRY
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                    {distTotal > 10 && (
                      <div className="history-pagination">
                        <button
                          className="history-page-btn"
                          onClick={() => setDistPage(Math.max(1, distPage - 1))}
                          disabled={distPage <= 1}
                        >
                          Previous
                        </button>
                        <span className="history-page-info">
                          Page {distPage} of {Math.ceil(distTotal / 10)}
                        </span>
                        <button
                          className="history-page-btn"
                          onClick={() => setDistPage(distPage + 1)}
                          disabled={distPage >= Math.ceil(distTotal / 10)}
                        >
                          Next
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="history-empty">
                    No distributions yet. Contribute novel endpoints to earn FDRY.
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'leaderboard' && (
            <div className="earnings-content">
              <div className="leaderboard-card">
                <h3>Top Earners</h3>
                <div className="leaderboard-list">
                  {leaderboard.length > 0 ? (
                    leaderboard.map((entry, i) => (
                      <div
                        key={entry.wallet || i}
                        className={'leaderboard-item' + (entry.wallet === wallet ? ' is-you' : '')}
                      >
                        <span className="leaderboard-rank">#{i + 1}</span>
                        <span className="leaderboard-name">
                          {truncateWallet(entry.wallet)}
                          {entry.wallet === wallet && <span className="leaderboard-you">you</span>}
                        </span>
                        <span className="leaderboard-value">
                          {formatNumber(entry.totalEarned || entry.balance)} FDRY
                        </span>
                        <span className="leaderboard-contributions">
                          {formatNumber(entry.contributions || 0)} endpoints
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="leaderboard-empty">No leaderboard data yet</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Stats-only view when no wallet */}
      {!wallet && (
        <div className="earnings-content">
          {stats && (
            <div className="earnings-system-card">
              <h3>FDRY System Stats</h3>
              <div className="system-stats">
                <div className="system-stat">
                  <span className="system-stat-label">Treasury Balance</span>
                  <span className="system-stat-value">{formatNumber(stats.treasuryBalance)} FDRY</span>
                </div>
                <div className="system-stat">
                  <span className="system-stat-label">Total Distributed</span>
                  <span className="system-stat-value">{formatNumber(stats.totalDistributed)} FDRY</span>
                </div>
                <div className="system-stat">
                  <span className="system-stat-label">Active Earners</span>
                  <span className="system-stat-value">{formatNumber(stats.activeEarners)}</span>
                </div>
                <div className="system-stat">
                  <span className="system-stat-label">Total Contributors</span>
                  <span className="system-stat-value">{formatNumber(stats.totalContributors)}</span>
                </div>
              </div>
            </div>
          )}

          <div className="leaderboard-card">
            <h3>Top Earners</h3>
            <div className="leaderboard-list">
              {leaderboard.length > 0 ? (
                leaderboard.map((entry, i) => (
                  <div key={entry.wallet || i} className="leaderboard-item">
                    <span className="leaderboard-rank">#{i + 1}</span>
                    <span className="leaderboard-name">{truncateWallet(entry.wallet)}</span>
                    <span className="leaderboard-value">
                      {formatNumber(entry.totalEarned || entry.balance)} FDRY
                    </span>
                    <span className="leaderboard-contributions">
                      {formatNumber(entry.contributions || 0)} endpoints
                    </span>
                  </div>
                ))
              ) : (
                <div className="leaderboard-empty">No leaderboard data yet</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
