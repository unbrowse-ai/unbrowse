-- One row per CI run (latest attempt wins); the hard-site check's per-site results beside it.
CREATE TABLE IF NOT EXISTS runs (
  run_id INTEGER PRIMARY KEY,
  attempt INTEGER NOT NULL,
  workflow TEXT NOT NULL,
  branch TEXT NOT NULL,
  sha TEXT NOT NULL,
  event TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  wall_s INTEGER,
  metrics TEXT NOT NULL DEFAULT '{}',
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_branch_finished ON runs (branch, finished_at);
CREATE TABLE IF NOT EXISTS sites (
  run_id INTEGER NOT NULL,
  site TEXT NOT NULL,
  label TEXT NOT NULL,
  seconds INTEGER,
  PRIMARY KEY (run_id, site)
);
