import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Link } from 'react-router-dom';

export function Header() {
  const { publicKey } = useWallet();

  const formatAddress = (address: string) => {
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  };

  return (
    <header className="header">
      <Link to="/" className="header-logo">
        <svg className="header-logo-icon" viewBox="0 0 100 100" fill="none">
          <defs>
            <linearGradient id="logo-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#f59f4a" />
              <stop offset="100%" stopColor="#e28a3f" />
            </linearGradient>
          </defs>
          <path
            fill="url(#logo-grad)"
            d="M70 25c-8-12-22-15-35-10-15 6-25 22-22 40 3 16 18 30 38 28 12-1 22-8 28-18l-12-8c-4 6-10 10-18 10-14 0-22-12-20-26 2-12 12-20 24-18 6 1 11 4 14 9l14-7z"
          />
          <circle fill="#34c7b7" cx="75" cy="30" r="8" opacity="0.8" />
        </svg>
        <span className="header-logo-text">Clawd Skills</span>
      </Link>

      <nav className="header-nav">
        <Link to="/" className="header-nav-link">
          Marketplace
        </Link>
        <a
          href="https://github.com/clawdbot"
          target="_blank"
          rel="noopener noreferrer"
          className="header-nav-link"
        >
          Docs
        </a>
      </nav>

      <div className="header-actions">
        {publicKey ? (
          <div className="wallet-button">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
              <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
              <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
            </svg>
            <span className="wallet-address">
              {formatAddress(publicKey.toBase58())}
            </span>
          </div>
        ) : (
          <WalletMultiButton className="btn btn-primary btn-sm" />
        )}
      </div>
    </header>
  );
}
