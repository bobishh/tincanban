import type { PublicIdentity } from "../domain/model"
import type { ChatRecord } from "./records"
import { verifyChatRecordSignature } from "./records"

type PrivateProfileIdentity = Pick<PublicIdentity, "personId" | "publicKey">

function parseRecordSnapshot(value: unknown): ChatRecord {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new Error("Invalid chat record", { cause: error })
  }
  if (typeof serialized !== "string") throw new Error("Invalid chat record")
  if (new TextEncoder().encode(serialized).byteLength > 32768) throw new Error("Chat record too large")

  let record: ChatRecord
  try {
    record = JSON.parse(serialized) as ChatRecord
  } catch (error) {
    throw new Error("Invalid chat record", { cause: error })
  }
  return record
}

function snapshotObservation(
  value: unknown,
  identity: PrivateProfileIdentity,
): { record: ChatRecord; workspaceId: string; identity: PrivateProfileIdentity } {
  const record = parseRecordSnapshot(value)
  const expectedIdentity = { personId: identity?.personId, publicKey: identity?.publicKey }
  const workspaceId = record?.signed?.payload?.workspaceId
  if (typeof workspaceId !== "string" || !workspaceId ||
      typeof expectedIdentity.personId !== "string" || !expectedIdentity.personId ||
      typeof expectedIdentity.publicKey !== "string" || !expectedIdentity.publicKey) {
    throw new Error("Invalid private profile observation")
  }
  return { record, workspaceId, identity: expectedIdentity as PrivateProfileIdentity }
}

/** Verifies profile authorship for private observation without granting workspace authority. */
export async function verifyPrivateProfileObservation(
  value: unknown,
  identity: PrivateProfileIdentity,
): Promise<ChatRecord> {
  const snapshot = snapshotObservation(value, identity)
  const verified = await verifyChatRecordSignature(snapshot.record, snapshot.workspaceId)
  const payload = verified.signed.payload
  if (payload.kind !== "chat-profile" || payload.version !== 1 ||
      payload.personId !== snapshot.identity.personId || verified.publicKey !== snapshot.identity.publicKey) {
    throw new Error("Invalid private profile observation")
  }
  return verified
}
