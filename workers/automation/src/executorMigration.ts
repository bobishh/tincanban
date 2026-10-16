import { canonicalizeJson, fromBase64Url, sha256Base64Url, toBase64Url } from "../../../src/domain/identityCrypto";
import type { ExecutionSqlTransactionPort, ExecutionStoragePort } from "./executionPorts";

export const migratedTables = [
  "automation_registration", "consumed_challenges", "automation_identities", "automation_replica",
  "automation_replica_chunks", "automation_storage_transition", "automation_storage_transition_completed",
  "automation_history_transition", "automation_history_transition_completed", "events",
  "application_bindings", "application_binding_heads", "application_binding_audit",
  "application_review_requests", "automation_instance_requests",
] as const;
export type MigratedTable = typeof migratedTables[number];
type MigrationRow = Record<string, string | number | null>;
type PageDescription = { offset: number; count: number; hash: string };
export type MigrationManifest = {
  version: 1; integrationId: string; origin: string; epoch: number; alarmAt: number | null;
  tables: Array<{ name: MigratedTable; columns: string[]; rows: number; pages: PageDescription[] }>;
};
export type MigrationPage = { table: MigratedTable; offset: number; rows: MigrationRow[] };
const maximumPageBytes = 4 * 1024 * 1024;

/** Called only after the old writer's serialized lane is durably fenced. Pages never load CRDT. */
export async function captureMigrationManifest(storage: ExecutionStoragePort, integrationId: string, origin: string, epoch: number): Promise<MigrationManifest> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(integrationId) || !Number.isSafeInteger(epoch) || epoch < 1 || new URL(origin).origin !== origin || !origin.startsWith("https://")) {
    throw new TypeError("Invalid executor migration binding");
  }
  const tables: MigrationManifest["tables"] = [];
  for (const name of migratedTables) {
    const columns = storage.sql.exec<{ name: string }>(`PRAGMA table_info(${name})`).toArray().map(row => row.name);
    if (!columns.length) throw new Error(`Migration source table missing: ${name}`);
    const rows = storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${name}`).one().count;
    if (rows > 100_000) throw new Error("Migration source exceeds the supported row bound");
    const pages: PageDescription[] = [];
    // One row per page bounds large encrypted replica chunks without materializing the complete state.
    for (let offset = 0; offset < rows; offset += 1) {
      const page = { table: name, offset, rows: storage.sql.exec<MigrationRow>(`SELECT * FROM ${name} ORDER BY rowid LIMIT 1 OFFSET ?`, offset).toArray() };
      const bytes = pageBytes(page);
      pages.push({ offset, count: page.rows.length, hash: await sha256Base64Url(bytes) });
    }
    tables.push({ name, columns, rows, pages });
  }
  return { version: 1, integrationId, origin, epoch, alarmAt: await storage.getAlarm(), tables };
}

export async function readMigrationPage(storage: ExecutionSqlTransactionPort, manifest: MigrationManifest, table: string, offset: number): Promise<MigrationPage> {
  const described = manifest.tables.find(value => value.name === table), expected = described?.pages.find(value => value.offset === offset);
  if (!described || !expected) throw new TypeError("Unknown migration page");
  const value = { table: described.name, offset, rows: storage.sql.exec<MigrationRow>(`SELECT * FROM ${described.name} ORDER BY rowid LIMIT 1 OFFSET ?`, offset).toArray() };
  if (await sha256Base64Url(pageBytes(value)) !== expected.hash) throw new Error("Frozen migration source changed");
  return value;
}

export async function sealMigrationPage(secret: string, manifest: MigrationManifest, page: MigrationPage): Promise<{ nonce: string; ciphertext: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: binding(manifest, page.table, page.offset) }, await migrationKey(secret), pageBytes(page));
  return { nonce: toBase64Url(nonce), ciphertext: toBase64Url(new Uint8Array(ciphertext)) };
}

export async function openMigrationPage(secret: string, manifest: MigrationManifest, table: string, offset: number, sealed: { nonce: string; ciphertext: string }): Promise<MigrationPage> {
  if (!manifest.tables.some(value => value.name === table && value.pages.some(page => page.offset === offset)) ||
      typeof sealed?.nonce !== "string" || typeof sealed.ciphertext !== "string" || sealed.ciphertext.length > maximumPageBytes * 1.4 + 100) throw new TypeError("Invalid encrypted migration page");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(sealed.nonce), additionalData: binding(manifest, table, offset) },
    await migrationKey(secret), fromBase64Url(sealed.ciphertext));
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as MigrationPage;
  if (value.table !== table || value.offset !== offset) throw new Error("Migration page binding mismatch");
  return value;
}

export function parseMigrationManifest(value: unknown, integrationId: string, origin: string): MigrationManifest {
  const parsed = value as MigrationManifest;
  if (!parsed || parsed.version !== 1 || parsed.integrationId !== integrationId || parsed.origin !== origin ||
      !Number.isSafeInteger(parsed.epoch) || parsed.epoch < 1 || !(parsed.alarmAt === null || Number.isSafeInteger(parsed.alarmAt)) ||
      !Array.isArray(parsed.tables) || parsed.tables.length !== migratedTables.length) throw new TypeError("Invalid migration manifest");
  for (const [index, table] of parsed.tables.entries()) {
    if (table.name !== migratedTables[index] || !Array.isArray(table.columns) || !table.columns.length || table.columns.length > 32 ||
      table.columns.some(name => !/^[a-z_]+$/.test(name)) || new Set(table.columns).size !== table.columns.length ||
      !Number.isSafeInteger(table.rows) || table.rows < 0 || table.rows > 100_000 || !Array.isArray(table.pages) || table.pages.length !== table.rows ||
      table.pages.some((page, offset) => page.offset !== offset || page.count !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(page.hash))) throw new TypeError("Invalid migration table manifest");
  }
  if (new TextEncoder().encode(canonicalizeJson(parsed)).byteLength > 2 * 1024 * 1024) throw new TypeError("Migration manifest exceeds its bound");
  return parsed;
}

export async function initializeImport(storage: ExecutionSqlTransactionPort, manifest: MigrationManifest): Promise<void> {
  initializeImportTables(storage);
  const hash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(manifest)));
  storage.transactionSync(() => {
    const existing = storage.sql.exec<{ manifest_hash: string }>("SELECT manifest_hash FROM executor_import WHERE singleton = 1").toArray()[0];
    if (existing) { if (existing.manifest_hash !== hash) throw new Error("Another migration already owns this executor journal"); return; }
    for (const table of manifest.tables) {
      const columns = storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table.name})`).toArray().map(row => row.name);
      if (table.columns.some(name => !columns.includes(name))) throw new Error("Executor journal cannot read source schema");
      if (storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table.name}`).one().count) throw new Error("Migration target already contains participant state");
    }
    storage.sql.exec("INSERT INTO executor_import(singleton, manifest_hash, manifest_json, active) VALUES (1, ?, ?, 0)", hash, canonicalizeJson(manifest));
  });
}

export async function importMigrationPage(storage: ExecutionSqlTransactionPort, manifest: MigrationManifest, page: MigrationPage): Promise<void> {
  const table = manifest.tables.find(value => value.name === page.table), expected = table?.pages.find(value => value.offset === page.offset);
  if (!table || !expected || !Array.isArray(page.rows) || page.rows.length !== expected.count || await sha256Base64Url(pageBytes(page)) !== expected.hash) throw new Error("Migration page digest mismatch");
  for (const row of page.rows) if (Object.keys(row).length !== table.columns.length || table.columns.some(name => !Object.hasOwn(row, name)) ||
      Object.values(row).some(value => value !== null && typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value)))) throw new TypeError("Invalid migration row");
  storage.transactionSync(() => {
    const current = storage.sql.exec<{ active: number; manifest_json: string }>("SELECT active, manifest_json FROM executor_import WHERE singleton = 1").one();
    if (current.manifest_json !== canonicalizeJson(manifest)) throw new Error("Migration manifest changed");
    const prior = storage.sql.exec<{ hash: string }>("SELECT hash FROM executor_import_pages WHERE table_name = ? AND page_offset = ?", table.name, page.offset).toArray()[0];
    if (prior) { if (prior.hash !== expected.hash) throw new Error("Migration page changed"); return; }
    if (current.active) throw new Error("Cannot import into an active executor");
    for (const row of page.rows) storage.sql.exec(`INSERT INTO ${table.name} (${table.columns.join(",")}) VALUES (${table.columns.map(() => "?").join(",")})`, ...table.columns.map(name => row[name]!));
    storage.sql.exec("INSERT INTO executor_import_pages(table_name, page_offset, hash) VALUES (?, ?, ?)", table.name, page.offset, expected.hash);
  });
}

export async function verifyCompleteImport(storage: ExecutionStoragePort, manifest: MigrationManifest): Promise<void> {
  for (const table of manifest.tables) {
    if (storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table.name}`).one().count !== table.rows) throw new Error("Migration import is incomplete");
    for (const page of table.pages) {
      const receipt = storage.sql.exec<{ hash: string }>("SELECT hash FROM executor_import_pages WHERE table_name = ? AND page_offset = ?", table.name, page.offset).toArray()[0];
      if (receipt?.hash !== page.hash) throw new Error("Migration import is incomplete");
      await readMigrationPage(storage, manifest, table.name, page.offset);
    }
  }
  if (manifest.alarmAt !== null) await storage.setAlarm(manifest.alarmAt);
}

export function initializeImportTables(storage: ExecutionSqlTransactionPort): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS executor_import (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), manifest_hash TEXT NOT NULL, manifest_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0
  ); CREATE TABLE IF NOT EXISTS executor_import_pages (
    table_name TEXT NOT NULL, page_offset INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(table_name, page_offset)
  );`);
}

function pageBytes(page: MigrationPage): Uint8Array {
  const bytes = new TextEncoder().encode(canonicalizeJson(page));
  if (bytes.byteLength > maximumPageBytes) throw new Error("Migration row exceeds the bounded page size");
  return bytes;
}
function binding(manifest: MigrationManifest, table: string, offset: number): Uint8Array {
  return new TextEncoder().encode(`TIN/executor-migration/v1/${manifest.origin}/${manifest.integrationId}/${manifest.epoch}/${table}/${offset}`);
}
async function migrationKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || new TextEncoder().encode(secret).byteLength < 32) throw new Error("Executor migration secret is not configured");
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`TIN/executor-migration-key/v1/${secret}`)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
