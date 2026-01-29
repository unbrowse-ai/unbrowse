-- Unbrowse Skill Index — Cloud skill marketplace schema

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  version INTEGER DEFAULT 1,
  base_url TEXT NOT NULL,
  auth_method_type TEXT NOT NULL,
  endpoints_json TEXT NOT NULL,
  skill_md TEXT NOT NULL,
  api_template TEXT NOT NULL,
  creator_wallet TEXT NOT NULL,
  creator_alias TEXT,
  endpoint_count INTEGER NOT NULL,
  download_count INTEGER DEFAULT 0,
  tags_json TEXT DEFAULT '[]',
  search_text TEXT NOT NULL,
  -- Safety review
  review_status TEXT DEFAULT 'pending',   -- pending | approved | rejected | flagged
  review_reason TEXT,
  review_flags TEXT DEFAULT '[]',
  review_score INTEGER,
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_skills_service ON skills(service);
CREATE INDEX IF NOT EXISTS idx_skills_creator ON skills(creator_wallet);

-- Full-text search index
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  service, base_url, search_text, tags_text,
  content='skills',
  content_rowid='rowid'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, service, base_url, search_text, tags_text)
  VALUES (new.rowid, new.service, new.base_url, new.search_text, new.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, service, base_url, search_text, tags_text)
  VALUES ('delete', old.rowid, old.service, old.base_url, old.search_text, old.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, service, base_url, search_text, tags_text)
  VALUES ('delete', old.rowid, old.service, old.base_url, old.search_text, old.tags_json);
  INSERT INTO skills_fts(rowid, service, base_url, search_text, tags_text)
  VALUES (new.rowid, new.service, new.base_url, new.search_text, new.tags_json);
END;

-- Track individual downloads with Solana payment details
CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  downloaded_at TEXT DEFAULT (datetime('now')),
  -- Solana payment tracking
  payment_signature TEXT,
  payment_chain TEXT DEFAULT 'devnet',
  payment_mint TEXT,
  payer_wallet TEXT,
  amount_usd REAL,
  -- 4-party split amounts (USDC lamports)
  fee_payer_amount TEXT,
  creator_amount TEXT,
  treasury_amount TEXT
);

-- Migration: add review columns to existing skills tables
-- These are safe to re-run (ALTER TABLE ADD COLUMN IF NOT EXISTS equivalent via try/ignore)
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we catch errors in code.

-- Creator earnings tracking
CREATE TABLE IF NOT EXISTS creator_earnings (
  creator_wallet TEXT PRIMARY KEY,
  total_earned_usd REAL DEFAULT 0,
  total_downloads INTEGER DEFAULT 0,
  last_payout_at TEXT,
  pending_usd REAL DEFAULT 0
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Brain Marketplace Extension — Unified abilities (skills, patterns, extensions)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Track unique payers per ability (for ranking algorithm)
CREATE TABLE IF NOT EXISTS ability_payers (
  ability_id TEXT NOT NULL,
  payer_wallet TEXT NOT NULL,
  first_paid_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (ability_id, payer_wallet)
);

-- Leaderboard view: rank abilities by unique payers + downloads + review score
CREATE VIEW IF NOT EXISTS ability_leaderboard AS
SELECT
  s.*,
  COALESCE(ap.unique_payers, 0) as unique_payers,
  (COALESCE(ap.unique_payers, 0) * 100 + s.download_count * 10 + COALESCE(s.review_score, 0) * 5) as rank_score
FROM skills s
LEFT JOIN (
  SELECT ability_id, COUNT(*) as unique_payers
  FROM ability_payers
  GROUP BY ability_id
) ap ON s.id = ap.ability_id
WHERE s.review_status = 'approved'
ORDER BY rank_score DESC;
