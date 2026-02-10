import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

export default function Credentials() {
  const { user } = useAuth();
  const [credentials, setCredentials] = useState([]);
  const [groupedCredentials, setGroupedCredentials] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [viewMode, setViewMode] = useState('grouped'); // 'grouped' or 'list'
  const [selectedDomain, setSelectedDomain] = useState(null);
  const [encryptionKey, setEncryptionKey] = useState('');

  useEffect(() => {
    fetchCredentials();
  }, [viewMode]);

  const fetchCredentials = async () => {
    setLoading(true);
    setError(null);

    try {
      const url = viewMode === 'grouped'
        ? '/my/credentials?groupByDomain=true'
        : '/my/credentials';

      const response = await fetch(url, {
        credentials: 'include',
      });

      const data = await response.json();

      if (response.ok) {
        if (viewMode === 'grouped') {
          setGroupedCredentials(data.credentials || {});
        } else {
          setCredentials(data.credentials || []);
        }
      } else {
        setError(data.error || 'Failed to fetch credentials');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const deleteCredentialsByDomain = async (domain) => {
    if (!confirm(`Delete all credentials for ${domain}?`)) {
      return;
    }

    try {
      const response = await fetch(`/my/credentials/${encodeURIComponent(domain)}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (response.ok) {
        setSuccess(`All credentials for ${domain} deleted successfully`);
        fetchCredentials();
      } else {
        const data = await response.json();
        setError(data.error || 'Failed to delete credentials');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteCredential = async (credentialId) => {
    if (!confirm('Delete this credential?')) {
      return;
    }

    try {
      const response = await fetch(`/my/credentials/by-id/${credentialId}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (response.ok) {
        setSuccess('Credential deleted successfully');
        fetchCredentials();
      } else {
        const data = await response.json();
        setError(data.error || 'Failed to delete credential');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const getCredentialIcon = (type) => {
    switch (type) {
      case 'cookie':
        return '🍪';
      case 'header':
        return '📋';
      case 'auth_token':
        return '🔑';
      default:
        return '📄';
    }
  };

  if (loading) {
    return (
      <div className="page">
        <div className="loading">Loading credentials...</div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Credentials Manager</h1>
        <p>Manage your encrypted credentials for API authentication</p>
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

      <div className="card">
        <div className="credentials-info">
          <h3>🔒 Security Notice</h3>
          <p>
            All credentials are encrypted CLIENT-SIDE before being sent to our servers.
            We use AES-256-GCM encryption and never see your plaintext credentials.
          </p>
          <p className="help-text">
            To upload credentials, please use our browser extension which handles encryption
            automatically.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="view-toggle">
          <button
            className={`btn ${viewMode === 'grouped' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('grouped')}
          >
            📁 Group by Domain
          </button>
          <button
            className={`btn ${viewMode === 'list' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('list')}
          >
            📋 List View
          </button>
        </div>
      </div>

      {viewMode === 'grouped' ? (
        <div className="credentials-grouped">
          {Object.keys(groupedCredentials).length === 0 ? (
            <div className="card">
              <p className="no-results">
                No credentials found. Use the browser extension to upload encrypted credentials.
              </p>
            </div>
          ) : (
            Object.entries(groupedCredentials).map(([domain, domainCreds]) => (
              <div key={domain} className="card credential-domain-card">
                <div className="credential-domain-header">
                  <h3>🌐 {domain}</h3>
                  <button
                    onClick={() => deleteCredentialsByDomain(domain)}
                    className="btn btn-danger btn-sm"
                  >
                    Delete All
                  </button>
                </div>

                <div className="credential-stats">
                  <span className="stat">
                    {domainCreds.length} credential{domainCreds.length !== 1 ? 's' : ''}
                  </span>
                  <span className="stat">
                    {domainCreds.filter((c) => c.credentialType === 'cookie').length} cookies
                  </span>
                  <span className="stat">
                    {domainCreds.filter((c) => c.credentialType === 'header').length} headers
                  </span>
                  <span className="stat">
                    {domainCreds.filter((c) => c.credentialType === 'auth_token').length} tokens
                  </span>
                </div>

                <div className="credential-list">
                  {domainCreds.map((cred) => (
                    <div key={cred.credentialId} className="credential-item">
                      <div className="credential-info">
                        <span className="credential-icon">
                          {getCredentialIcon(cred.credentialType)}
                        </span>
                        <div className="credential-details">
                          <span className="credential-key">{cred.credentialKey}</span>
                          <span className="credential-type">{cred.credentialType}</span>
                        </div>
                      </div>
                      <div className="credential-actions">
                        <span className="credential-date">
                          Updated: {new Date(cred.updatedAt).toLocaleDateString()}
                        </span>
                        <button
                          onClick={() => deleteCredential(cred.credentialId)}
                          className="btn btn-danger btn-sm"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="credentials-list">
          {credentials.length === 0 ? (
            <div className="card">
              <p className="no-results">
                No credentials found. Use the browser extension to upload encrypted credentials.
              </p>
            </div>
          ) : (
            <div className="card">
              <table className="credentials-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Domain</th>
                    <th>Key</th>
                    <th>Created</th>
                    <th>Updated</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {credentials.map((cred) => (
                    <tr key={cred.credentialId}>
                      <td>
                        <span className="credential-type-badge">
                          {getCredentialIcon(cred.credentialType)} {cred.credentialType}
                        </span>
                      </td>
                      <td className="domain-cell">{cred.domain}</td>
                      <td className="key-cell">{cred.credentialKey}</td>
                      <td>{new Date(cred.createdAt).toLocaleDateString()}</td>
                      <td>{new Date(cred.updatedAt).toLocaleDateString()}</td>
                      <td>
                        <button
                          onClick={() => deleteCredential(cred.credentialId)}
                          className="btn btn-danger btn-sm"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3>📦 Export / Import</h3>
        <p className="help-text">
          You can export and import your encrypted credentials for backup or transfer.
          Remember: credentials remain encrypted and require your encryption key to decrypt.
        </p>
        <div className="export-actions">
          <button
            onClick={() => {
              const dataStr = JSON.stringify(
                viewMode === 'grouped' ? groupedCredentials : credentials,
                null,
                2
              );
              const dataBlob = new Blob([dataStr], { type: 'application/json' });
              const url = URL.createObjectURL(dataBlob);
              const link = document.createElement('a');
              link.href = url;
              link.download = `credentials-${new Date().toISOString()}.json`;
              link.click();
              URL.revokeObjectURL(url);
            }}
            className="btn btn-secondary"
            disabled={
              (viewMode === 'grouped' && Object.keys(groupedCredentials).length === 0) ||
              (viewMode === 'list' && credentials.length === 0)
            }
          >
            📥 Export Credentials
          </button>
        </div>
      </div>

      <div className="card">
        <h3>ℹ️ How It Works</h3>
        <div className="info-list">
          <div className="info-item">
            <strong>1. Browser Extension</strong>
            <p>
              Install our browser extension to automatically capture and encrypt credentials
              from your browsing sessions.
            </p>
          </div>
          <div className="info-item">
            <strong>2. Client-Side Encryption</strong>
            <p>
              All credentials are encrypted in your browser using AES-256-GCM before being
              sent to our servers.
            </p>
          </div>
          <div className="info-item">
            <strong>3. Zero-Knowledge Storage</strong>
            <p>
              We store only the encrypted values. We never have access to your plaintext
              credentials.
            </p>
          </div>
          <div className="info-item">
            <strong>4. Automatic Authentication</strong>
            <p>
              When executing abilities that require authentication, credentials are decrypted
              client-side and used automatically.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
