import { describe, expect, it } from "vitest"
import { workspaceAuthorityFingerprint } from "./authorityFingerprint"
import type { WorkspaceAuthorityRecord, WorkspaceMeshCredential } from "./peerStore"

const credential = (): WorkspaceMeshCredential => ({
  version: 1, workspaceId: "board-a", ownerPersonId: "owner-a", ownerPublicKey: "key-a",
  transportSecret: "secret-a", epoch: 1, updatedAt: "one", ownerCertificates: [{ id: "cert-a" }],
  localGrant: { personId: "local", role: "editor" }, ownerHistory: [{ personId: "owner-a", publicKey: "key-a", certificates: [] }],
  catalog: { revocations: [], departures: [], deviceRevocations: [], successionPolicy: { quorum: 1 } },
})

const authority = (): WorkspaceAuthorityRecord => ({
  version: 1, workspaceId: "board-a", genesisOwnerPersonId: "owner-a", ownerPersonId: "owner-a",
  ownerPublicKey: "key-a", epoch: 1, updatedAt: "one", ownerCertificates: [{ id: "cert-a" }],
  localGrant: { personId: "local", role: "editor" }, ownerHistory: [{ personId: "owner-a", publicKey: "key-a", certificates: [] }],
  catalog: { revocations: [], departures: [], deviceRevocations: [], successionPolicy: { quorum: 1 } },
  scopeAuthoritySnapshot: { genesis: { id: "genesis" }, grants: [], grantIssuers: [], revocations: [], controlTransfers: [] },
})

function fingerprint(c = credential(), a = authority()) {
  return workspaceAuthorityFingerprint([c], [a])
}

describe("workspace authority fingerprint", () => {
  it("Given identical certificate sets in different orders, When authority refreshes, Then the fingerprint stays equal without mutating stored records", () => {
    const c = credential(), a = authority()
    c.ownerCertificates.push({ id: "cert-b" })
    a.ownerCertificates.push({ id: "cert-b" })
    c.ownerHistory![0]!.certificates = [{ id: "old-a" }, { id: "old-b" }]
    const reversed = structuredClone(c), reversedAuthority = structuredClone(a)
    reversed.ownerCertificates.reverse()
    reversedAuthority.ownerCertificates.reverse()
    reversed.ownerHistory![0]!.certificates.reverse()
    expect(fingerprint(reversed, reversedAuthority)).toBe(fingerprint(c, a))
    expect(reversed.ownerCertificates[0]).toEqual({ id: "cert-b" })
  })

  it("Given duplicate signatures or a changed signed payload, When fingerprinting, Then every distinct security value remains visible", () => {
    const c = credential()
    c.ownerCertificates = [{ signature: "same", payload: { deviceId: "a" } }, { signature: "same", payload: { deviceId: "b" } }]
    const altered = structuredClone(c)
    altered.ownerCertificates.pop()
    expect(fingerprint(altered)).not.toBe(fingerprint(c))
    c.catalog = { signed: { signature: "signature", payload: { certificates: ["a", "b"] } } }
    altered.catalog = { signed: { signature: "signature", payload: { certificates: ["b", "a"] } } }
    altered.ownerCertificates = c.ownerCertificates
    expect(fingerprint(altered)).not.toBe(fingerprint(c))
  })

  it("ignores peer-independent timestamps and transport secrets, and sorts stored records", () => {
    const left = credential()
    const leftAuthority = authority()
    const right = credential()
    const rightAuthority = authority()
    right.updatedAt = "two"
    right.transportSecret = "rotated-transport-secret"
    rightAuthority.updatedAt = "two"
    expect(workspaceAuthorityFingerprint([left], [leftAuthority]))
      .toBe(workspaceAuthorityFingerprint([right], [rightAuthority]))
    expect(workspaceAuthorityFingerprint([left, { ...left, workspaceId: "board-b" }], [leftAuthority]))
      .toBe(workspaceAuthorityFingerprint([{ ...left, workspaceId: "board-b" }, left], [leftAuthority]))
  })

  it.each([
    ["owner", (c: WorkspaceMeshCredential) => { c.ownerPersonId = "owner-b" }],
    ["local grant", (c: WorkspaceMeshCredential) => { c.localGrant = { personId: "local", role: "visitor" } }],
    ["owner certificates", (c: WorkspaceMeshCredential) => { c.ownerCertificates.push({ id: "cert-b" }) }],
    ["owner history", (c: WorkspaceMeshCredential) => { c.ownerHistory?.push({ personId: "owner-b", publicKey: "key-b", certificates: [] }) }],
    ["revocation", (c: WorkspaceMeshCredential) => { (c.catalog as { revocations: unknown[] }).revocations.push({ personId: "former" }) }],
    ["departure", (c: WorkspaceMeshCredential) => { (c.catalog as { departures: unknown[] }).departures.push({ personId: "former" }) }],
    ["device revocation", (c: WorkspaceMeshCredential) => { (c.catalog as { deviceRevocations: unknown[] }).deviceRevocations.push({ deviceId: "old-device" }) }],
    ["succession", (c: WorkspaceMeshCredential) => { (c.catalog as { successionPolicy: unknown }).successionPolicy = { quorum: 2 } }],
  ])("changes when %s changes", (_label, mutate) => {
    const changed = credential()
    mutate(changed)
    expect(fingerprint(changed)).not.toBe(fingerprint())
  })

  it("tracks stored-ledger changes and conflicts with the credential", () => {
    const changed = authority()
    changed.scopeAuthoritySnapshot!.grants.push({ personId: "local", role: "editor" })
    expect(fingerprint(credential(), changed)).not.toBe(fingerprint())
    const conflict = authority()
    conflict.ownerPersonId = "conflicting-owner"
    expect(fingerprint(credential(), conflict)).not.toBe(fingerprint())
  })
})
