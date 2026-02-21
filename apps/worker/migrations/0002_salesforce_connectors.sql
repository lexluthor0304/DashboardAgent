-- Salesforce connector persistence (dashboard-scoped)
CREATE TABLE IF NOT EXISTS sf_connectors (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL,
  environment TEXT NOT NULL, -- sandbox | production
  status TEXT NOT NULL, -- pending | connected | error | revoked
  instance_url TEXT,
  org_id TEXT,
  user_id TEXT,
  refresh_token_enc TEXT,
  access_token_enc TEXT,
  token_expires_at INTEGER,
  scopes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sf_connectors_dashboard_id ON sf_connectors(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_sf_connectors_status ON sf_connectors(status);

-- OAuth state for auth code callbacks
CREATE TABLE IF NOT EXISTS connector_oauth_states (
  state TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_connector_oauth_states_expires_at ON connector_oauth_states(expires_at);
