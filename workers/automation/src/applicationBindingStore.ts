import { z } from "zod";

const recordSchema = z.strictObject({
  bindingId: z.string().uuid(),
  eventId: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/),
  previousBindingId: z.string().uuid().nullable(),
  proofHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  encryptedRecord: z.string().min(1).max(384 * 1024),
  createdAt: z.number().int().positive().refine(Number.isSafeInteger),
});
export type StoredApplicationBinding = z.infer<typeof recordSchema>;
type BindingRow = {
  binding_id: string; event_id: string; previous_binding_id: string | null;
  proof_hash: string; encrypted_record: string; created_at: number;
};

/** Private storage only. The coordinator verifies the signed proof and current authority before append. */
export function initializeApplicationBindingStorage(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS application_bindings (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, binding_id TEXT NOT NULL UNIQUE,
      event_id TEXT NOT NULL, previous_binding_id TEXT, proof_hash TEXT NOT NULL,
      encrypted_record TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS application_bindings_event ON application_bindings(event_id, sequence);
    CREATE TABLE IF NOT EXISTS application_binding_heads (event_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS application_binding_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, binding_id TEXT NOT NULL, event_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('saved', 'applied')), change_hash TEXT,
      created_at INTEGER NOT NULL, UNIQUE(binding_id, kind)
    );
    CREATE TRIGGER IF NOT EXISTS application_bindings_no_update BEFORE UPDATE ON application_bindings
      BEGIN SELECT RAISE(ABORT, 'Application bindings are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS application_bindings_no_delete BEFORE DELETE ON application_bindings
      BEGIN SELECT RAISE(ABORT, 'Application bindings are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS application_binding_audit_no_update BEFORE UPDATE ON application_binding_audit
      BEGIN SELECT RAISE(ABORT, 'Application binding audit is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS application_binding_audit_no_delete BEFORE DELETE ON application_binding_audit
      BEGIN SELECT RAISE(ABORT, 'Application binding audit is immutable'); END;
  `);
}

/** Advance a causal head, retain the original proof ciphertext and audit in one synchronous transaction. */
export async function appendApplicationBinding(storage: DurableObjectStorage,
  input: StoredApplicationBinding): Promise<{ duplicate: boolean }> {
  const value = recordSchema.parse(input);
  if (value.previousBindingId === value.bindingId) throw new Error("Application binding cannot reference itself");
  return storage.transactionSync(() => {
    const existing = storage.sql.exec<BindingRow>("SELECT * FROM application_bindings WHERE binding_id = ?", value.bindingId).toArray()[0];
    if (existing) {
      if (existing.event_id !== value.eventId || existing.previous_binding_id !== value.previousBindingId || existing.proof_hash !== value.proofHash) {
        throw new Error("Application binding ID was already used for different evidence");
      }
      return { duplicate: true };
    }
    const head = readApplicationBinding(storage, value.eventId);
    if ((head?.bindingId ?? null) !== value.previousBindingId) throw new Error("Application binding changed; reload before correcting it");
    storage.sql.exec(`INSERT INTO application_bindings
      (binding_id, event_id, previous_binding_id, proof_hash, encrypted_record, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    value.bindingId, value.eventId, value.previousBindingId, value.proofHash, value.encryptedRecord, value.createdAt);
    storage.sql.exec(`INSERT INTO application_binding_heads (event_id, binding_id) VALUES (?, ?)
      ON CONFLICT(event_id) DO UPDATE SET binding_id = excluded.binding_id`, value.eventId, value.bindingId);
    storage.sql.exec("INSERT INTO application_binding_audit (binding_id, event_id, kind, created_at) VALUES (?, ?, 'saved', ?)",
      value.bindingId, value.eventId, value.createdAt);
    return { duplicate: false };
  });
}

export function readApplicationBinding(storage: DurableObjectStorage, eventId: string): StoredApplicationBinding | null {
  const row = storage.sql.exec<BindingRow>(`SELECT b.* FROM application_binding_heads h
    JOIN application_bindings b ON b.binding_id = h.binding_id AND b.event_id = h.event_id WHERE h.event_id = ?`, eventId).toArray()[0];
  return row ? fromRow(row) : null;
}

export function readApplicationBindingById(storage: DurableObjectStorage, bindingId: string): StoredApplicationBinding | null {
  const row = storage.sql.exec<BindingRow>("SELECT * FROM application_bindings WHERE binding_id = ?", bindingId).toArray()[0];
  return row ? fromRow(row) : null;
}

/** Record the actual signed CRDT change only after the replication receipt has been verified. */
export function appendApplicationBindingAppliedAudit(storage: DurableObjectStorage,
  value: { bindingId: string; eventId: string; changeHash: string; createdAt: number }): void {
  if (!/^[0-9a-f]{64}$/.test(value.changeHash) || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0) {
    throw new Error("Application binding action lacks a valid signed change hash");
  }
  storage.transactionSync(() => {
    if (readApplicationBinding(storage, value.eventId)?.bindingId !== value.bindingId) throw new Error("Application binding action has a stale head");
    const previous = storage.sql.exec<{ change_hash: string }>(
      "SELECT change_hash FROM application_binding_audit WHERE binding_id = ? AND kind = 'applied'", value.bindingId,
    ).toArray()[0];
    if (previous) {
      if (previous.change_hash !== value.changeHash) throw new Error("Application binding was applied as a different change");
      return;
    }
    storage.sql.exec("INSERT INTO application_binding_audit (binding_id, event_id, kind, change_hash, created_at) VALUES (?, ?, 'applied', ?, ?)",
      value.bindingId, value.eventId, value.changeHash, value.createdAt);
  });
}

export function readApplicationBindingHistory(storage: DurableObjectStorage, eventId: string): StoredApplicationBinding[] {
  return storage.sql.exec<BindingRow>("SELECT * FROM application_bindings WHERE event_id = ? ORDER BY sequence", eventId).toArray().map(fromRow);
}

export function readApplicationBindingAudit(storage: DurableObjectStorage, eventId: string):
  Array<{ bindingId: string; eventId: string; kind: "saved" | "applied"; createdAt: number; changeHash?: string }> {
  return storage.sql.exec<{ binding_id: string; event_id: string; kind: "saved" | "applied"; change_hash: string | null; created_at: number }>(
    "SELECT binding_id, event_id, kind, change_hash, created_at FROM application_binding_audit WHERE event_id = ? ORDER BY sequence", eventId,
  ).toArray().map(row => ({ bindingId: row.binding_id, eventId: row.event_id, kind: row.kind, createdAt: row.created_at,
    ...(row.change_hash ? { changeHash: row.change_hash } : {}) }));
}

function fromRow(row: BindingRow): StoredApplicationBinding {
  return recordSchema.parse({ bindingId: row.binding_id, eventId: row.event_id, previousBindingId: row.previous_binding_id,
    proofHash: row.proof_hash, encryptedRecord: row.encrypted_record, createdAt: row.created_at });
}
