import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { enqueueNativeCrmInbox, deliverNativeCrmInbox, recoverNativeCrmInbox } from "../src/lib/email/native-crm-inbox.ts";

const now = Date.parse("2026-10-11T00:00:00Z");
const bytes = Buffer.from("From: Customer <customer@example.com>\r\nTo: support@staging.example.com\r\nMessage-ID: <test@example.com>\r\nIn-Reply-To: <parent@example.com>\r\nReferences: <root@example.com> <parent@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=test\r\n\r\n--test\r\nContent-Type: text/plain\r\n\r\nSupport message\r\n--test\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=file.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAAECAw==\r\n--test--\r\n");
const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const input = { from: "customer@example.com", to: "support@staging.example.com", rawR2Key: "inbound/original.eml" };

function fixture(t, fetch = async () => new Response(JSON.stringify({ data: { accepted: true, duplicate: false, messageId: "crm-message" } }), { status: 202 })) {
	const sqlite = new DatabaseSync(":memory:");
	t.after(() => sqlite.close());
	sqlite.exec(readFileSync(new URL("../drizzle/migrations/0061_native_crm_inbox.sql", import.meta.url), "utf8"));
	sqlite.exec(readFileSync(new URL("../drizzle/migrations/0062_native_crm_environment_budget.sql", import.meta.url), "utf8"));
	function prepared(sql, parameters = []) {
		return {
			bind(...values) { return prepared(sql, values); },
			async run() { return { meta: sqlite.prepare(sql).run(...parameters) }; },
			async first() { return sqlite.prepare(sql).get(...parameters) ?? null; },
			async all() { return { results: sqlite.prepare(sql).all(...parameters) }; },
		};
	}
	const jobs = [];
	const objects = new Map([[input.rawR2Key, raw]]);
	const env = {
		MAILFLARE_ENVIRONMENT: "staging", CRM_INBOX_RELAY_ENABLED: "true",
		CRM_INBOX_RECIPIENTS: "support@staging.example.com; assistenza@staging.example.com",
		CRM_INBOX_ORIGIN: "https://crm.staging.example.com", CRM_INBOX_RELAY_SECRET: "local-only-contract-secret-at-least-32-chars",
		CRM_INBOX: { fetch }, DB: { prepare: prepared },
		BUCKET: { async get(key) { const object = objects.get(key); return object ? { size: object.byteLength, async arrayBuffer() { return object; } } : null; } },
		OUTBOUND_QUEUE: { async send(job, options) { jobs.push({ ...job, options }); } },
	};
	return { env, jobs, objects, sqlite, row: id => sqlite.prepare("SELECT * FROM native_crm_inbox_deliveries WHERE id=?").get(id) };
}

test("disabled relay has zero side effects; enabled relay isolates environment, origin and exact recipient aliases", async t => {
	assert.equal(await enqueueNativeCrmInbox({ CRM_INBOX_RELAY_ENABLED: "false" }, input, raw, now), null);
	const { env, sqlite } = fixture(t);
	await assert.rejects(enqueueNativeCrmInbox({ ...env, MAILFLARE_ENVIRONMENT: "unknown" }, input, raw, now), /explicit environment/);
	await assert.rejects(enqueueNativeCrmInbox({ ...env, MAILFLARE_ENVIRONMENT: "production" }, input, raw, now), /match its environment/);
	await assert.rejects(enqueueNativeCrmInbox({ ...env, CRM_INBOX_RECIPIENTS: "support@example.com" }, input, raw, now), /recipients matching/);
	await assert.rejects(enqueueNativeCrmInbox({ ...env, CRM_INBOX_ORIGIN: "https://crm.example.com" }, input, raw, now), /match its environment/);
	assert.equal(await enqueueNativeCrmInbox(env, { ...input, to: "hello@staging.example.com" }, raw, now), null);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM native_crm_inbox_deliveries").get().n, 0);
});

