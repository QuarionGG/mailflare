CREATE TABLE native_crm_inbox_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  received_at TEXT NOT NULL,
  target_origin TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  raw_size INTEGER NOT NULL CHECK(raw_size > 0 AND raw_size <= 10485760),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0 AND attempts <= 4),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','exhausted')),
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  crm_message_id TEXT,
  last_error TEXT
);
CREATE INDEX native_crm_inbox_due_idx ON native_crm_inbox_deliveries(status,next_attempt_at);
CREATE INDEX native_crm_inbox_created_idx ON native_crm_inbox_deliveries(created_at);
