-- MCP session bug-report telemetry (Phase 3, docs/mcp-telemetry-plan.md).
--
-- Stores sanitised per-session JSONL traces from the unbrowse MCP server.
-- Triage worker (backend/src/jobs/triage-telemetry.ts) reads this hourly,
-- clusters by host_template + tool_sequence_prefix + error_code +
-- reflection_status, and stages new failure clusters as GitHub issues on
-- unbrowse-dev with label `triage-needed`.
--
-- Storage: Neon Postgres via DATABASE_URL (matches backend/src/services/neon.ts).
-- Apply with: psql "$DATABASE_URL" -f backend/schema/telemetry-sessions.sql
-- Re-run-safe (CREATE IF NOT EXISTS, ALTER TABLE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS telemetry_sessions (
  session_id              TEXT PRIMARY KEY,
  received_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_ms_total       BIGINT,
  tool_calls_total        INTEGER,
  errors_total            INTEGER,
  reflection_status       TEXT,        -- 'achieved' | 'failed' | 'partial' | 'missing' | 'unknown'
  events_json             JSONB NOT NULL,
  agent_kind_fingerprint  TEXT,
  mcp_version             TEXT,
  platform                TEXT,
  client_seed_fp          TEXT         -- sha256(seed):16, deletable via /telemetry/sessions
);

CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_received
  ON telemetry_sessions(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_reflection
  ON telemetry_sessions(reflection_status);
CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_client_seed
  ON telemetry_sessions(client_seed_fp);

-- Cluster dedup table — populated by backend/src/jobs/triage-telemetry.ts.
-- Cluster key is sha256:16 of (host_template + tool_sequence + error_code + reflection_status).
CREATE TABLE IF NOT EXISTS telemetry_clusters (
  cluster_key             TEXT PRIMARY KEY,
  first_seen_at           TIMESTAMPTZ NOT NULL,
  last_seen_at            TIMESTAMPTZ NOT NULL,
  session_count           INTEGER NOT NULL DEFAULT 1,
  github_issue_url        TEXT,        -- populated once an issue is opened
  representative_sessions JSONB        -- JSON array of up to 5 session_ids
);

CREATE INDEX IF NOT EXISTS idx_telemetry_clusters_last_seen
  ON telemetry_clusters(last_seen_at DESC);
