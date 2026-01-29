import { Link } from 'react-router-dom';
import type { Skill } from '../lib/api';

interface SkillCardProps {
  skill: Skill;
}

export function SkillCard({ skill }: SkillCardProps) {
  const getIcon = (name: string) => {
    const icons: Record<string, string> = {
      twitter: '🐦',
      booking: '🏨',
      agoda: '🏨',
      amazon: '📦',
      linkedin: '💼',
      github: '🐙',
      youtube: '📺',
      spotify: '🎵',
      stripe: '💳',
      shopify: '🛒',
      default: '🤖',
    };
    const key = Object.keys(icons).find((k) =>
      name.toLowerCase().includes(k)
    );
    return icons[key || 'default'];
  };

  const formatNumber = (num: number | undefined) => {
    if (!num) return '0';
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return String(num);
  };

  return (
    <Link to={`/skill/${encodeURIComponent(skill.id)}`} className="skill-card">
      <div className="skill-card-icon">{skill.icon || getIcon(skill.name)}</div>
      <h3 className="skill-card-title">{skill.name}</h3>
      <p className="skill-card-description">
        {skill.description || `API integration for ${skill.baseUrl}`}
      </p>
      <div className="skill-card-meta">
        <span className="skill-card-stat">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {formatNumber(skill.downloads)}
        </span>
        <span className="skill-card-stat">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
          {skill.endpoints?.length || 0} endpoints
        </span>
        {skill.authType && (
          <span className="skill-card-auth">
            <span className="tag tag-teal">{skill.authType}</span>
          </span>
        )}
      </div>
    </Link>
  );
}

export function SkillCardSkeleton() {
  return (
    <div className="skill-card" style={{ cursor: 'default' }}>
      <div className="skeleton" style={{ width: 48, height: 48, borderRadius: 12, marginBottom: 16 }} />
      <div className="skeleton skeleton-text" style={{ marginBottom: 8 }} />
      <div className="skeleton skeleton-text-sm" style={{ marginBottom: 16 }} />
      <div className="skeleton skeleton-text-sm" style={{ width: '40%' }} />
    </div>
  );
}
