import { Routes, Route, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Home from './Home';
import Abilities from './Abilities';
import Credentials from './Credentials';
import ApiKeys from './ApiKeys';
import Ingestion from './Ingestion';
import Analytics from './Analytics';

export default function Dashboard() {
  const { user, logout } = useAuth();
  const location = useLocation();

  const navigation = [
    { path: '/', label: 'Home', icon: '🏠' },
    { path: '/abilities', label: 'Abilities', icon: '🎯' },
    { path: '/ingestion', label: 'Ingestion', icon: '📥' },
    { path: '/credentials', label: 'Credentials', icon: '🔐' },
    { path: '/api-keys', label: 'API Keys', icon: '🔑' },
    { path: '/analytics', label: 'Analytics', icon: '📊' },
  ];

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="logo-small">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="url(#grad)" />
              <defs>
                <linearGradient id="grad">
                  <stop stopColor="#667eea" />
                  <stop offset="1" stopColor="#764ba2" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <h2>Reverse Engineer</h2>
        </div>

        <nav className="sidebar-nav">
          {navigation.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={`nav-link ${location.pathname === item.path ? 'active' : ''}`}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            {user?.image ? (
              <img src={user.image} alt={user.name} className="user-avatar" style={{ width: '40px', height: '40px', borderRadius: '50%' }} />
            ) : (
              <div className="user-avatar">
                {user?.name?.charAt(0)?.toUpperCase() || 'U'}
              </div>
            )}
            <div className="user-details">
              <h4>{user?.name || 'User'}</h4>
              <p>{user?.email || ''}</p>
            </div>
          </div>
          <button onClick={logout} className="btn btn-secondary" style={{ width: '100%' }}>
            Logout
          </button>
        </div>
      </aside>

      <main className="content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/abilities" element={<Abilities />} />
          <Route path="/ingestion" element={<Ingestion />} />
          <Route path="/credentials" element={<Credentials />} />
          <Route path="/api-keys" element={<ApiKeys />} />
          <Route path="/analytics" element={<Analytics />} />
        </Routes>
      </main>
    </div>
  );
}
