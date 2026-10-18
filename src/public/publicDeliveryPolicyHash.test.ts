import { expect, it } from "vitest"
import { publicBoardDeliveryPolicyContentHash, publicBoardDeliveryPolicyHash, type PublicBoardDeliveryPolicyEvidence } from "./publicDeliveryPolicy"

it("Given equivalent policy signatures with different bytes, when comparing content, then preserve its meaning while retaining distinct wire hashes", async () => {
  const evidence: PublicBoardDeliveryPolicyEvidence = {
    policy: { payload: { kind: "rusty-public-board-delivery-policy", version: 1, workspaceId: "workspace", boardId: "board",
      generation: 1, accessEpoch: 1, enabled: true, acceptedGrants: [], revokedGrantIds: [], revokedDeviceIds: [] },
    signerKeyId: "owner-device", signature: "first-signature" }, ownerCertificates: [],
  }
  const resigned = structuredClone(evidence)
  resigned.policy.signature = "another-signature"
  expect(await publicBoardDeliveryPolicyContentHash(resigned)).toBe(await publicBoardDeliveryPolicyContentHash(evidence))
  expect(await publicBoardDeliveryPolicyHash(resigned)).not.toBe(await publicBoardDeliveryPolicyHash(evidence))
  resigned.policy.payload.revokedGrantIds.push("revoked-grant")
  expect(await publicBoardDeliveryPolicyContentHash(resigned)).not.toBe(await publicBoardDeliveryPolicyContentHash(evidence))
  resigned.policy.payload.revokedGrantIds = []
  resigned.policy.signerKeyId = "another-device"
  expect(await publicBoardDeliveryPolicyContentHash(resigned)).not.toBe(await publicBoardDeliveryPolicyContentHash(evidence))
})
