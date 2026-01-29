import { useState, useEffect } from 'react';
import { getStats } from '../lib/api';

interface HeroProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export function Hero({ searchQuery, onSearchChange }: HeroProps) {
  const [stats, setStats] = useState({
    totalSkills: 0,
    totalDownloads: 0,
    totalAuthors: 0,
  });

  useEffect(() => {
    getStats().then(setStats).catch(console.error);
  }, []);

  return (
    <section className="hero">
      <div className="hero-background">
        <div className="hero-orb hero-orb-1" />
        <div className="hero-orb hero-orb-2" />
        <div className="hero-orb hero-orb-3" />
      </div>

      <div className="container">
        <h1 className="hero-title">
          <span className="text-gradient">Browser Automation</span>
          <br />
          Skills Marketplace
        </h1>
        <p className="hero-subtitle">
          Discover, purchase, and deploy AI-powered browser skills.
          Built by developers, powered by Solana micropayments.
        </p>

        <div className="hero-search">
          <input
            type="text"
            className="input search-input"
            placeholder="Search skills (e.g., 'booking', 'twitter', 'scraping')"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>

        <div className="hero-stats">
          <div className="hero-stat animate-fadeInUp">
            <div className="hero-stat-value">{stats.totalSkills || '50+'}</div>
            <div className="hero-stat-label">Skills</div>
          </div>
          <div className="hero-stat animate-fadeInUp animation-delay-100">
            <div className="hero-stat-value">{stats.totalDownloads || '1.2K'}</div>
            <div className="hero-stat-label">Downloads</div>
          </div>
          <div className="hero-stat animate-fadeInUp animation-delay-200">
            <div className="hero-stat-value">{stats.totalAuthors || '25+'}</div>
            <div className="hero-stat-label">Authors</div>
          </div>
        </div>
      </div>
    </section>
  );
}
