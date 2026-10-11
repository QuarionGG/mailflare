/** Opt-in raw MIME relay. The durable row owns identity, environment and budgets. */
export type NativeCrmInboxJob = { kind: "native-crm-inbox"; deliveryId: string };
type RelayEnv = Pick<CloudflareEnv, "DB" | "BUCKET" | "OUTBOUND_QUEUE"> & {
	MAILFLARE_ENVIRONMENT?: string;
	CRM_INBOX_RELAY_ENABLED?: string;
	CRM_INBOX_RECIPIENTS?: string;
	CRM_INBOX_ORIGIN?: string;
	CRM_INBOX_RELAY_SECRET?: string;
	CRM_INBOX?: Fetcher;
};
type Incoming = { from: string; to: string; rawR2Key: string };
type Delivery = {
	id: string; from_address: string; to_address: string; received_at: string;
	environment: "staging" | "production"; dispatches: number; next_dispatch_at: number;
	target_origin: string;
	raw_r2_key: string; raw_sha256: string; raw_size: number; expires_at: number;
	attempts: number; status: string; next_attempt_at: number; lease_until: number | null;
	crm_message_id: string | null;
};
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ATTEMPTS = 4;
const MAX_DISPATCHES = 4;
const DISPATCH_COOLDOWN_MS = 60_000;
const MAX_DAILY_DELIVERIES = 50;
const MAX_AGE_MS = 23 * 60 * 60 * 1000;
const LEASE_MS = 60_000;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/;

function configuration(env: RelayEnv) {
	if (env.CRM_INBOX_RELAY_ENABLED !== "true") return null;
	const environment = env.MAILFLARE_ENVIRONMENT;
	if ((environment !== "staging" && environment !== "production") || !env.CRM_INBOX || !env.CRM_INBOX_RELAY_SECRET || env.CRM_INBOX_RELAY_SECRET.trim().length < 32) {
		throw new Error("Native CRM inbox relay requires an explicit environment and private configuration");
	}
	const origin = new URL(env.CRM_INBOX_ORIGIN ?? "");
	if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
		|| origin.port || origin.hostname === "localhost" || /^\d+(?:\.\d+){3}$/.test(origin.hostname)
		|| origin.hostname.includes(":") || origin.hostname.split(/[.-]/).includes("staging") !== (environment === "staging")) {
		throw new Error("Native CRM inbox origin must match its environment");
	}
	const recipients = String(env.CRM_INBOX_RECIPIENTS ?? "").split(/[;,\n]/).map(value => value.trim().toLowerCase()).filter(Boolean);
	if (!recipients.length || recipients.length > 4 || recipients.some(value => !EMAIL.test(value) || value.includes("*")
		|| value.split("@")[1].split(/[.-]/).includes("staging") !== (environment === "staging"))) {
		throw new Error("Native CRM inbox relay requires exact recipients matching its environment");
	}
	return { environment, origin, recipients, binding: env.CRM_INBOX, secret: env.CRM_INBOX_RELAY_SECRET.trim() };
}

function hex(bytes: ArrayBuffer) { return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join(""); }
async function sha256(bytes: ArrayBuffer) { return hex(await crypto.subtle.digest("SHA-256", bytes)); }
export async function nativeCrmIdentity(from: string, to: string, raw: ArrayBuffer): Promise<string> {
	const prefix = new TextEncoder().encode(JSON.stringify(["mailflare:native-inbox:v1", from, to]));
	const bytes = new Uint8Array(prefix.byteLength + raw.byteLength);
	bytes.set(prefix); bytes.set(new Uint8Array(raw), prefix.byteLength);
	return `mailflare:${await sha256(bytes.buffer)}`;
}

