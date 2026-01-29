import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import {
  getSkill,
  downloadSkill,
  PaymentRequiredError,
  type Skill,
} from '../lib/api';

export function SkillDetail() {
  const { id } = useParams<{ id: string }>();
  const { publicKey, signTransaction } = useWallet();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!id) return;

    setLoading(true);
    setError(null);

    getSkill(id)
      .then(setSkill)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

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

  const getMethodClass = (method: string) => {
    const classes: Record<string, string> = {
      GET: 'endpoint-method-get',
      POST: 'endpoint-method-post',
      PUT: 'endpoint-method-put',
      DELETE: 'endpoint-method-delete',
      PATCH: 'endpoint-method-post',
    };
    return classes[method.toUpperCase()] || 'endpoint-method-get';
  };

  const handleDownload = async () => {
    if (!skill) return;

    setDownloading(true);
    try {
      const blob = await downloadSkill(skill.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${skill.name}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      if (err instanceof PaymentRequiredError) {
        // Handle x402 payment
        if (!publicKey || !signTransaction) {
          alert('Please connect your wallet to purchase this skill.');
          return;
        }
        // TODO: Implement Solana payment flow
        alert(
          `Payment required: ${err.paymentInfo.amount} ${err.paymentInfo.currency}\nRecipient: ${err.paymentInfo.recipient}`
        );
      } else {
        alert(err instanceof Error ? err.message : 'Download failed');
      }
    } finally {
      setDownloading(false);
    }
  };

  if (loading) {
    return (
      <main className="main-content">
        <div className="container skill-detail">
          <div className="skeleton" style={{ width: 100, height: 20, marginBottom: 24 }} />
          <div className="skill-detail-header">
            <div className="skeleton" style={{ width: 80, height: 80, borderRadius: 16 }} />
            <div style={{ flex: 1 }}>
              <div className="skeleton skeleton-text" style={{ width: '40%', marginBottom: 12 }} />
              <div className="skeleton skeleton-text-sm" style={{ width: '60%' }} />
            </div>
          </div>
        </div>
      </main>
    );
  }

  if (error || !skill) {
    return (
      <main className="main-content">
        <div className="container skill-detail">
          <Link to="/" className="back-link">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Back to marketplace
          </Link>
          <div className="empty-state">
            <div className="empty-state-icon">😕</div>
            <h3 className="empty-state-title">Skill not found</h3>
            <p className="empty-state-description">
              {error || "The skill you're looking for doesn't exist."}
            </p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="main-content">
      <div className="container skill-detail">
        <Link to="/" className="back-link">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back to marketplace
        </Link>

        <div className="skill-detail-header glass-card" style={{ padding: 'var(--space-8)' }}>
          <div className="skill-detail-icon">
            {skill.icon || getIcon(skill.name)}
          </div>
          <div className="skill-detail-info">
            <h1 className="skill-detail-title">{skill.name}</h1>
            <div className="skill-detail-meta">
              <span>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  style={{ verticalAlign: 'middle', marginRight: 4 }}
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M2 12h20" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
                {skill.baseUrl}
              </span>
              <span>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  style={{ verticalAlign: 'middle', marginRight: 4 }}
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {skill.downloads || 0} downloads
              </span>
              {skill.authType && (
                <span className="skill-detail-auth">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  {skill.authType}
                </span>
              )}
            </div>
          </div>
        </div>

        {skill.tags && skill.tags.length > 0 && (
          <div className="skill-detail-tags">
            {skill.tags.map((tag) => (
              <span key={tag} className="tag tag-orange">
                {tag}
              </span>
            ))}
          </div>
        )}

        <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-8)' }}>
          {skill.description || `Browser automation skill for ${skill.baseUrl}`}
        </p>

        <section className="skill-detail-section">
          <h2 className="skill-detail-section-title">
            Endpoints ({skill.endpoints?.length || 0})
          </h2>
          <div className="endpoint-list">
            {skill.endpoints?.map((endpoint, index) => (
              <div key={index} className="endpoint-item">
                <span className={`endpoint-method ${getMethodClass(endpoint.method)}`}>
                  {endpoint.method}
                </span>
                <span className="endpoint-path">{endpoint.path}</span>
              </div>
            ))}
            {(!skill.endpoints || skill.endpoints.length === 0) && (
              <p style={{ color: 'var(--text-muted)' }}>No endpoints documented</p>
            )}
          </div>
        </section>

        <section className="skill-detail-section">
          <div className="skill-detail-actions">
            <button
              className="btn btn-primary btn-lg"
              onClick={handleDownload}
              disabled={downloading}
            >
              {downloading ? (
                <>
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    style={{ animation: 'spin 1s linear infinite' }}
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  Processing...
                </>
              ) : (
                <>
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Download Skill
                </>
              )}
            </button>

            {skill.price && skill.price > 0 && (
              <div className="price-badge">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M17.84 5.34a.63.63 0 0 1 .45.18l3.53 3.6a.63.63 0 0 1 0 .88l-3.53 3.6a.63.63 0 0 1-.45.19H4.32a.38.38 0 0 1-.27-.65l3.28-3.35a.63.63 0 0 1 .45-.18h10.06zm0 13.32a.63.63 0 0 0 .45-.18l3.53-3.6a.63.63 0 0 0 0-.88l-3.53-3.6a.63.63 0 0 0-.45-.18H4.32a.38.38 0 0 0-.27.65l3.28 3.34a.63.63 0 0 0 .45.19h10.06z" />
                </svg>
                {skill.price} SOL
              </div>
            )}

            {!publicKey && skill.price && skill.price > 0 && (
              <WalletMultiButton className="btn btn-secondary" />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
