-- Active Salesforce connector per dashboard (for environment switching)
CREATE TABLE IF NOT EXISTS dashboard_sf_active_env (
  dashboard_id TEXT PRIMARY KEY,
  active_connector_id TEXT NOT NULL,
  active_environment TEXT NOT NULL, -- sandbox | production
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_sf_active_env_connector_id ON dashboard_sf_active_env(active_connector_id);

-- Query audit logs for governance / troubleshooting
CREATE TABLE IF NOT EXISTS sf_query_audit_logs (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL,
  connector_id TEXT,
  environment TEXT,
  org_id TEXT,
  user_id TEXT,
  request_id TEXT NOT NULL,
  soql_hash TEXT,
  soql_preview TEXT,
  row_count INTEGER,
  duration_ms INTEGER,
  status TEXT NOT NULL, -- success | blocked | upstream_error
  error_code TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sf_query_audit_dashboard_created ON sf_query_audit_logs(dashboard_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sf_query_audit_connector_created ON sf_query_audit_logs(connector_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sf_query_audit_status_created ON sf_query_audit_logs(status, created_at DESC);
