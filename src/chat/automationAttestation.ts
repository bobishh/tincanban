import { WasmStateCore } from "@meta-uber/mesh-transport/wasm"
import type { WorkspaceAuthority } from "../sync/meshRecords"
import type { ChatAuthority, ChatRecord } from "./records"

export function verifyAutomationChatAttestation(record: ChatRecord, grant: NonNullable<ChatAuthority["grant"]>, owner: WorkspaceAuthority) {
  const { signed, automationOperation } = record
  try {
    if (signed.payload.kind !== "chat-message" || !automationOperation) throw new Error()
    WasmStateCore.verifyAutomationOperationEvidence(grant, automationOperation,
      { kind: "chat-message", signature: signed.signature }, signed.payload.deviceId, owner)
  } catch { throw new Error("Invalid automation chat attestation") }
}
