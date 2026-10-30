import { sha256Base64Url } from "../domain/identity"

export type KeeperCommitReceiptVerifier = (payload: Uint8Array) => void

/** Only used by a negotiated keeper join, after authenticating its approved
 * service identity. Freeze the actual offer, never reread a changing board. */
export async function keeperCommitReceiptVerifier(workspaceIds: string[], snapshot: Uint8Array): Promise<KeeperCommitReceiptVerifier> {
  const expectedIds = [...workspaceIds]
  const snapshotHash = await sha256Base64Url(snapshot)
  return payload => {
    if (payload.byteLength > 4096) throw new Error("Invalid keeper commit receipt")
    let receipt: Record<string, unknown> | null
    try { receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as Record<string, unknown> | null }
    catch { throw new Error("Invalid keeper commit receipt") }
    const actualIds = receipt?.workspaceIds
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || Object.keys(receipt).sort().join(",") !== "kind,snapshotHash,version,workspaceIds"
      || receipt.kind !== "keeper-provision-commit" || receipt.version !== 1
      || receipt.snapshotHash !== snapshotHash || !Array.isArray(actualIds)
      || actualIds.length !== expectedIds.length
      || !expectedIds.every((id, index) => actualIds[index] === id)) {
      throw new Error("Invalid keeper commit receipt")
    }
  }
}
