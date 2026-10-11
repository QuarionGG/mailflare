import { resolve } from "node:path";
import ts from "typescript";

/** Encrypted Build input contains relay settings only; never credentials or a full installation snapshot. */
export function renderDeploymentProfile(input, baseText, rootDirectory) {
	if (typeof input !== "string" || Buffer.byteLength(input) > 16 * 1024) throw new Error("Invalid deployment profile size");
	let profile;
	try { profile = JSON.parse(input); } catch { throw new Error("Invalid deployment profile JSON"); }
	const keys = ["expectedWorker", "environment", "enabled", "service", "origin", "recipients"];
	if (!profile || Array.isArray(profile) || typeof profile !== "object" || Object.keys(profile).some(key => !keys.includes(key))
		|| typeof profile.expectedWorker !== "string" || !/^[a-z0-9-]{1,63}$/.test(profile.expectedWorker)
		|| !["staging", "production"].includes(profile.environment) || typeof profile.enabled !== "boolean"
		|| typeof profile.service !== "string" || !/^[a-z0-9-]{1,63}$/.test(profile.service)
		|| !Array.isArray(profile.recipients) || profile.recipients.length < 1 || profile.recipients.length > 4) {
		throw new Error("Invalid relay deployment profile fields");
	}
	const isStage = value => value.split(/[.-]/).includes("staging");
	if (isStage(profile.expectedWorker) !== (profile.environment === "staging") || isStage(profile.service) !== (profile.environment === "staging")) throw new Error("Deployment target must match its environment");
	let origin;
	try { origin = new URL(profile.origin); } catch { throw new Error("Invalid relay origin"); }
	if (origin.protocol !== "https:" || origin.username || origin.password || origin.port || origin.pathname !== "/" || origin.search || origin.hash
		|| origin.hostname === "localhost" || /^\d+(?:\.\d+){3}$/.test(origin.hostname) || origin.hostname.includes(":")
		|| isStage(origin.hostname) !== (profile.environment === "staging")) throw new Error("Relay origin must match its environment");
	const email = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/;
	if (profile.recipients.some(value => typeof value !== "string" || !email.test(value) || value.includes("*") || isStage(value.split("@")[1]) !== (profile.environment === "staging"))
		|| new Set(profile.recipients).size !== profile.recipients.length) throw new Error("Invalid exact relay recipients");
	const parsed = ts.parseConfigFileTextToJson("wrangler.jsonc", baseText);
	if (parsed.error || !parsed.config || parsed.config.name !== profile.expectedWorker || parsed.config.keep_vars !== true) throw new Error("Deployment profile does not match the existing Worker configuration");
	const config = structuredClone(parsed.config);
	const services = config.services ?? [];
	if (!Array.isArray(services) || services.some(value => value.binding === "CRM_INBOX")) throw new Error("Relay service binding must be added exactly once");
	config.services = [...services, { binding: "CRM_INBOX", service: profile.service }];
	config.vars = { ...config.vars, MAILFLARE_ENVIRONMENT: profile.environment, CRM_INBOX_RELAY_ENABLED: String(profile.enabled),
		CRM_INBOX_ORIGIN: origin.origin, CRM_INBOX_RECIPIENTS: profile.recipients.join(";") };
	// The ignored file has its own directory; preserve upstream path meanings.
	config.main = resolve(rootDirectory, config.main);
	if (config.assets?.directory) config.assets.directory = resolve(rootDirectory, config.assets.directory);
	if (config.tsconfig) config.tsconfig = resolve(rootDirectory, config.tsconfig);
	for (const database of config.d1_databases ?? []) if (database.migrations_dir) database.migrations_dir = resolve(rootDirectory, database.migrations_dir);
	return config;
}
