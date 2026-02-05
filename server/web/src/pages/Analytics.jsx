import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

const API_BASE = 'https://index.unbrowse.ai';

export default function Analytics() {
  const [overview, setOverview] = useState(null);
  const [timeSeries, setTimeSeries] = useState(null);
  const [topSkills, setTopSkills] = useState([]);
  const [skillBreakdown, setSkillBreakdown] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [timeRange, setTimeRange] = useState(30);

  useEffect(() => {
    loadAnalytics();
  }, [timeRange]);

  const loadAnalytics = async () => {
    setLoading(true);
    try {
      const [overviewRes, timeSeriesRes, topRes, breakdownRes] = await Promise.all([
        fetch(API_BASE + '/admin/analytics/overview'),
        fetch(API_BASE + '/admin/analytics/timeseries?days=' + timeRange),
        fetch(API_BASE + '/admin/analytics/top-skills?limit=10&metric=installations'),
        fetch(API_BASE + '/admin/analytics/skills?limit=50'),
      ]);

      if (overviewRes.ok) setOverview(await overviewRes.json());
      if (timeSeriesRes.ok) setTimeSeries(await timeSeriesRes.json());
      if (topRes.ok) {
        const data = await topRes.json();
        setTopSkills(data.skills || []);
      }
      if (breakdownRes.ok) {
        const data = await breakdownRes.json();
        setSkillBreakdown(data.skills || []);
      }
    } catch (err) {
      console.error('Failed to load analytics:', err);
    } finally {
      setLoading(false);
    }
  };

  const formatNumber = (num) => {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num?.toLocaleString() || '0';
  };

  const formatUSDC = (num) => {
    const val = Number(num) || 0;
    if (val >= 1000) return '$' + (val / 1000).toFixed(1) + 'K';
    return '$' + val.toFixed(2);
  };

  const formatPercent = (num) => (num || 0).toFixed(1) + '%';

  const Sparkline = ({ data, color = 'var(--gold)', valueKey = 'count' }) => {
    if (!data || data.length === 0) return <div className="sparkline-empty">No data</div>;
    const max = Math.max(...data.map(d => d[valueKey] || 0), 1);
    const points = data.map((d, i) => {
      const x = (i / (data.length - 1 || 1)) * 200;
      const y = 40 - ((d[valueKey] || 0) / max) * 40;
      return x + ',' + y;
    }).join(' ');
    return (
      <svg width={200} height={40} className="sparkline">
        <polyline fill="none" stroke={color} strokeWidth="2" points={points} />
      </svg>
    );
  };

  if (loading && !overview) {
    return (
      <div className="analytics-page">
        <div className="analytics-loading">
          <div className="analytics-loader" />
          <span>Loading analytics...</span>
        </div>
      </div>
    );
  }

  const retention = overview?.retention || {};
  const totalRevenue = timeSeries?.installations?.reduce((a, b) => a + (b.revenue || 0), 0) || 0;

  return (
    <div className="analytics-page">
      <div className="analytics-header">
        <div className="analytics-header-left">
          <Link to="/" className="analytics-back">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </Link>
          <div>
            <h1>Analytics Dashboard</h1>
            <p className="analytics-subtitle">Marketplace metrics & revenue</p>
          </div>
        </div>
        <div className="analytics-header-right">
          <select value={timeRange} onChange={(e) => setTimeRange(Number(e.target.value))} className="analytics-select">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button onClick={loadAnalytics} className="analytics-refresh">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      <div className="analytics-tabs">
        {['overview', 'skills', 'retention'].map(tab => (
          <button
            key={tab}
            className={'analytics-tab' + (activeTab === tab ? ' active' : '')}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'overview' ? 'Overview' : tab === 'skills' ? 'Skills Breakdown' : 'Retention'}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="analytics-content">
          <div className="metrics-grid">
            <div className="metric-card">
              <div className="metric-label">Total Skills</div>
              <div className="metric-value">{formatNumber(overview?.totalSkills)}</div>
              <div className="metric-sub">{overview?.activeSkills || 0} with downloads</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Installations</div>
              <div className="metric-value">{formatNumber(overview?.totalInstallations)}</div>
              <div className="metric-sub">{formatNumber(overview?.uniqueUsers)} unique users</div>
            </div>
            <div className="metric-card highlight">
              <div className="metric-label">Revenue</div>
              <div className="metric-value">{formatUSDC(overview?.totalRevenue)}</div>
              <div className="metric-sub">{overview?.paidSkills || 0} paid skills</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Active This Week</div>
              <div className="metric-value">{formatNumber(retention.activeThisWeek)}</div>
              <div className="metric-sub">
                {retention.newThisWeek > 0 && (
                  <span className="positive">+{retention.newThisWeek} new</span>
                )}
              </div>
            </div>
          </div>

          <div className="charts-grid">
            <div className="chart-card">
              <div className="chart-header">
                <h3>Installations</h3>
                <span className="chart-period">Last {timeRange} days</span>
              </div>
              <Sparkline data={timeSeries?.installations} color="var(--emerald)" valueKey="count" />
              <div className="chart-stats">
                <span>Total: {timeSeries?.installations?.reduce((a, b) => a + b.count, 0) || 0}</span>
              </div>
            </div>
            <div className="chart-card">
              <div className="chart-header">
                <h3>Revenue</h3>
                <span className="chart-period">Last {timeRange} days</span>
              </div>
              <Sparkline data={timeSeries?.installations} color="var(--gold)" valueKey="revenue" />
              <div className="chart-stats">
                <span>Total: {formatUSDC(totalRevenue)}</span>
              </div>
            </div>
          </div>

          <div className="leaderboard-card">
            <h3>Top Skills by Installations</h3>
            <div className="leaderboard-list">
              {topSkills.map((skill, i) => (
                <div key={skill.skillId} className="leaderboard-item">
                  <span className="leaderboard-rank">#{i + 1}</span>
                  <span className="leaderboard-name">{skill.name}</span>
                  <span className="leaderboard-value">{formatNumber(skill.value)}</span>
                  {skill.revenue > 0 && (
                    <span className="leaderboard-revenue">{formatUSDC(skill.revenue)}</span>
                  )}
                </div>
              ))}
              {topSkills.length === 0 && <div className="leaderboard-empty">No installation data yet</div>}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'skills' && (
        <div className="analytics-content">
          <div className="table-card">
            <h3>All Skills Performance</h3>
            <div className="table-wrapper">
              <table className="analytics-table">
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th>Domain</th>
                    <th>Price</th>
                    <th>Downloads</th>
                    <th>Installs</th>
                    <th>Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {skillBreakdown.map((skill) => (
                    <tr key={skill.skillId}>
                      <td><Link to={'/skill/' + skill.skillId} className="skill-link">{skill.name}</Link></td>
                      <td className="domain-cell">{skill.domain || '-'}</td>
                      <td>{skill.priceUsdc > 0 ? formatUSDC(skill.priceUsdc) : 'Free'}</td>
                      <td>{formatNumber(skill.downloads)}</td>
                      <td>{formatNumber(skill.installations)}</td>
                      <td className={skill.revenue > 0 ? 'revenue-cell' : ''}>{skill.revenue > 0 ? formatUSDC(skill.revenue) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {skillBreakdown.length === 0 && <div className="table-empty">No skill data available</div>}
          </div>
        </div>
      )}

      {activeTab === 'retention' && (
        <div className="analytics-content">
          <div className="retention-grid">
            <div className="metric-card large">
              <div className="metric-label">Total Users</div>
              <div className="metric-value big">{formatNumber(retention.totalUsers)}</div>
              <div className="metric-sub">All time</div>
            </div>
            <div className="metric-card large">
              <div className="metric-label">New This Week</div>
              <div className="metric-value big">{formatNumber(retention.newThisWeek)}</div>
              <div className="metric-sub">First install</div>
            </div>
            <div className="metric-card large">
              <div className="metric-label">Active This Week</div>
              <div className="metric-value big">{formatNumber(retention.activeThisWeek)}</div>
              <div className="metric-sub">Installed a skill</div>
            </div>
            <div className="metric-card large negative-card">
              <div className="metric-label">Churned</div>
              <div className="metric-value big">{formatNumber(retention.churned)}</div>
              <div className="metric-sub">No activity 14+ days</div>
            </div>
          </div>

          <div className="retention-rate-card">
            <div className="rate-circle">
              <svg viewBox="0 0 100 100">
                <circle cx="50" cy="50" r="45" fill="none" stroke="var(--depth-surface)" strokeWidth="8" />
                <circle cx="50" cy="50" r="45" fill="none" stroke="var(--gold)" strokeWidth="8"
                  strokeDasharray={(retention.retentionRate || 0) * 2.83 + ' 283'}
                  strokeLinecap="round" transform="rotate(-90 50 50)" />
              </svg>
              <div className="rate-value">{formatPercent(retention.retentionRate)}</div>
            </div>
            <div className="rate-info">
              <h4>Week-over-Week Retention</h4>
              <p>Users who installed this week vs last week</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