test("both QA aliases send exact MIME, attachment bytes and thread references with the agreed signed envelope", async t => {
	let calls = 0;
	const { env, objects, row } = fixture(t, async request => {
		calls++;
		assert.equal(request.url, "https://crm.staging.example.com/webhooks/email/receiving");
		assert.equal(request.redirect, "manual");
		assert.equal(request.headers.get("host"), "crm.staging.example.com");
		assert.equal(request.headers.get("content-length"), String(bytes.length));
		assert.deepEqual(Buffer.from(await request.arrayBuffer()), bytes);
		const h = name => request.headers.get(`x-orangecrm-email-${name}`);
		assert.equal(h("sha256"), createHash("sha256").update(bytes).digest("hex"));
		const signature = createHmac("sha256", env.CRM_INBOX_RELAY_SECRET).update(JSON.stringify(["orangecrm:email-relay:v1", h("environment"), h("id"), h("from"), h("to"), h("received-at"), h("timestamp"), h("sha256")])).digest("hex");
		assert.equal(h("signature"), signature);
		return new Response(JSON.stringify({ data: { accepted: true, duplicate: false, messageId: `crm-${calls}` } }), { status: 202 });
	});
	for (const to of [input.to, "assistenza@staging.example.com"]) {
		const id = await enqueueNativeCrmInbox(env, { ...input, to }, raw, now);
		await deliverNativeCrmInbox(env, { kind: "native-crm-inbox", deliveryId: id }, now);
		assert.equal(row(id).status, "accepted");
		assert.equal(row(id).attempts, 1);
	}
	assert.equal(calls, 2);
	assert.equal(objects.size, 1);
});

test("production aliases use the literal production HMAC environment and preserve the original MIME", async t => {
	let calls = 0;
	const { env, row } = fixture(t, async request => {
		calls++;
		assert.equal(request.url, "https://crm.example.com/webhooks/email/receiving");
		assert.equal(request.headers.get("host"), "crm.example.com");
		assert.deepEqual(Buffer.from(await request.arrayBuffer()), bytes);
		const h = name => request.headers.get(`x-orangecrm-email-${name}`);
		assert.equal(h("environment"), "production");
		const signature = createHmac("sha256", production.CRM_INBOX_RELAY_SECRET).update(JSON.stringify(["orangecrm:email-relay:v1", "production", h("id"), h("from"), h("to"), h("received-at"), h("timestamp"), h("sha256")])).digest("hex");
		assert.equal(h("signature"), signature);
		return new Response(JSON.stringify({ data: { accepted: true, messageId: `production-${calls}` } }), { status: 202 });
	});
	const production = { ...env, MAILFLARE_ENVIRONMENT: "production", CRM_INBOX_ORIGIN: "https://crm.example.com", CRM_INBOX_RECIPIENTS: "support@example.com;assistenza@example.com", CRM_INBOX_RELAY_SECRET: "independent-production-contract-secret-32chars" };
	for (const to of ["support@example.com", "assistenza@example.com"]) {
		const id = await enqueueNativeCrmInbox(production, { ...input, to }, raw, now);
		assert.equal(row(id).environment, "production");
		await deliverNativeCrmInbox(production, { kind: "native-crm-inbox", deliveryId: id }, now);
		assert.equal(row(id).status, "accepted");
	}
	assert.equal(calls, 2);
	assert.equal(await enqueueNativeCrmInbox(production, input, raw, now), null);
	await assert.rejects(enqueueNativeCrmInbox({ ...production, CRM_INBOX_RECIPIENTS: input.to }, input, raw, now), /recipients matching/);
	await assert.rejects(enqueueNativeCrmInbox({ ...production, CRM_INBOX: undefined }, input, raw, now), /private configuration/);
});

