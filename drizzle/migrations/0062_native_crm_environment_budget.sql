ALTER TABLE native_crm_inbox_deliveries ADD COLUMN environment TEXT NOT NULL DEFAULT 'staging'
  CHECK(environment IN ('staging','production'));
ALTER TABLE native_crm_inbox_deliveries ADD COLUMN dispatches INTEGER NOT NULL DEFAULT 0
  CHECK(dispatches >= 0 AND dispatches <= 4);
ALTER TABLE native_crm_inbox_deliveries ADD COLUMN next_dispatch_at INTEGER NOT NULL DEFAULT 0;