/** Called after immutable raw storage, before acknowledging SMTP or its signed relay. */
export async function enqueueNativeCrmInbox(env: RelayEnv, incoming: Incoming, raw: ArrayBuffer, now = Date.now()): Promise<string | null> {
	const config = configuration(env);
	if (!config) return null;
	const from = incoming.from.trim().toLowerCase();
	const to = incoming.to.trim().toLowerCase();
	if (!config.recipients.includes(to)) return null;
	if (!EMAIL.test(from) || !raw.byteLength || raw.byteLength > MAX_BYTES) throw new Error("Native CRM inbox original exceeds its receiving contract");
	const id = await nativeCrmIdentity(from, to, raw);
	const hash = await sha256(raw);
	const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
	await env.DB.prepare(`INSERT INTO native_crm_inbox_deliveries
		(id,environment,from_address,to_address,received_at,target_origin,raw_r2_key,raw_sha256,raw_size,created_at,expires_at,attempts,status,next_attempt_at)
		SELECT ?,?,?,?,?,?,?,?,?,?,?,0,'pending',? WHERE (SELECT count(*) FROM native_crm_inbox_deliveries WHERE created_at>=?)<?
		ON CONFLICT(id) DO NOTHING`)
		.bind(id, config.environment, from, to, new Date(now).toISOString(), config.origin.origin, incoming.rawR2Key, hash, raw.byteLength, now, now + MAX_AGE_MS, now, dayStart, MAX_DAILY_DELIVERIES).run();
	const row = await env.DB.prepare("SELECT * FROM native_crm_inbox_deliveries WHERE id = ?").bind(id).first<Delivery>();
	if (!row) throw new Error("Native CRM inbox daily budget exhausted");
	if (row.environment !== config.environment) throw new Error("Native CRM inbox immutable environment conflict");
	if (row.raw_sha256 !== hash || row.from_address !== from || row.to_address !== to) throw new Error("Native CRM inbox immutable identity conflict");
	if (row.status === "pending" && row.expires_at > now && row.attempts < MAX_ATTEMPTS) {
		await publishNativeCrmInbox(env, id, now);
	}
	return id;
}

/** Reserve before Queue submission; an ambiguous publication consumes its budget. */
async function publishNativeCrmInbox(env: RelayEnv, id: string, now: number, delaySeconds = 0) {
	const scheduledAt = now + delaySeconds * 1000;
	const reserved = await env.DB.prepare(`UPDATE native_crm_inbox_deliveries
		SET dispatches=dispatches+1,next_dispatch_at=?
		WHERE id=? AND status='pending' AND expires_at>? AND attempts<?
		AND dispatches<? AND next_dispatch_at<=? RETURNING id`)
		.bind(scheduledAt + DISPATCH_COOLDOWN_MS, id, scheduledAt, MAX_ATTEMPTS, MAX_DISPATCHES, scheduledAt).first<{ id: string }>();
	if (reserved) await env.OUTBOUND_QUEUE.send({ kind: "native-crm-inbox", deliveryId: id }, { delaySeconds });
}

async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([work, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("Native inbox request deadline exceeded")), Math.max(0, deadline - performance.now()));
		})]);
	} finally { clearTimeout(timer); }
}

async function boundedResponse(response: Response, deadline: number) {
	if (!response.body) throw new Error("Missing native inbox acknowledgement");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await beforeDeadline(reader.read(), deadline);
			if (done) break;
			size += value.byteLength;
			if (size > 16 * 1024) throw new Error("Native inbox acknowledgement exceeds limit");
			chunks.push(value);
		}
	} finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return JSON.parse(new TextDecoder().decode(bytes)) as { data?: { accepted?: boolean; duplicate?: boolean; messageId?: string } };
}