test("a captured staging row cannot be delivered under a production environment or acquire a renewed identity", async t => {
	let calls = 0;
	const { env, row, sqlite } = fixture(t, async () => { calls++; return new Response("should not dispatch"); });
	const id = await enqueueNativeCrmInbox(env, input, raw, now);
	// Even an incorrectly shared database cannot cross the receiver environment fence.
	sqlite.prepare("UPDATE native_crm_inbox_deliveries SET environment='production' WHERE id=?").run(id);
	await assert.rejects(enqueueNativeCrmInbox(env, input, raw, now + 1000), /immutable environment/);
	await deliverNativeCrmInbox(env, { kind: "native-crm-inbox", deliveryId: id }, now);
	assert.equal(row(id).status, "exhausted");
	assert.equal(row(id).received_at, new Date(now).toISOString());
	assert.equal(calls, 0);
});

test("four ambiguous Queue publications stop cron and SMTP fanout without resetting budgets; the last accepted copy may execute", async t => {
	let publications = 0;
	const { env, row, sqlite } = fixture(t);
	const unavailable = { ...env, OUTBOUND_QUEUE: { async send() { publications++; throw new Error("ambiguous-queue-response"); } } };
	await assert.rejects(enqueueNativeCrmInbox(unavailable, input, raw, now), /ambiguous-queue-response/);
	const id = sqlite.prepare("SELECT id FROM native_crm_inbox_deliveries").get().id;
	for (let index = 1; index < 4; index++) {
		await assert.rejects(recoverNativeCrmInbox(unavailable, now + index * 60_000), /ambiguous-queue-response/);
	}
	await recoverNativeCrmInbox(unavailable, now + 5 * 60_000);
	assert.equal(await enqueueNativeCrmInbox(unavailable, input, raw, now + 5 * 60_000), id);
	assert.equal(publications, 4);
	assert.equal(row(id).dispatches, 4);
	assert.equal(row(id).attempts, 0);
	assert.equal(row(id).received_at, new Date(now).toISOString());
	await deliverNativeCrmInbox(env, { kind: "native-crm-inbox", deliveryId: id }, now + 5 * 60_000);
	assert.equal(row(id).status, "accepted");
	assert.equal(row(id).dispatches, 4);
	assert.equal(row(id).attempts, 1);
});

test("SMTP replay freezes first archive, received-at, target and budget; concurrent queue delivery performs one request", async t => {
	let release;
	let calls = 0;
	const { env, row } = fixture(t, async () => {
		calls++;
		await new Promise(resolve => { release = resolve; });
		return new Response(JSON.stringify({ data: { accepted: true, duplicate: true, messageId: "crm-existing" } }), { status: 202 });
	});
	const id = await enqueueNativeCrmInbox(env, input, raw, now);
	assert.equal(await enqueueNativeCrmInbox(env, { ...input, rawR2Key: "inbound/smtp-retry.eml" }, raw, now + 1000), id);
	assert.equal(row(id).raw_r2_key, input.rawR2Key);
	assert.equal(row(id).received_at, new Date(now).toISOString());
	const active = deliverNativeCrmInbox(env, { kind: "native-crm-inbox", deliveryId: id }, now);
	while (!release) await new Promise(resolve => setImmediate(resolve));
	await deliverNativeCrmInbox(env, { kind: "native-crm-inbox", deliveryId: id }, now);
	assert.equal(calls, 1);
	release(); await active;
	await deliverNativeCrmInbox(env, { kind: "native-crm-inbox", deliveryId: id }, now + 2000);
	assert.equal(calls, 1);
	assert.equal(row(id).crm_message_id, "crm-existing");
});

test("four receiver failures exhaust the same delivery and SMTP replay cannot reset its retry budget", async t => {
	let calls = 0;
	const { env, row, jobs } = fixture(t, async () => { calls++; return new Response("temporary", { status: 503 }); });
	const id = await enqueueNativeCrmInbox(env, input, raw, now);
	let clock = now;
	for (let attempt = 1; attempt <= 4; attempt++) {
		await deliverNativeCrmInbox(env, { kind: "native-crm-inbox", deliveryId: id }, clock);
		assert.equal(row(id).attempts, attempt);
		clock = row(id).next_attempt_at;
	}
	assert.equal(row(id).status, "exhausted");
	const queued = jobs.length;
	await enqueueNativeCrmInbox(env, input, raw, clock);
	await recoverNativeCrmInbox(env, clock);
	await deliverNativeCrmInbox(env, { kind: "native-crm-inbox", deliveryId: id }, clock);
	assert.equal(calls, 4); assert.equal(jobs.length, queued);
	assert.equal(row(id).attempts, 4);
});

