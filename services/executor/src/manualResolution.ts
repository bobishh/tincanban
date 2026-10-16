import type { ExecutionSqlTransactionPort } from "../../../workers/automation/src/executionPorts";

const eventReason = "Handled manually before executor migration";
const maximumBatchSize = 100;

export type ManualMigrationResolution = {
  eventId: string;
  reason: string;
  itemId?: string;
};

export type ManualMigrationResolutionOptions = {
  instructionRef: string;
  hasAuthoredEvent: (eventId: string) => boolean;
  now?: () => number;
};

export type ManualMigrationResolutionResult = {
  eventId: string;
  originalStatus: "pending" | "review";
  duplicate: boolean;
};

type EventRow = {
  source_id: string;
  body_hash: string;
  status: string;
};

type ResolutionRow = {
  source_id: string;
  body_hash: string;
  original_status: "pending" | "review";
  reason: string;
  instruction_ref: string;
  current_item_id: string | null;
};

/** Resolve only explicitly named, still-queued intake events while retaining an audit trail. */
export function resolveMigrationEvents(storage: ExecutionSqlTransactionPort,
  resolutions: readonly ManualMigrationResolution[], options: ManualMigrationResolutionOptions): ManualMigrationResolutionResult[] {
  validateRequest(resolutions, options);
  const now = options.now ?? Date.now;
  return storage.transactionSync(() => {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS manual_event_resolutions (
      event_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      original_status TEXT NOT NULL CHECK (original_status IN ('pending', 'review')),
      reason TEXT NOT NULL,
      instruction_ref TEXT NOT NULL,
      resolved_at INTEGER NOT NULL,
      current_item_id TEXT
    )`);

    const results: ManualMigrationResolutionResult[] = [];
    const observedAt = now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new TypeError("Invalid manual-resolution timestamp");

    for (const resolution of resolutions) {
      if (options.hasAuthoredEvent(resolution.eventId)) {
        throw new Error(`Event ${resolution.eventId} is already authored and cannot be manually resolved`);
      }
      const existingAudit = storage.sql.exec<ResolutionRow>(
        `SELECT source_id, body_hash, original_status, reason, instruction_ref, current_item_id
         FROM manual_event_resolutions WHERE event_id = ?`, resolution.eventId,
      ).toArray()[0];
      const event = storage.sql.exec<EventRow>(
        "SELECT source_id, body_hash, status FROM events WHERE event_id = ?", resolution.eventId,
      ).toArray()[0];
      if (!event) throw new Error(`Migration event ${resolution.eventId} does not exist`);
      if (existingAudit) {
        if (!sameResolution(existingAudit, event, resolution, options.instructionRef)) {
          throw new Error(`Manual resolution for event ${resolution.eventId} conflicts with its recorded resolution`);
        }
        results.push({ eventId: resolution.eventId, originalStatus: existingAudit.original_status, duplicate: true });
        continue;
      }
      if (event.status !== "pending" && event.status !== "review") {
        throw new Error(`Migration event ${resolution.eventId} must be queued or review, not ${event.status}`);
      }
      storage.sql.exec(
        `INSERT INTO manual_event_resolutions
         (event_id, source_id, body_hash, original_status, reason, instruction_ref, resolved_at, current_item_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        resolution.eventId, event.source_id, event.body_hash, event.status,
        resolution.reason, options.instructionRef, observedAt, resolution.itemId ?? null,
      );
      storage.sql.exec(
        `UPDATE events SET status = 'review', claimed_at = NULL, updated_at = ?,
         result = json_set(COALESCE(result, '{}'), '$.reason', ?, '$.retryable', json('false'))
         WHERE event_id = ?`, observedAt, eventReason, resolution.eventId,
      );
      results.push({ eventId: resolution.eventId, originalStatus: event.status, duplicate: false });
    }
    return results;
  });
}

function validateRequest(resolutions: readonly ManualMigrationResolution[], options: ManualMigrationResolutionOptions): void {
  if (!Array.isArray(resolutions) || resolutions.length === 0 || resolutions.length > maximumBatchSize) {
    throw new TypeError(`Manual resolution requires between 1 and ${maximumBatchSize} exact event IDs`);
  }
  if (!options || typeof options.hasAuthoredEvent !== "function") throw new TypeError("Manual resolution requires an authored-event guard");
  if (typeof options.instructionRef !== "string" || options.instructionRef.length < 1 || options.instructionRef.length > 256) {
    throw new TypeError("Manual resolution requires a bounded user-instruction reference");
  }
  const ids = new Set<string>();
  for (const resolution of resolutions) {
    if (!resolution || typeof resolution.eventId !== "string" || resolution.eventId.length < 1 || resolution.eventId.length > 128) {
      throw new TypeError("Manual resolution requires an exact bounded event ID");
    }
    if (ids.has(resolution.eventId)) throw new TypeError(`Duplicate manual-resolution event ID ${resolution.eventId}`);
    ids.add(resolution.eventId);
    if (typeof resolution.reason !== "string" || resolution.reason.trim().length === 0 || resolution.reason.length > 1000) {
      throw new TypeError(`Manual resolution for event ${resolution.eventId} requires a bounded reason`);
    }
    if (resolution.itemId !== undefined && (typeof resolution.itemId !== "string" || resolution.itemId.length < 1 || resolution.itemId.length > 256)) {
      throw new TypeError(`Manual resolution for event ${resolution.eventId} has an invalid current item ID`);
    }
  }
}

function sameResolution(audit: ResolutionRow, event: EventRow, resolution: ManualMigrationResolution, instructionRef: string): boolean {
  return audit.source_id === event.source_id && audit.body_hash === event.body_hash && event.status === "review" &&
    audit.reason === resolution.reason && audit.instruction_ref === instructionRef &&
    audit.current_item_id === (resolution.itemId ?? null);
}