export async function deliverNativeCrmInbox(env: RelayEnv, job: NativeCrmInboxJob, now = Date.now()): Promise<void> {
	const config = configuration(env);
	if (!config) return;
	if (!/^mailflare:[0-9a-f]{64}$/.test(job.deliveryId)) throw new Error("Invalid native CRM inbox delivery identity");
	await env.DB.prepare(`UPDATE native_crm_inbox_deliveries SET status='exhausted',lease_until=NULL,last_error='budget-exhausted'
		WHERE id=? AND status='pending' AND (expires_at<=? OR attempts>=?) AND (lease_until IS NULL OR lease_until<=?)`)
		.bind(job.deliveryId, now, MAX_ATTEMPTS, now).run();
	const row = await env.DB.prepare(`UPDATE native_crm_inbox_deliveries SET attempts=attempts+1,lease_until=?
		WHERE id=? AND status='pending' AND expires_at>? AND attempts<? AND next_attempt_at<=?
		AND (lease_until IS NULL OR lease_until<=?) RETURNING *`)
		.bind(now + LEASE_MS, job.deliveryId, now, MAX_ATTEMPTS, now, now).first<Delivery>();
	if (!row) return;
	let retryable = true;
	let reason = "relay-error";
	try {
		if (row.environment !== config.environment) { retryable = false; throw new Error("environment-changed"); }
		if (!config.recipients.includes(row.to_address)) { retryable = false; throw new Error("recipient-disabled"); }
		if (row.target_origin !== config.origin.origin) { retryable = false; throw new Error("destination-changed"); }
		const archiveDeadline = performance.now() + 15_000;
		const object = await beforeDeadline(env.BUCKET.get(row.raw_r2_key), archiveDeadline);
		if (!object || object.size !== row.raw_size || object.size > MAX_BYTES) { retryable = false; throw new Error("original-unavailable"); }
		const raw = await beforeDeadline(object.arrayBuffer(), archiveDeadline);
		if (await sha256(raw) !== row.raw_sha256) { retryable = false; throw new Error("original-changed"); }
		const timestamp = String(Math.floor(now / 1000));
		const signed = JSON.stringify(["orangecrm:email-relay:v1", row.environment, row.id, row.from_address, row.to_address, row.received_at, timestamp, row.raw_sha256]);
		const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(config.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const signature = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)));
		const url = new URL("/webhooks/email/receiving", config.origin);
		const deadline = performance.now() + 10_000;
		const response = await beforeDeadline(config.binding.fetch(new Request(url, {
			method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
			headers: {
				Host: config.origin.host, "Content-Type": "message/rfc822", "Content-Length": String(raw.byteLength),
				"x-orangecrm-email-id": row.id, "x-orangecrm-email-from": row.from_address, "x-orangecrm-email-to": row.to_address,
				"x-orangecrm-email-received-at": row.received_at, "x-orangecrm-email-timestamp": timestamp,
				"x-orangecrm-email-environment": row.environment, "x-orangecrm-email-sha256": row.raw_sha256, "x-orangecrm-email-signature": signature,
			}, body: raw,
		})), deadline);
		if (response.status !== 202) {
			retryable = response.status === 429 || response.status >= 500;
			reason = `http-${response.status}`;
			void response.body?.cancel().catch(() => {});
			throw new Error(reason);
		}
		const ack = await boundedResponse(response, deadline);
		if (ack.data?.accepted !== true || typeof ack.data.messageId !== "string" || !ack.data.messageId || ack.data.messageId.length > 200) throw new Error("invalid-acknowledgement");
		await env.DB.prepare(`UPDATE native_crm_inbox_deliveries SET status='accepted',lease_until=NULL,crm_message_id=?,last_error=NULL
			WHERE id=? AND status='pending' AND attempts=?`).bind(ack.data.messageId, row.id, row.attempts).run();
		return;
	} catch {
		const exhausted = !retryable || row.attempts >= MAX_ATTEMPTS || now + 60_000 >= row.expires_at;
		const delaySeconds = Math.min(60 * 2 ** (row.attempts - 1), 15 * 60);
		const updated = await env.DB.prepare(`UPDATE native_crm_inbox_deliveries SET status=?,lease_until=NULL,next_attempt_at=?,last_error=?
			WHERE id=? AND status='pending' AND attempts=?`)
			.bind(exhausted ? "exhausted" : "pending", now + delaySeconds * 1000, reason, row.id, row.attempts).run();
		if (!exhausted && updated.meta.changes === 1) await publishNativeCrmInbox(env, row.id, now, delaySeconds);
	}
}

/** Bounded recovery covers queue publish failures and an interrupted delivery without renewing budgets. */
export async function recoverNativeCrmInbox(env: RelayEnv, now = Date.now()): Promise<void> {
	if (!configuration(env)) return;
	await env.DB.prepare(`UPDATE native_crm_inbox_deliveries SET status='exhausted',lease_until=NULL,last_error='budget-exhausted'
		WHERE id IN (SELECT id FROM native_crm_inbox_deliveries WHERE status='pending'
		AND (expires_at<=? OR attempts>=?) AND (lease_until IS NULL OR lease_until<=?) ORDER BY created_at LIMIT 10)`)
		.bind(now, MAX_ATTEMPTS, now).run();
	const due = await env.DB.prepare(`SELECT id FROM native_crm_inbox_deliveries WHERE status='pending' AND expires_at>?
		AND attempts<? AND dispatches<? AND next_attempt_at<=? AND next_dispatch_at<=?
		AND (lease_until IS NULL OR lease_until<=?) ORDER BY created_at LIMIT 10`)
		.bind(now, MAX_ATTEMPTS, MAX_DISPATCHES, now, now, now).all<{ id: string }>();
	for (const row of due.results) await publishNativeCrmInbox(env, row.id, now);
}
