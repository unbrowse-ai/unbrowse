import { Link, Outlet, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import FdryBalance from './FdryBalance';

const FDRY_ENABLED = import.meta.env.VITE_FDRY_ENABLED === 'true';

export default function Layout() {
  const location = useLocation();
  const [scrolled, setScrolled] = useState(false);
  const [wallet, setWallet] = useState(null);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Check for wallet in localStorage (set by Earnings page or extension)
  useEffect(() => {
    const stored = localStorage.getItem('unbrowse_wallet');
    if (stored) setWallet(stored);

    const handleStorage = (e) => {
      if (e.key === 'unbrowse_wallet') {
        setWallet(e.newValue);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  return (
    <div className="app">
      <nav className={`ub-nav ${scrolled ? 'scrolled' : ''}`}>
        <div className="ub-nav-inner">
          <Link to="/" className="ub-nav-brand">
            <div className="ub-nav-logo">
              <img src="/logo.png" alt="Unbrowse" />
            </div>
            <div className="ub-nav-wordmark">
              <span className="ub-nav-mark">//</span>
              <span className="ub-nav-name">UNBROWSE</span>
            </div>
          </Link>

          <div className="ub-nav-center">
            <Link
              to="/"
              className={`ub-nav-link ${location.pathname === '/' ? 'active' : ''}`}
            >
              <span className="ub-nav-link-text">Marketplace</span>
              <span className="ub-nav-link-indicator" />
            </Link>
            <Link
              to="/docs"
              className={`ub-nav-link ${location.pathname === '/docs' ? 'active' : ''}`}
            >
              <span className="ub-nav-link-text">Documentation</span>
              <span className="ub-nav-link-indicator" />
            </Link>
            {FDRY_ENABLED && (
              <Link
                to="/earnings"
                className={`ub-nav-link ${location.pathname === '/earnings' ? 'active' : ''}`}
              >
                <span className="ub-nav-link-text">Earnings</span>
                <span className="ub-nav-link-indicator" />
              </Link>
            )}
          </div>

          <div className="ub-nav-actions">
            {FDRY_ENABLED && <FdryBalance wallet={wallet} />}
            <a
              href="https://github.com/lekt9/unbrowse-openclaw"
              target="_blank"
              rel="noopener noreferrer"
              className="ub-nav-github"
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
              </svg>
              <span>Star on GitHub</span>
            </a>
          </div>
        </div>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
