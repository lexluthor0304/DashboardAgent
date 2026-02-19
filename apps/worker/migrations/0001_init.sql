-- Dashboards and share tokens (MVP, single-tenant)
CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  spec_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS share_tokens (
  dashboard_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (dashboard_id, token_hash),
  FOREIGN KEY (dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_share_tokens_expires_at ON share_tokens(expires_at);

-- Connectors (Salesforce-first, optional in MVP smoke tests)
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  instance_url TEXT,
  refresh_token_enc TEXT,
  created_at INTEGER NOT NULL
);

