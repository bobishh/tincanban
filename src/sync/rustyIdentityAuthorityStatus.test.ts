import { beforeEach, expect, it, vi } from "vitest"
import { createDelegatedCertificate, createDeviceRevocation, createIdentityAuthorityView,
  emptyIdentityProfileState, verifyIdentityDeviceAuthority, type IdentityAuthorityView } from "@meta-uber/mesh-identity"
import { bootstrapIdentity, canonicalizeJson, publicKeyId, resetIdentityStorageForTest,
  sha256Base64Url, signEnvelope, toBase64Url, type LocalProfile } from "../domain/identity"
import { certHashDefault } from "../domain/proofs"
import { mergeIdentityAuthorityView, requireIdentityAuthorityView } from "./identityAuthorityStore"
import { ensureRustyIdentityAuthorityPublished } from "./rustyIdentityTransport"

beforeEach(resetIdentityStorageForTest)

async function fixture() {
  const owner = await bootstrapIdentity("Authority reconciliation owner")
  const certificates = [owner.certificate]
  for (let index = 0; index < 2; index++) {
    const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
    const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)))
    certificates.push(await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
      owner.identity.personId, await publicKeyId(publicKey), publicKey, await certHashDefault(owner.certificate)))
  }
  const profile = emptyIdentityProfileState(owner.identity.personId)
  const authority = await verifyIdentityDeviceAuthority(owner.identity, { certificates, revocations: [] })
  const base = await createIdentityAuthorityView(owner.identity, { certificates, revocations: [] }, profile)
  const branches = await Promise.all(certificates.slice(1).map(async certificate => createIdentityAuthorityView(owner.identity,
    { certificates, revocations: [await createDeviceRevocation(owner, authority, certificate.payload.deviceId, profile)] }, profile)))
  return { owner, base, branches }
}

function statusService(owner: LocalProfile, initial: IdentityAuthorityView) {
  let remote = initial
  const writes: IdentityAuthorityView[] = []
  const fetcher = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input), serviceId = owner.identity.personId
    const common = { version: 1, origin: url.origin, serviceId, personId: owner.identity.personId,
      enforcement: { mode: "strict", epoch: 1 } }
    if (init.method === "GET") {
      const path = `${url.pathname}${url.search}`
      const status = await signEnvelope(owner.privateKeys.identityPrivateKey!, { ...common,
        kind: "rusty-identity-authority-status", state: "ready", requestNonce: url.searchParams.get("nonce"),
        requestHash: await sha256Base64Url(new TextEncoder().encode(canonicalizeJson({ method: "GET", path }))),
        issuedAt: Date.now(), view: remote }, serviceId, "RUSTY/2")
      return new Response(JSON.stringify({ status }))
    }
    const request = JSON.parse(String(init.body)) as { view: IdentityAuthorityView; authorization: { payload: { requestHash: string } } }
    writes.push(request.view)
    remote = request.view
    const receipt = await signEnvelope(owner.privateKeys.identityPrivateKey!, { ...common,
      kind: "rusty-identity-authority-receipt", authorityHead: remote.revocationHead, viewDigest: remote.viewDigest,
      requestHash: request.authorization.payload.requestHash, committedAt: Date.now() }, serviceId, "RUSTY/2")
    return new Response(JSON.stringify({ receipt }))
  })
  return { fetcher, writes }
}

it.each(["local", "remote", "fork"] as const)("Given %s authority is ahead or divergent, when reading signed Rusty status, then retain the longer valid history and reject a fork", async direction => {
  const { owner, base, branches } = await fixture()
  const local = direction === "remote" ? base : branches[0]!
  const remote = direction === "local" ? base : direction === "remote" ? branches[0]! : branches[1]!
  await mergeIdentityAuthorityView(local)
  const service = statusService(owner, remote)
  const operation = ensureRustyIdentityAuthorityPublished({ profile: owner,
    access: { origin: "https://authority.example", scopeId: "scope", servicePublicKey: owner.identity.publicKey,
      readToken: "read", writeToken: "write", policyRevision: 1 }, fetcher: service.fetcher })
  if (direction === "fork") {
    await expect(operation).rejects.toThrow(/fork|prefix/i)
    expect(await requireIdentityAuthorityView(owner.identity.personId)).toEqual(local)
    expect(service.writes).toEqual([])
    return
  }
  await expect(operation).resolves.toEqual(branches[0])
  expect(await requireIdentityAuthorityView(owner.identity.personId)).toEqual(branches[0])
  expect(service.writes).toEqual(direction === "local" ? [branches[0]] : [])
})
