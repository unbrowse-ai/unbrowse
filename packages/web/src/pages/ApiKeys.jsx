import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

export default function ApiKeys() {
  const { user } = useAuth();
  const [apiKeys, setApiKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyExpiration, setNewKeyExpiration] = useState('');
  const [newKeyRateLimit, setNewKeyRateLimit] = useState('');
  const [createdKey, setCreatedKey] = useState(null);

  useEffect(() => {
    fetchApiKeys();
  }, []);

  const fetchApiKeys = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/my/api-keys', {
        credentials: 'include',
      });

      const data = await response.json();

      if (response.ok) {
        setApiKeys(data.apiKeys || []);
      } else {
        setError(data.error || 'Failed to fetch API keys');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const createApiKey = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    try {
      const payload = {
        name: newKeyName,
      };

      if (newKeyExpiration) {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + parseInt(newKeyExpiration));
        payload.expiresAt = expiresAt.toISOString();
      }

      if (newKeyRateLimit) {
        payload.rateLimit = {
          limit: parseInt(newKeyRateLimit),
          duration: 60000, // 1 minute
        };
      }

      const response = await fetch('/my/api-keys', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (response.ok) {
        setCreatedKey(data.key);
        setSuccess('API key created successfully! Make sure to copy it now - you won\'t be able to see it again.');
        setNewKeyName('');
        setNewKeyExpiration('');
        setNewKeyRateLimit('');
        setShowCreateForm(false);
        fetchApiKeys();
      } else {
        setError(data.error || 'Failed to create API key');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const revokeApiKey = async (keyId) => {
    if (!confirm('Are you sure you want to revoke this API key? This action cannot be undone.')) {
      return;
    }

    try {
      const response = await fetch(`/my/api-keys/${keyId}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (response.ok) {
        setSuccess('API key revoked successfully');
        fetchApiKeys();
      } else {
        const data = await response.json();
        setError(data.error || 'Failed to revoke API key');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setSuccess('Copied to clipboard!');
    setTimeout(() => setSuccess(null), 2000);
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'Never';
    return new Date(dateString).toLocaleString();
  };

  const isExpired = (expiresAt) => {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  };

  if (loading) {
    return (
      <div className="page">
        <div className="loading">Loading API keys...</div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>API Keys</h1>
        <p>Manage API keys for programmatic access</p>
      </header>

      {error && (
        <div className="card error">
          <h3>✗ Error</h3>
          <p>{error}</p>
          <button onClick={() => setError(null)} className="btn btn-secondary">
            Dismiss
          </button>
        </div>
      )}

      {success && (
        <div className="card success">
          <h3>✓ Success</h3>
          <p>{success}</p>
          <button onClick={() => setSuccess(null)} className="btn btn-secondary">
            Dismiss
          </button>
        </div>
      )}

      {createdKey && (
        <div className="card highlight">
          <h3>🔑 New API Key Created</h3>
          <p className="warning-text">
            ⚠️ Copy this key now - you won't be able to see it again!
          </p>
          <div className="key-display">
            <code className="api-key">{createdKey}</code>
            <button
              onClick={() => copyToClipboard(createdKey)}
              className="btn btn-secondary btn-sm"
            >
              📋 Copy
            </button>
          </div>
          <button onClick={() => setCreatedKey(null)} className="btn btn-primary">
            I've copied the key
          </button>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h2>Your API Keys</h2>
          <button
            onClick={() => setShowCreateForm(!showCreateForm)}
            className="btn btn-primary"
          >
            {showCreateForm ? 'Cancel' : '+ Create New Key'}
          </button>
        </div>

        {showCreateForm && (
          <form onSubmit={createApiKey} className="create-key-form">
            <div className="form-group">
              <label htmlFor="keyName">Key Name *</label>
              <input
                type="text"
                id="keyName"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g., Production Server, Mobile App, etc."
                required
              />
              <p className="help-text">
                A descriptive name to help you identify this key
              </p>
            </div>

            <div className="form-group">
              <label htmlFor="expiration">Expiration (days)</label>
              <input
                type="number"
                id="expiration"
                value={newKeyExpiration}
                onChange={(e) => setNewKeyExpiration(e.target.value)}
                placeholder="e.g., 30, 90, 365"
                min="1"
              />
              <p className="help-text">
                Leave empty for no expiration
              </p>
            </div>

            <div className="form-group">
              <label htmlFor="rateLimit">Rate Limit (requests per minute)</label>
              <input
                type="number"
                id="rateLimit"
                value={newKeyRateLimit}
                onChange={(e) => setNewKeyRateLimit(e.target.value)}
                placeholder="e.g., 100, 1000"
                min="1"
              />
              <p className="help-text">
                Leave empty for no rate limit
              </p>
            </div>

            <button type="submit" className="btn btn-primary">
              Create API Key
            </button>
          </form>
        )}
      </div>

      {apiKeys.length === 0 ? (
        <div className="card">
          <p className="no-results">
            No API keys found. Create your first API key to get started with programmatic access.
          </p>
        </div>
      ) : (
        <div className="api-keys-list">
          {apiKeys.map((key) => (
            <div
              key={key.keyId}
              className={`card api-key-card ${isExpired(key.expiresAt) ? 'expired' : ''}`}
            >
              <div className="api-key-header">
                <div className="api-key-info">
                  <h3>{key.name}</h3>
                  <div className="api-key-meta">
                    <span className="key-id">ID: {key.keyId}</span>
                    {isExpired(key.expiresAt) && (
                      <span className="badge expired">⚠️ Expired</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => revokeApiKey(key.keyId)}
                  className="btn btn-danger btn-sm"
                >
                  Revoke
                </button>
              </div>

              <div className="api-key-stats">
                <div className="stat-item">
                  <span className="stat-label">Created:</span>
                  <span className="stat-value">{formatDate(key.createdAt)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Expires:</span>
                  <span className="stat-value">
                    {key.expiresAt ? formatDate(key.expiresAt) : 'Never'}
                  </span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Last Used:</span>
                  <span className="stat-value">{formatDate(key.lastUsedAt)}</span>
                </div>
              </div>

              {key.rateLimit && (
                <div className="rate-limit-info">
                  <span className="info-label">Rate Limit:</span>
                  <span className="info-value">
                    {key.rateLimit.limit} requests per minute
                  </span>
                </div>
              )}

              <div className="usage-stats">
                <div className="usage-item">
                  <span className="usage-label">Total Uses:</span>
                  <span className="usage-value">{key.usageCount || 0}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3>📚 Using Your API Key</h3>
        <p className="help-text">
          Use your API key by including it in the Authorization header of your requests:
        </p>
        <div className="code-block">
          <pre>{`curl -X GET "https://yourdomain.com/abilities/search" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "get earnings data", "top_k": 5}'`}</pre>
        </div>
        <p className="help-text">
          Or in JavaScript:
        </p>
        <div className="code-block">
          <pre>{`const response = await fetch('https://yourdomain.com/abilities/search', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    query: 'get earnings data',
    top_k: 5
  })
});`}</pre>
        </div>
      </div>

      <div className="card">
        <h3>🔒 Security Best Practices</h3>
        <div className="info-list">
          <div className="info-item">
            <strong>Never commit API keys to version control</strong>
            <p>Store them in environment variables or secret management systems.</p>
          </div>
          <div className="info-item">
            <strong>Rotate keys regularly</strong>
            <p>Create new keys and revoke old ones periodically for better security.</p>
          </div>
          <div className="info-item">
            <strong>Use expiration dates</strong>
            <p>Set expiration dates on keys to limit potential exposure time.</p>
          </div>
          <div className="info-item">
            <strong>Set appropriate rate limits</strong>
            <p>Protect your account from abuse by setting reasonable rate limits.</p>
          </div>
          <div className="info-item">
            <strong>Revoke compromised keys immediately</strong>
            <p>If a key is exposed, revoke it right away and create a new one.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
