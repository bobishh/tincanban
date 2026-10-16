import { canonicalizeJson, sha256Base64Url } from "../../../src/domain/identityCrypto";
import { migratedTables } from "./executorMigration";
import type { ExecutionSqlTransactionPort } from "./executionPorts";

export type ExecutorFreshBinding = {
  integrationId: string;
  ownerPersonId: string;
  workspaceId: string;
  origin: string;
  epoch: number;
};

export type ExecutorFreshReservation = { binding: ExecutorFreshBinding; hash: string };

const bindingColumns = ["singleton", "integration_id", "owner_person_id", "workspace_id", "origin", "epoch", "binding_hash", "binding_json"];

/** Validate the server-bound owner/workspace and executor route before either side reserves it. */
export function validateExecutorFreshBinding(value: unknown, expected?: { integrationId?: string; origin?: string }): ExecutorFreshBinding {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["epoch", "integrationId", "origin", "ownerPersonId", "workspaceId"].sort().join("\0") ||
    !isIdentifier(value.integrationId) || !isIdentifier(value.ownerPersonId) || !isIdentifier(value.workspaceId) ||
    typeof value.origin !== "string" || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1) {
    throw new TypeError("Executor fresh binding is invalid");
  }
  const origin = parseExecutorOrigin(value.origin);
  if (expected?.integrationId !== undefined && expected.integrationId !== value.integrationId) throw new TypeError("Executor fresh integration binding does not match");
  if (expected?.origin !== undefined && parseExecutorOrigin(expected.origin) !== origin) throw new TypeError("Executor fresh origin binding does not match");
  return { integrationId: value.integrationId, ownerPersonId: value.ownerPersonId, workspaceId: value.workspaceId,
    origin, epoch: value.epoch as number };
}

/** Stable canonical binding used by both Cloudflare and Node reservations. */
export async function freshBindingHash(value: ExecutorFreshBinding): Promise<string> {
  const binding = validateExecutorFreshBinding(value);
  return sha256Base64Url(new TextEncoder().encode(canonicalizeJson(binding)));
}

/** Reserve Node's fresh participant journal before its first identity write. */
export async function reserveNodeFreshBinding(storage: ExecutionSqlTransactionPort, value: ExecutorFreshBinding): Promise<ExecutorFreshReservation> {
  return reserveFreshBinding(storage, "executor_fresh", value, "node");
}

/** Reserve CF's routing record only when this Durable Object has no legacy participant state. */
export async function reserveCloudflareFreshRoute(storage: ExecutionSqlTransactionPort, value: ExecutorFreshBinding): Promise<ExecutorFreshReservation> {
  return reserveFreshBinding(storage, "executor_fresh_route", value, "cloudflare");
}

export async function readNodeFreshBinding(storage: ExecutionSqlTransactionPort): Promise<ExecutorFreshBinding | null> {
  return readFreshBinding(storage, "executor_fresh");
}

export async function readCloudflareFreshRoute(storage: ExecutionSqlTransactionPort): Promise<ExecutorFreshBinding | null> {
  return readFreshBinding(storage, "executor_fresh_route");
}

async function reserveFreshBinding(storage: ExecutionSqlTransactionPort, table: "executor_fresh" | "executor_fresh_route",
  value: ExecutorFreshBinding, owner: "node" | "cloudflare"): Promise<ExecutorFreshReservation> {
  const binding = validateExecutorFreshBinding(value);
  const bindingJson = canonicalizeJson(binding);
  const hash = await freshBindingHash(binding);
  ensureFreshTable(storage, table);
  return storage.transactionSync(() => {
    if (owner === "cloudflare" && tableHasRows(storage, "executor_migration")) {
      throw new Error("Executor migration already owns this Durable Object");
    }
    if (owner === "node" && tableHasRows(storage, "executor_import")) {
      throw new Error("Executor migration import already owns this participant");
    }
    const existing = storage.sql.exec<{ binding_hash: string; binding_json: string }>(
      `SELECT binding_hash, binding_json FROM ${table} WHERE singleton = 1`,
    ).toArray()[0];
    if (existing) {
      if (existing.binding_hash !== hash || existing.binding_json !== bindingJson) throw new Error("Executor fresh binding conflicts with its reservation");
      return { binding, hash };
    }
    assertNoLegacyRows(storage);
    storage.sql.exec(`INSERT INTO ${table} (singleton, integration_id, owner_person_id, workspace_id, origin, epoch, binding_hash, binding_json)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)`, binding.integrationId, binding.ownerPersonId, binding.workspaceId, binding.origin, binding.epoch, hash, bindingJson);
    return { binding, hash };
  });
}

async function readFreshBinding(storage: ExecutionSqlTransactionPort, table: "executor_fresh" | "executor_fresh_route"): Promise<ExecutorFreshBinding | null> {
  ensureFreshTable(storage, table);
  const row = storage.sql.exec<{ integration_id: string; owner_person_id: string; workspace_id: string; origin: string; epoch: number;
    binding_hash: string; binding_json: string }>(`SELECT integration_id, owner_person_id, workspace_id, origin, epoch, binding_hash, binding_json FROM ${table} WHERE singleton = 1`).toArray()[0];
  if (!row) return null;
  const binding = validateExecutorFreshBinding(JSON.parse(row.binding_json), { integrationId: row.integration_id, origin: row.origin });
  const expectedJson = canonicalizeJson(binding);
  if (row.binding_json !== expectedJson || row.owner_person_id !== binding.ownerPersonId || row.workspace_id !== binding.workspaceId ||
    row.epoch !== binding.epoch || row.binding_hash !== await freshBindingHash(binding)) throw new Error("Executor fresh reservation is corrupt");
  return binding;
}

function ensureFreshTable(storage: ExecutionSqlTransactionPort, table: "executor_fresh" | "executor_fresh_route"): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), integration_id TEXT NOT NULL, owner_person_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL, origin TEXT NOT NULL, epoch INTEGER NOT NULL, binding_hash TEXT NOT NULL, binding_json TEXT NOT NULL
  )`);
  const columns = storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map(column => column.name);
  if (columns.length !== bindingColumns.length || bindingColumns.some(column => !columns.includes(column))) {
    throw new Error("Executor fresh reservation table schema is invalid");
  }
}

function assertNoLegacyRows(storage: ExecutionSqlTransactionPort): void {
  if (hasExecutorLegacyRows(storage)) throw new Error("Legacy participant state requires migration before fresh enrollment");
}

/** SQL-only discovery fence for empty instances; never reads replica or CRDT contents. */
export function hasExecutorLegacyRows(storage: ExecutionSqlTransactionPort): boolean {
  return migratedTables.some(table => tableHasRows(storage, table));
}

function tableHasRows(storage: ExecutionSqlTransactionPort, table: string): boolean {
  if (!/^[a-z_]+$/.test(table)) throw new TypeError("Unexpected participant table name");
  if (!storage.sql.exec<{ present: number }>("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length) return false;
  return storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count > 0;
}

function parseExecutorOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("Executor origin is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== value) {
    throw new TypeError("Executor origin must be a canonical HTTPS origin");
  }
  return url.origin;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
