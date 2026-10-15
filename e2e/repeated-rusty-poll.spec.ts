import { expect, test } from "./support/coverage"
import { populatedBoard } from "./support/detailedBoard"

test("Given a detailed board already uploaded to Rusty, When unchanged polls repeat around an archived card, chat message and failed delivery, Then idle polls avoid historical exports and changed data is still uploaded", async ({ page }) => {
  test.setTimeout(120_000)
  await populatedBoard(page, true)
  const result = await page.evaluate(async () => {
    const app = (await import("/src/state.ts")).useTincanban()
    await app.reclassifyWorkspace(app.activeWorkspace.id)
    const { BlindReplica } = await import("/src/sync/blindReplication.ts")
    const { createBlindSnapshotRevision } = await import("/src/sync/blindSnapshotRevision.ts")
    const { exportAuthorizationBundle } = await import("/src/sync/changeAuthorization.ts")
    const { exportChat, sendChatMessage } = await import("/src/chat/service.ts")
    await exportChat(app.activeWorkspace.id)
    const { encodeBlindBytes } = await import("/src/sync/blindEnvelope.ts")
    const { blindHash, blindObjectId, canonicalBlindJson } = await import("/src/sync/blindClient.ts")
    const signer = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", signer.publicKey))
    const serviceId = await blindHash(publicKey)
    const receipts = new Map<string, import("/src/sync/blindClient.ts").BlindReceipt>()
    let reads = 0, proofs = 0, uploads = 0, fail = false
    let failedRequest: { requestId: string; object: string } | undefined
    let exactRetry = false
    const config = { origin: "http://localhost:8080", scopeId: "idle-proof", servicePublicKey: encodeBlindBytes(publicKey),
      readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1,
      contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), workspaceId: app.activeWorkspace.id,
      cursor: 0, lastUploaded: "" }
    const replica = new BlindReplica(config, {
      read: async id => { reads++; return app.readWorkspaceBytes(id) },
      authorization: async bytes => { proofs++; return exportAuthorizationBundle(bytes, app.getCurrentProfile()!) },
      readSnapshotRevision: createBlindSnapshotRevision(app),
      readChat: async id => ({ ...await exportChat(id), typing: [] }), merge: async () => {}, mergeChat: async () => {}, persist: async () => {},
    }, { inventory: async () => ({ objects: [], cursor: 0, hasMore: false }), download: async () => { throw new Error("Unexpected download") },
      upload: async (access, object, requestId) => {
        uploads++
        if (fail) {
          failedRequest = { requestId, object: canonicalBlindJson(object) }
          throw new Error("Delivery unavailable")
        }
        if (failedRequest) {
          exactRetry = failedRequest.requestId === requestId && failedRequest.object === canonicalBlindJson(object)
          failedRequest = undefined
        }
        const cached = receipts.get(requestId)
        if (cached) return cached
        const payload = { kind: "blind-storage-receipt" as const, version: 2 as const, serviceId,
          scopeId: access.scopeId, keyEpoch: object.keyEpoch, objectId: await blindObjectId(object),
          sequence: receipts.size + 1, policyRevision: access.policyRevision, requestId }
        const signature = await crypto.subtle.sign("Ed25519", signer.privateKey,
          new TextEncoder().encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`))
        const receipt = { payload, signerKeyId: serviceId, signature: encodeBlindBytes(new Uint8Array(signature)) }
        receipts.set(requestId, receipt)
        return receipt
      } })
    await replica.push()
    for (let index = 0; index < 4; index++) await replica.push()
    const idle = { reads, proofs, uploads }
    await app.executeCommandAsync({ kind: "setEntityArchived", entityId: "performance-card-0", archived: true })
    fail = true
    let rejected = ""
    try { await replica.push() } catch (error) { rejected = error instanceof Error ? error.message : String(error) }
    fail = false
    await replica.push()
    const afterRetry = { reads, proofs, uploads }
    await replica.push()
    const idleAfterRetry = { reads, proofs, uploads }
    await sendChatMessage(config.workspaceId, "A new message must reach Rusty")
    await replica.push()
    const afterChat = { reads, proofs, uploads }
    await replica.push()
    return { idle, rejected, exactRetry, afterRetry, idleAfterRetry, afterChat, final: { reads, proofs, uploads } }
  })
  expect(result.idle).toEqual({ reads: 1, proofs: 1, uploads: 1 })
  expect(result.rejected).toBe("Delivery unavailable")
  expect(result.exactRetry).toBe(true)
  expect(result.afterRetry).toEqual({ reads: 2, proofs: 2, uploads: 3 })
  expect(result.idleAfterRetry).toEqual(result.afterRetry)
  expect(result.afterChat).toEqual({ reads: 3, proofs: 3, uploads: 4 })
  expect(result.final).toEqual(result.afterChat)
  await page.reload()
  await page.getByRole("region", { name: "Archive", exact: true }).getByRole("button", { name: "Open Archive with 1 cards", exact: true }).click()
  await expect(page.getByRole("button", { name: "Open Performance card 0", exact: true })).toBeVisible()
})
