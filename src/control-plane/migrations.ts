export const MIGRATION_V1 = `
CREATE TABLE core_connection (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  base_url TEXT NOT NULL,
  last_status TEXT,
  last_version TEXT,
  last_checked_at TEXT
);

CREATE TABLE extensions (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE invocation_targets (
  id TEXT PRIMARY KEY,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  cli TEXT NOT NULL,
  native_model TEXT NOT NULL,
  reasoning_effort TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  isolation_level TEXT NOT NULL CHECK (isolation_level IN ('strict','best_effort')),
  streaming_mode TEXT NOT NULL CHECK (streaming_mode IN ('native','none')),
  tool_bridge TEXT NOT NULL CHECK (tool_bridge IN ('structured_output','none')),
  max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrency > 0),
  max_queue INTEGER NOT NULL DEFAULT 8 CHECK (max_queue >= 0),
  queue_timeout_ms INTEGER NOT NULL DEFAULT 300000 CHECK (queue_timeout_ms > 0),
  run_timeout_ms INTEGER CHECK (run_timeout_ms IS NULL OR run_timeout_ms > 0),
  fixed_workspace TEXT,
  capability_version TEXT,
  capability_verified_at TEXT,
  capability_json TEXT,
  capability_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  digest TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  rotated_from TEXT REFERENCES credentials(id)
);

CREATE TABLE grants (
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES invocation_targets(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (client_id, extension_id, target_id)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id),
  extension_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status TEXT NOT NULL,
  response_id TEXT,
  native_session_id TEXT,
  error_code TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  latency_ms INTEGER
);

CREATE TABLE response_sessions (
  response_id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  native_session_id TEXT,
  parent_response_id TEXT REFERENCES response_sessions(response_id),
  child_response_id TEXT REFERENCES response_sessions(response_id),
  workspace_path TEXT,
  stored INTEGER NOT NULL,
  state TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  key_digest TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  response_id TEXT,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (client_id, key_digest)
);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  csrf_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_credentials_client ON credentials(client_id);
CREATE INDEX idx_runs_created ON runs(queued_at DESC);
CREATE INDEX idx_response_expiry ON response_sessions(expires_at);
CREATE INDEX idx_response_chain ON response_sessions(chain_id);
CREATE INDEX idx_idempotency_expiry ON idempotency_keys(expires_at);

INSERT INTO core_connection(singleton, base_url) VALUES (1, 'http://127.0.0.1:28771');
`;

export const TARGET_VERSION = 1;
