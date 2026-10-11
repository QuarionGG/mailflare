import assert from "node:assert/strict";
import test from "node:test";
import { renderDeploymentProfile } from "../scripts/deployment-profile.mjs";

const base = { name: "mailflare", main: "./worker.ts", keep_vars: true,
	services: [{ binding: "WORKER_SELF_REFERENCE", service: "mailflare" }],
	d1_databases: [{ binding: "DB", database_id: "fixture-db", migrations_dir: "drizzle/migrations" }],
	r2_buckets: [{ binding: "BUCKET", bucket_name: "fixture-raw" }],
	queues: { producers: [{ binding: "OUTBOUND_QUEUE", queue: "fixture-outbound" }], consumers: [{ queue: "fixture-outbound", max_retries: 3 }] },
	ai: { binding: "AI", remote: true }, send_email: [{ name: "EMAIL", remote: false }],
	triggers: { crons: ["*/5 * * * *", "0 2 * * *"] }, routes: [{ pattern: "mail.example.com", custom_domain: true }],
	durable_objects: { bindings: [{ name: "REALTIME", class_name: "RealtimeHub" }] },
	compatibility_flags: ["nodejs_compat"], vars: { EXISTING: "retained" } };
const profile = { expectedWorker: "mailflare", environment: "production", enabled: true, service: "crm", origin: "https://crm.example.com", recipients: ["support@example.com", "assistenza@example.com"] };
function render(value = profile) { return renderDeploymentProfile(JSON.stringify(value), JSON.stringify(base), "/workspace"); }

test("relay-only profile preserves all existing infrastructure, routing and email capabilities", () => {
	const result = render();
	const restored = structuredClone(result);
	restored.main = base.main;
	restored.d1_databases[0].migrations_dir = base.d1_databases[0].migrations_dir;
	restored.services.pop();
	for (const key of ["MAILFLARE_ENVIRONMENT", "CRM_INBOX_RELAY_ENABLED", "CRM_INBOX_ORIGIN", "CRM_INBOX_RECIPIENTS"]) delete restored.vars[key];
	assert.deepEqual(restored, base);
	assert.equal(result.main, "/workspace/worker.ts");
	assert.equal(result.vars.CRM_INBOX_RECIPIENTS, "support@example.com;assistenza@example.com");
	assert.deepEqual(result.services.at(-1), { binding: "CRM_INBOX", service: "crm" });
});

test("wrong Worker, cross-environment target, wildcard recipients and credentials fail closed", () => {
	for (const change of [{ expectedWorker: "another-worker" }, { service: "crm-staging" }, { origin: "https://crm.staging.example.com" },
		{ recipients: ["*@example.com"] }, { recipients: ["support@staging.example.com"] }, { secret: "never-accepted-inline" },
		{ origin: "https://password@crm.example.com" }, { recipients: ["support@example.com", "support@example.com"] }]) {
		assert.throws(() => render({ ...profile, ...change }));
	}
	assert.throws(() => renderDeploymentProfile("x".repeat(17 * 1024), JSON.stringify(base), "/workspace"), /size/);
	assert.throws(() => renderDeploymentProfile(JSON.stringify(profile), JSON.stringify({ ...base, keep_vars: false }), "/workspace"));
});
