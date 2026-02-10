-- Ensure pgvector types (vector/halfvec + operator classes) exist before drizzle migrations run.
-- Runs once on first database init for the e2e postgres volume.
CREATE EXTENSION IF NOT EXISTS vector;

