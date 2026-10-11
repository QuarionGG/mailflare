# Native CRM inbox relay

The optional adapter sends the complete immutable inbound MIME to a CRM native
inbox using a private service binding. SMTP and signed `/api/inbound` intake
retain their existing routing, rejection, forwarding, raw storage and normal
Mailflare queue behavior. The adapter archives a delivery snapshot before Queue
publication and never derives routing from MIME To/CC headers.

Receiving is off by default. Explicitly configure `MAILFLARE_ENVIRONMENT` as
`staging` or `production`, `CRM_INBOX_RELAY_ENABLED=true`, an exact semicolon
separated `CRM_INBOX_RECIPIENTS` list, a trusted HTTPS `CRM_INBOX_ORIGIN`, the
private `CRM_INBOX` service binding and `CRM_INBOX_RELAY_SECRET` of at least
32 characters. Staging origin, service and mailbox domains must identify
staging; production cannot use staging targets. Use independent secrets and
storage for each environment. There is no public fetch fallback.

Apply additive migrations `0061_native_crm_inbox.sql` and
`0062_native_crm_environment_budget.sql` before enabling. Migration 0061 retains
the schema already used by older staging adapters; 0062 adds the immutable
environment and publication budget. Existing rows acquire staging provenance.
The standard build/deploy scripts only generate the migration bundle; they do
not apply remote migrations. Apply once through the reviewed installation
procedure, and retain the migration ledger on rollback. Backup/restore includes
the new outbox and preserves closed budgets; older backups remain supported.

The deployment-owned `MAILFLARE_DEPLOYMENT_PROFILE` is an encrypted Build
setting containing a small JSON object with only `expectedWorker`, `environment`,
`enabled`, `service`, `origin` and `recipients` (an exact address array). Never
include credentials, the HMAC secret or a full installation snapshot. The
renderer parses the existing `wrangler.jsonc`, verifies the expected Worker and
`keep_vars`, appends one CRM service binding and merges four relay variables.
All other services, database/storage/Queue bindings, routes, cron, AI and email
capabilities remain unchanged. It only adjusts relative paths for the ignored
generated configuration directory. Vite selects that file when the Build
profile is present; without it the existing configuration remains selected.
Provision the HMAC directly as a runtime Worker secret, outside the profile.
The generated `.mailflare-deployment/` directory must never be committed.

The CRM endpoint is `POST /webhooks/email/receiving`, exact `message/rfc822`
bytes and Content-Length, with explicit trusted Host. The signed headers use
`x-orangecrm-email-`: environment, id, from, to, received-at, timestamp, sha256,
signature. HMAC-SHA256 signs the UTF-8 JSON array
`["orangecrm:email-relay:v1",environment,id,from,to,receivedAt,timestamp,sha256]`;
timestamp is a current Unix-seconds string. The original identity, environment,
envelope, MIME hash/key, received time, target and 23-hour deadline are frozen.
Only a bounded 202 acknowledgement with `data.accepted=true` and message ID
marks the relay accepted. Observe the native received conversation separately.

Limits per installation: 10 MiB raw input; 50 new originals per UTC day; four
execution attempts; four atomic Queue publication reservations; 60-second
publication cooldown; 23-hour original window; 15-second archive read and
10-second request/acknowledgement deadline; 16 KiB acknowledgement; ten recovery
rows per existing five-minute cron pass. These code limits are not account-wide
billing caps. An ambiguous Queue response consumes its reservation. Exhausted
publication budgets cannot be reopened; an already accepted last Queue copy
may still execute within the original attempt/deadline budget. A pending row
with four publications requires reconciliation if no queued copy arrives; it
expires without new IDs or reset. Receiver 429/5xx and transient failures retry
with backoff; permanent status, changed environment/target/original stops.

Before release, read back the actual controller, exact source revision, runtime
resources and routing; review the generated configuration delta, migrate once,
provision environment secrets and deploy the compatible receiver first. Live
verification uses an explicitly approved bounded fixture run, exact native
conversation IDs, body/attachment/raw hashes and source acknowledgement.
Disable the relay flag for rollback and preserve rows, originals and budgets.

Local checks: `node --test tests/native-crm-inbox.test.mjs
tests/deployment-profile.test.mjs tests/backups-migration-coverage.test.mjs
tests/setup-bootstrap-schema.test.mjs`. These do not establish live delivery.
