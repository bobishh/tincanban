import { expect, it, vi } from "vitest"
import { projectIdentityReplicaCatalogOnly } from "./identityReplicaStore"
import { readIdentityDeviceTransfer } from "./identityDeviceTransfer"

vi.mock("./identityDeviceTransfer", () => ({ readIdentityDeviceTransfer: vi.fn() }))

it("Given an authenticated Identity device manifest, when projecting ordinary catalog sync, then omit only recovery evidence and revalidate", async () => {
  const manifest = { components: { recoveryEvidence: { schema: "identity-recovery-evidence@1", required: true,
    value: { personId: "person-1", envelopes: [{ ciphertext: "private-recovery-envelope" }] } },
    identityCatalog: { value: { identity: "kept" } }, identityAuthority: { value: { authorityView: "kept" } } } }
  const transfer = { manifest } as never
  vi.mocked(readIdentityDeviceTransfer).mockResolvedValue({ manifest: {} } as never)
  await projectIdentityReplicaCatalogOnly(transfer, "person-1")
  const projected = vi.mocked(readIdentityDeviceTransfer).mock.calls[0]![0] as typeof manifest
  expect(projected.components.recoveryEvidence.value).toEqual({ personId: "person-1", envelopes: [] })
  expect(projected.components.identityCatalog.value).toEqual({ identity: "kept" })
  expect(projected.components.identityAuthority.value).toEqual({ authorityView: "kept" })
  expect(manifest.components.recoveryEvidence.value.envelopes).toHaveLength(1)
})
