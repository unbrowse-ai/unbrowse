import { useState } from 'react';

export default function Ingestion() {
  const [activeTab, setActiveTab] = useState('har');
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState('GET');
  const [headers, setHeaders] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      setError(null);
    }
  };

  const uploadHAR = async (e) => {
    e.preventDefault();
    if (!file) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/ingest', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      const data = await response.json();

      if (data.success) {
        setResult(data);
        setFile(null);
      } else {
        setError(data.error || 'Failed to upload HAR file');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const ingestAPI = async (e) => {
    e.preventDefault();
    if (!url) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      let parsedHeaders = {};
      if (headers.trim()) {
        try {
          parsedHeaders = JSON.parse(headers);
        } catch {
          setError('Invalid JSON in headers');
          setLoading(false);
          return;
        }
      }

      let parsedBody = null;
      if (body.trim()) {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          setError('Invalid JSON in body');
          setLoading(false);
          return;
        }
      }

      const response = await fetch('/ingest/api', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url,
          method,
          headers: parsedHeaders,
          body: parsedBody
        })
      });

      const data = await response.json();

      if (data.success) {
        setResult(data);
        setUrl('');
        setHeaders('');
        setBody('');
      } else {
        setError(data.error || 'Failed to ingest API');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>API Ingestion</h1>
        <p>Upload HAR files or add individual API endpoints</p>
      </header>

      <div className="tabs">
        <button
          className={`tab ${activeTab === 'har' ? 'active' : ''}`}
          onClick={() => setActiveTab('har')}
        >
          📁 HAR File
        </button>
        <button
          className={`tab ${activeTab === 'api' ? 'active' : ''}`}
          onClick={() => setActiveTab('api')}
        >
          🔗 Single API
        </button>
      </div>

      {activeTab === 'har' && (
        <div className="card">
          <h2>Upload HAR File</h2>
          <p className="help-text">
            Upload a HAR (HTTP Archive) file to automatically extract all API calls.
            You can export HAR files from Chrome DevTools (Network tab → Right-click → Save as HAR).
          </p>

          <form onSubmit={uploadHAR}>
            <div className="file-upload">
              <input
                type="file"
                id="har-file"
                accept=".har,application/json"
                onChange={handleFileChange}
                className="file-input"
              />
              <label htmlFor="har-file" className="file-label">
                {file ? (
                  <>
                    <span className="file-icon">📄</span>
                    <span className="file-name">{file.name}</span>
                    <span className="file-size">
                      ({(file.size / 1024).toFixed(2)} KB)
                    </span>
                  </>
                ) : (
                  <>
                    <span className="file-icon">📁</span>
                    <span>Click to choose HAR file</span>
                  </>
                )}
              </label>
            </div>

            <button type="submit" className="btn btn-primary" disabled={loading || !file}>
              {loading ? 'Uploading...' : 'Upload & Process'}
            </button>
          </form>
        </div>
      )}

      {activeTab === 'api' && (
        <div className="card">
          <h2>Add Single API Endpoint</h2>
          <p className="help-text">
            Manually add a single API endpoint to create an ability.
          </p>

          <form onSubmit={ingestAPI}>
            <div className="form-group">
              <label>URL</label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://api.github.com/users/octocat"
                required
              />
            </div>

            <div className="form-group">
              <label>HTTP Method</label>
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
                <option value="DELETE">DELETE</option>
              </select>
            </div>

            <div className="form-group">
              <label>Headers (JSON, optional)</label>
              <textarea
                value={headers}
                onChange={(e) => setHeaders(e.target.value)}
                placeholder='{"Accept": "application/json", "Authorization": "Bearer token"}'
                rows={4}
              />
            </div>

            {method !== 'GET' && (
              <div className="form-group">
                <label>Body (JSON, optional)</label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder='{"key": "value"}'
                  rows={4}
                />
              </div>
            )}

            <button type="submit" className="btn btn-primary" disabled={loading || !url}>
              {loading ? 'Processing...' : 'Ingest API'}
            </button>
          </form>
        </div>
      )}

      {result && (
        <div className="card success">
          <h3>✓ Success!</h3>
          <p>
            {activeTab === 'har'
              ? `HAR file uploaded and processing started. Session ID: ${result.sessionId || result.data?.session_id}`
              : `API endpoint ingested successfully. Ability ID: ${result.abilityId || result.data?.abilityId}`}
          </p>
          <p className="help-text">
            Go to the <a href="/abilities">Abilities</a> page to see your new abilities.
          </p>
        </div>
      )}

      {error && (
        <div className="card error">
          <h3>✗ Error</h3>
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}
