import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = join(root, "drizzle/migrations");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-backups-test-"));
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
const previousMigrations = join(bundleDirectory, "previous-migrations");
const partialDriveMigrations = join(bundleDirectory, "partial-drive-migrations");
for (const [directory, cutoff] of [[previousMigrations, "0053"], [partialDriveMigrations, "0056"]]) {
	mkdirSync(join(directory, "meta"), { recursive: true });
	for (const name of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql") && name < cutoff)) {
		copyFileSync(join(migrationsDirectory, name), join(directory, name));
	}
	copyFileSync(join(migrationsDirectory, "meta/_journal.json"), join(directory, "meta/_journal.json"));
}

await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { applyMigrations } from "./server/runtime/migrate.ts";
			export { assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords } from "./src/lib/backups/export.ts";
		`,
		resolveDir: root,
		sourcefile: "backups-migration-test-entry.ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const { SqliteDatabase, applyMigrations, assertBackupTablesCoverDatabase, exportDatabaseRecords, restoreDatabaseRecords } = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
const newTables = ["push_subscriptions", "drive_items", "drive_shares", "drive_upload_parts"];

async function database(t, migrations = migrationsDirectory) {
	const database = new SqliteDatabase(":memory:");
	t.after(() => database.db.close());
	await applyMigrations(database, migrations);
	return database;
}

function seedAccounts(database) {
	database.db.exec(`
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('owner', 'owner@example.com', 'hash', 'Owner', 1);
		INSERT INTO users (id, email, password_hash, name, created_at) VALUES ('reader', 'reader@example.com', 'hash', 'Reader', 1);
		INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('session', 'owner', 'session-hash', 9999999999, 1);
	`);
}

function seedPushAndDrive(database) {
	seedAccounts(database);
	database.db.exec(`
		INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, created_at, updated_at)
		VALUES ('push', 'owner', 'session', 'https://push.example.com/subscription', 'public-key', 'auth-key', 1, 2);
		INSERT INTO drive_items (id, owner_id, kind, name, created_at, updated_at)
		VALUES ('folder', 'owner', 'folder', 'Documents', 1, 2);
		INSERT INTO drive_items (id, owner_id, parent_id, kind, name, r2_key, size, content_type, link_token, upload_id, upload_part_size, upload_fingerprint, created_at, updated_at)
		VALUES ('file', 'owner', 'folder', 'file', 'report.pdf', 'drive/owner/file', 123, 'application/pdf', 'shared-link', 'upload-id', 5242880, 'fingerprint', 1, 2);
		INSERT INTO drive_shares (id, item_id, user_id, role, created_at)
		VALUES ('share', 'file', 'reader', 'view', 1);
		INSERT INTO drive_upload_parts (item_id, part_number, etag) VALUES ('file', 1, 'etag-one');
		INSERT INTO drive_upload_parts (item_id, part_number, etag) VALUES ('file', 2, 'etag-two');
	`);
}

function rows(database, table) {
	return database.db.prepare(`SELECT * FROM ${table} ORDER BY ${table === "drive_upload_parts" ? "item_id, part_number" : "id"}`).all();
}

function encode(document) {
	return new TextEncoder().encode(JSON.stringify(document)).buffer;
}

test("backups export and restore before the new tables are migrated", async (t) => {
	const db = await database(t, previousMigrations);
	seedAccounts(db);
	await assertBackupTablesCoverDatabase(db);
	const backup = await exportDatabaseRecords(db);
	const document = JSON.parse(new TextDecoder().decode(backup));
	for (const table of newTables) assert.deepEqual(document.tables[table], []);
	db.db.prepare("UPDATE users SET name = 'Changed' WHERE id = 'owner'").run();
	await restoreDatabaseRecords(db, backup.buffer);
	assert.equal(db.db.prepare("SELECT name FROM users WHERE id = 'owner'").get().name, "Owner");
	assert.equal(rows(db, "sessions").length, 1);
	assert.deepEqual(db.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("all migrations preserve push subscriptions and Drive data through backup and restore", async (t) => {
	const db = await database(t);
	seedPushAndDrive(db);
	await assertBackupTablesCoverDatabase(db);
	const expected = Object.fromEntries(newTables.map((table) => [table, rows(db, table)]));
	const backup = await exportDatabaseRecords(db);
	db.db.exec("UPDATE drive_shares SET role = 'edit'; UPDATE push_subscriptions SET endpoint = 'https://changed.example.com';");
	await restoreDatabaseRecords(db, backup.buffer);
	for (const table of newTables) assert.deepEqual(rows(db, table), expected[table]);
	assert.deepEqual(db.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("an older full backup without the new tables restores after migration", async (t) => {
	const previous = await database(t, previousMigrations);
	seedAccounts(previous);
	const document = JSON.parse(new TextDecoder().decode(await exportDatabaseRecords(previous)));
	// The previous release's exporter did not list these tables at all.
	for (const table of newTables) delete document.tables[table];
	document.includedTables = document.includedTables.filter((table) => !newTables.includes(table));
	const current = await database(t);
	seedPushAndDrive(current);
	await restoreDatabaseRecords(current, encode(document));
	assert.equal(rows(current, "users").length, 2);
	assert.equal(rows(current, "sessions").length, 1);
	for (const table of newTables) assert.deepEqual(rows(current, table), []);
	assert.deepEqual(current.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("restoring data for an unmigrated table fails before existing records are deleted", async (t) => {
	const current = await database(t);
	seedPushAndDrive(current);
	const backup = await exportDatabaseRecords(current);
	const previous = await database(t, previousMigrations);
	seedAccounts(previous);
	const before = await exportDatabaseRecords(previous);
	await assert.rejects(restoreDatabaseRecords(previous, backup.buffer), /Apply pending database migrations before restoring push subscriptions/);
	const after = await exportDatabaseRecords(previous);
	assert.deepEqual(JSON.parse(new TextDecoder().decode(after)).tables, JSON.parse(new TextDecoder().decode(before)).tables);
});

test("restoring newer Drive columns fails before deleting records after migration 0055", async (t) => {
	const current = await database(t);
	seedPushAndDrive(current);
	// Empty upload parts avoid the missing-table guard and exercise column compatibility.
	current.db.prepare("DELETE FROM drive_upload_parts").run();
	const backup = await exportDatabaseRecords(current);
	const partial = await database(t, partialDriveMigrations);
	seedAccounts(partial);
	partial.db.exec(`
		INSERT INTO drive_items (id, owner_id, kind, name, created_at, updated_at)
		VALUES ('existing-file', 'owner', 'file', 'Existing report', 1, 2);
		INSERT INTO drive_shares (id, item_id, user_id, role, created_at)
		VALUES ('existing-share', 'existing-file', 'reader', 'view', 1);
	`);
	const before = await exportDatabaseRecords(partial);
	await assert.rejects(restoreDatabaseRecords(partial, backup.buffer), /Apply pending database migrations before restoring drive items/);
	const after = await exportDatabaseRecords(partial);
	assert.deepEqual(JSON.parse(new TextDecoder().decode(after)).tables, JSON.parse(new TextDecoder().decode(before)).tables);
	assert.deepEqual(partial.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("coverage still rejects an unlisted persisted table", async (t) => {
	const db = await database(t);
	db.db.exec("CREATE TABLE unlisted_persisted_table (id TEXT PRIMARY KEY)");
	await assert.rejects(exportDatabaseRecords(db), /unlisted_persisted_table not listed in BACKUP_TABLES/);
});