test("expired originals, changed archive or staging destination and terminal receiver failures do not dispatch or retry", async t => {
	let calls = 0;
	const { env, row, objects } = fixture(t, async () => { calls++; return new Response("conflict", { status: 409 }); });
	const id = await enqueueNativeCrmInbox(env, input, raw, now);
	await deliverNativeCrmInbox(env, { kind: "native-crm-inbox", deliveryId: id }, now + 23 * 60 * 60_000);
	assert.equal(row(id).status, "exhausted"); assert.equal(calls, 0);
	const second = { ...input, to: "assistenza@staging.example.com" };
	const secondId = await enqueueNativeCrmInbox(env, second, raw, now);
	objects.set(input.rawR2Key, new Uint8Array(bytes.length).buffer);
	await deliverNativeCrmInbox(env, { kind: "native-crm-inbox", deliveryId: secondId }, now);
	assert.equal(row(secondId).status, "exhausted"); assert.equal(calls, 0);
	objects.set(input.rawR2Key, raw);
	const thirdId = await enqueueNativeCrmInbox(env, { ...input, from: "other@example.com" }, raw, now);
	await deliverNativeCrmInbox({ ...env, CRM_INBOX_ORIGIN: "https://other.staging.example.com" }, { kind: "native-crm-inbox", deliveryId: thirdId }, now);
	assert.equal(row(thirdId).status, "exhausted"); assert.equal(calls, 0);
	const fourthId = await enqueueNativeCrmInbox(env, { ...input, from: "third@example.com" }, raw, now);
	await deliverNativeCrmInbox(env, { kind: "native-crm-inbox", deliveryId: fourthId }, now);
	assert.equal(row(fourthId).status, "exhausted"); assert.equal(calls, 1);
});

test("durable publish failure recovers the same snapshot; oversize input and acknowledgement stay bounded", async t => {
	const { env, row, jobs } = fixture(t, async () => new Response("x".repeat(17 * 1024), { status: 202 }));
	await assert.rejects(enqueueNativeCrmInbox(env, input, new ArrayBuffer(10 * 1024 * 1024 + 1), now), /receiving contract/);
	await assert.rejects(enqueueNativeCrmInbox({ ...env, OUTBOUND_QUEUE: { async send() { throw new Error("queue-unavailable"); } } }, input, raw, now), /queue-unavailable/);
	await recoverNativeCrmInbox(env, now + 60_000);
	assert.equal(jobs.length, 1);
	const id = jobs[0].deliveryId;
	await deliverNativeCrmInbox(env, jobs[0], now);
	assert.equal(row(id).status, "pending"); assert.equal(row(id).attempts, 1);
});

test("the atomic daily cap rejects another identity and leaves replay budgets frozen", async t => {
	const { env, row, sqlite } = fixture(t);
	let firstId;
	for (let index = 0; index < 50; index++) {
		const id = await enqueueNativeCrmInbox(env, { ...input, from: `customer${index}@example.com` }, raw, now);
		firstId ??= id;
	}
	await assert.rejects(enqueueNativeCrmInbox(env, { ...input, from: "overflow@example.com" }, raw, now), /daily budget/);
	assert.equal(await enqueueNativeCrmInbox(env, { ...input, from: "customer0@example.com" }, raw, now + 1000), firstId);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM native_crm_inbox_deliveries").get().n, 50);
	assert.equal(row(firstId).attempts, 0);
	assert.equal(row(firstId).received_at, new Date(now).toISOString());
});
