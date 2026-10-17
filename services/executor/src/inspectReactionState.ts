import { DatabaseSync } from "node:sqlite";
import { decryptParticipantReplicaState } from "../../../workers/automation/src/executionCoordinator";

type StateRow = { encrypted_state: string | null; state_generation: string | null };
type ChunkRow = { chunk_index: number; total_chunks: number; data: string };

async function main(): Promise<void> {
  const integrationId = process.env.REACTION_INTEGRATION_ID;
  const databasePath = process.env.REACTION_STATE_PATH;
  const storageSecret = process.env.EVENT_STORAGE_SECRET;
  if (!integrationId || !/^[A-Za-z0-9_-]{1,128}$/.test(integrationId) || !databasePath || !storageSecret) {
    throw new TypeError("REACTION_INTEGRATION_ID, REACTION_STATE_PATH and EVENT_STORAGE_SECRET are required");
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON");
    const state = database.prepare("SELECT encrypted_state, state_generation FROM automation_replica WHERE singleton = 1").get() as StateRow | undefined;
    if (!state) throw new Error("Participant has no stored replica state");
    let encrypted = state.encrypted_state;
    if (state.state_generation) {
      const chunks = database.prepare("SELECT chunk_index, total_chunks, data FROM automation_replica_chunks WHERE kind = 'state' AND generation = ? ORDER BY chunk_index")
        .all(state.state_generation) as ChunkRow[];
      if (!chunks.length || chunks.some((chunk, index) => chunk.chunk_index !== index || chunk.total_chunks !== chunks.length)) {
        throw new Error("Stored participant state chunks are incomplete");
      }
      encrypted = chunks.map(chunk => chunk.data).join("");
    }
    if (!encrypted) throw new Error("Participant has no encrypted replica state");
    const replica = JSON.parse(await decryptParticipantReplicaState(storageSecret, integrationId, encrypted)) as { blind?: { origin?: unknown } };
    const origin = replica.blind?.origin;
    if (typeof origin !== "string") throw new Error("Stored participant has no Rusty origin");
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error("Stored Rusty origin is invalid");
    const epoch = readEpoch(database);
    const pending = database.prepare("SELECT status, COUNT(*) AS count FROM events WHERE status IN ('pending', 'processing') GROUP BY status")
      .all() as Array<{ status: string; count: number }>;
    const counts = { pending: 0, processing: 0 };
    for (const row of pending) if (row.status === "pending" || row.status === "processing") counts[row.status] = Number(row.count);
    process.stdout.write(`${JSON.stringify({ integrationId, epoch, rustyOrigins: [url.origin], pending: counts })}\n`);
  } finally {
    database.close();
  }
}

function readEpoch(database: DatabaseSync): number | null {
  try {
    const row = database.prepare("SELECT epoch FROM executor_fresh WHERE singleton = 1").get() as { epoch?: unknown } | undefined;
    if (Number.isSafeInteger(row?.epoch) && Number(row.epoch) > 0) return Number(row!.epoch);
  } catch { /* Legacy participants use the migration manifest below. */ }
  try {
    const row = database.prepare("SELECT manifest_json FROM executor_import WHERE singleton = 1").get() as { manifest_json?: unknown } | undefined;
    if (typeof row?.manifest_json === "string") {
      const epoch = (JSON.parse(row.manifest_json) as { epoch?: unknown }).epoch;
      if (Number.isSafeInteger(epoch) && Number(epoch) > 0) return Number(epoch);
    }
  } catch { /* No migration table means no migration epoch is recorded. */ }
  return null;
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "Participant state inventory failed"}\n`);
  process.exitCode = 1;
});
