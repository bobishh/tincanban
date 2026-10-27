import { beforeEach, expect, it, vi } from "vitest"
import { reactive } from "vue"
import { createIdentityAuthorityView } from "@meta-uber/mesh-identity"
import { BrowserIdentityStore } from "@meta-uber/mesh-identity"
import type { RustyIdentityRequestProofPayload } from "@meta-uber/mesh-replication/rusty-identity-request-proof"
import { signEnvelope } from "../domain/identity"
import { publicKeyId } from "../domain/identityCrypto"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { rootIdentityProfileState } from "../domain/identityProfileRoot"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createRustyIdentityScopeFetcher, ensureRustyIdentityAuthorityPublished,
  type RustyIdentityScopeFetcherOptions } from "./rustyIdentityTransport"
import { isRustyRequestFailure } from "./replicationErrors"

beforeEach(() => resetIdentityStorageForTest())

it.each(["profile", "access"] as const)("Given reactive %s settings, When refreshing Rusty authority, Then reach the transport without a cloning failure", async field => {
  const f = await fixture()
  const before = JSON.stringify({ profile: f.profile, access: f.base.access })
  const fetcher = vi.fn(async () => { throw new Error("Authority transport unavailable") })
  await expect(ensureRustyIdentityAuthorityPublished({
    profile: field === "profile" ? reactive(f.profile) : f.profile,
    access: field === "access" ? reactive(f.base.access) : f.base.access,
    fetcher,
  })).rejects.toThrow("Authority transport unavailable")
  expect(fetcher).toHaveBeenCalledOnce()
  expect(JSON.stringify({ profile: f.profile, access: f.base.access })).toBe(before)
})

it("Given reactive Rusty credentials, When sending a signed read, Then preserve the captured token and exact proof", async () => {
  const f = await fixture()
  const access = reactive({ ...f.base.access })
  const fetcher = createRustyIdentityScopeFetcher({ ...f.base, access,
    identity: reactive(f.profile.identity), fetcher: f.rawFetch })
  access.readToken = "replacement-token"
  await fetcher("https://rusty.example/v2/scopes/scope-1/inventory", {
    headers: { Authorization: "Bearer read-token" },
  })
  const headers = new Headers(f.rawFetch.mock.calls[0]![1].headers)
  const proof = JSON.parse(Buffer.from(headers.get("X-Rusty-Identity-Proof")!, "base64url").toString("utf8"))
  expect(headers.get("Authorization")).toBe("Bearer read-token")
  expect(proof.payload).toMatchObject({ action: "read", scopeId: "scope-1", personId: f.profile.identity.personId,
    method: "GET", path: "/v2/scopes/scope-1/inventory" })
})

async function fixture() {
  const profile = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(profile, await certHashDefault(profile.certificate))
  const authorityView = await createIdentityAuthorityView(profile.identity, { certificates: [profile.certificate], revocations: [] },
    await rootIdentityProfileState(root))
  const scopeAuthority = { genesis: await signEnvelope(profile.privateKeys.devicePrivateKey!, { kind: "scope-genesis", version: 1,
    scopeId: "workspace-1", creator: { personId: profile.identity.personId, publicKey: profile.identity.publicKey,
      certificates: [profile.certificate] }, controlEpoch: 1 }, profile.device.deviceId),
    grants: [], grantIssuers: [], revocations: [], controlTransfers: [] }
  const base = {
    identity: profile.identity, deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey,
    access: { origin: "https://rusty.example", scopeId: "scope-1", servicePublicKey: profile.identity.publicKey,
      readToken: "read-token", writeToken: "write-token", policyRevision: 4 },
    authorityView: async () => authorityView,
    ensureCurrent: vi.fn(),
    signAuthorization: async (payload: RustyIdentityRequestProofPayload) =>
      signEnvelope(profile.privateKeys.devicePrivateKey!, payload, profile.device.deviceId),
  } satisfies Omit<RustyIdentityScopeFetcherOptions, "fetcher">
  const rawFetch = vi.fn(async (url: string, _init: RequestInit) => {
    if (!url.startsWith("https://rusty.example/")) throw new Error("Unexpected test destination")
    new Headers(_init.headers)
    return new Response("ok")
  })
  return { profile, authorityView, scopeAuthority, base, rawFetch }
}

async function identityProfile(name: string) {
  const storage = (() => {
    const values = new Map<string, string>()
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) } }
  })()
  return new BrowserIdentityStore({ storageKey: crypto.randomUUID(), storage }).bootstrap(name)
}

async function transferredScopeSnapshot(f: Awaited<ReturnType<typeof fixture>>, successorName: string) {
  const successor = await identityProfile(successorName)
  const payload = meshRustRuntime().state.createScopeControlTransferPayload({ snapshot: f.scopeAuthority,
    toController: { personId: successor.identity.personId, publicKey: successor.identity.publicKey,
      certificates: [successor.certificate] } }, Date.now())
  const transfer = await signEnvelope(f.profile.privateKeys.devicePrivateKey!, payload as { kind: string }, f.profile.device.deviceId)
  const snapshot = { ...f.scopeAuthority, controlTransfers: [transfer] }
  const current = meshRustRuntime().state.validateScopeAuthority(snapshot, Date.now()) as {
    scopeId: string; controller: { personId: string; publicKey: string }; controlEpoch: number
  }
  return { successor, snapshot, current }
}

it("Given a verified owner authority, When a scope write is sent, Then sign the exact method, path, body and owner policy epoch", async () => {
  const f = await fixture()
  const fetcher = createRustyIdentityScopeFetcher({ ...f.base, fetcher: f.rawFetch })

  const response = await fetcher("https://rusty.example/v2/scopes/scope-1/objects/object-1?writerVersion=2", {
    method: "PUT", headers: { Authorization: "Bearer write-token", "Content-Type": "application/json" }, body: "{\"opaque\":true}",
  })

  expect(await response.text()).toBe("ok")
  const call = f.rawFetch.mock.calls[0]!
  const headers = new Headers(call[1].headers)
  expect(headers.get("Authorization")).toBe("Bearer write-token")
  const proof = JSON.parse(Buffer.from(headers.get("X-Rusty-Identity-Proof")!, "base64url").toString("utf8"))
  expect(proof.payload).toMatchObject({
    kind: "rusty-identity-request-proof", personId: f.profile.identity.personId,
    deviceId: f.profile.device.deviceId, scopeId: "scope-1", action: "write", grantId: null,
    policyEpoch: 4, method: "PUT", path: "/v2/scopes/scope-1/objects/object-1?writerVersion=2",
  })
})

it("Given a visitor grant, When the visitor attempts a write, Then reject before making a Rusty request", async () => {
  const f = await fixture()
  const fetcher = createRustyIdentityScopeFetcher({ ...f.base, fetcher: f.rawFetch,
    principal: { grantId: "grant-visitor", policyEpoch: 8, actions: ["read"] } })

  await expect(fetcher("https://rusty.example/v2/scopes/scope-1/objects/object-1", {
    method: "PUT", headers: { Authorization: "Bearer write-token" }, body: "payload",
  })).rejects.toThrow(/read-only|grant/i)
  expect(f.rawFetch).not.toHaveBeenCalled()
})

it.each(["archive-coverage", "archive-coverage/aggregate", "blob-coverage"])("Given a read-only coverage query, When POSTing to %s, Then sign a read operation with the read token", async path => {
  const f = await fixture()
  const fetcher = createRustyIdentityScopeFetcher({ ...f.base, fetcher: f.rawFetch,
    principal: { grantId: "grant-reader", policyEpoch: 4, actions: ["read"] } })
  await fetcher(`https://rusty.example/v2/scopes/scope-1/${path}`, {
    method: "POST", headers: { Authorization: "Bearer read-token" }, body: "{}",
  })
  const headers = new Headers(f.rawFetch.mock.calls[0]![1].headers)
  const proof = JSON.parse(Buffer.from(headers.get("X-Rusty-Identity-Proof")!, "base64url").toString("utf8"))
  expect(proof.payload).toMatchObject({ method: "POST", action: "read", path: `/v2/scopes/scope-1/${path}` })
})

it("Given a reader, When publishing a checkpoint, Then reject before sending the write", async () => {
  const f = await fixture()
  const fetcher = createRustyIdentityScopeFetcher({ ...f.base, fetcher: f.rawFetch,
    principal: { grantId: "grant-reader", policyEpoch: 4, actions: ["read"] } })

  await expect(fetcher("https://rusty.example/v2/scopes/scope-1/checkpoint", {
    method: "POST", headers: { Authorization: "Bearer write-token" }, body: "{}",
  })).rejects.toThrow("Rusty principal grant does not permit this action")
  expect(f.rawFetch).not.toHaveBeenCalled()
})

it("Given a writer, When publishing a checkpoint, Then sign POST as a write operation", async () => {
  const f = await fixture()
  const fetcher = createRustyIdentityScopeFetcher({ ...f.base, fetcher: f.rawFetch })

  await fetcher("https://rusty.example/v2/scopes/scope-1/checkpoint", {
    method: "POST", headers: { Authorization: "Bearer write-token" }, body: "{}",
  })
  const headers = new Headers(f.rawFetch.mock.calls[0]![1].headers)
  const proof = JSON.parse(Buffer.from(headers.get("X-Rusty-Identity-Proof")!, "base64url").toString("utf8"))
  expect(proof.payload).toMatchObject({ method: "POST", action: "write", path: "/v2/scopes/scope-1/checkpoint" })
})

it("Given Rusty denies the current scope authority preflight, When private data is polled, Then preserve the HTTP access failure", async () => {
  const f = await fixture()
  f.rawFetch.mockResolvedValue(new Response("forbidden", { status: 403 }))
  const fetcher = createRustyIdentityScopeFetcher({ ...f.base, fetcher: f.rawFetch,
    principal: { grantId: "member-grant", policyEpoch: 2, actions: ["read"], scopeAuthority: f.scopeAuthority },
    workspace: { workspaceId: "workspace-1", scopeAuthority: async () => f.scopeAuthority } })

  let caught: unknown
  try {
    await fetcher("https://rusty.example/v2/scopes/scope-1/objects/object-1", {
      method: "GET", headers: { Authorization: "Bearer read-token" },
    })
  } catch (cause) { caught = cause }

  expect(isRustyRequestFailure(caught)).toBe(true)
  expect(caught).toMatchObject({ status: 403 })
  expect(f.rawFetch).toHaveBeenCalledTimes(1)
})

it("Given a workspace member, When protected scope data is requested, Then verify the current control ledger first", async () => {
  const f = await fixture()
  const serviceId = await publicKeyId(f.profile.identity.publicKey)
  const calls: string[] = []
  const server = vi.fn(async (input: string) => {
    const url = new URL(input)
    calls.push(url.pathname)
    if (url.pathname.endsWith("/authority/status")) {
      const requestId = url.searchParams.get("requestId")!
      const requestHash = url.searchParams.get("requestHash")!
      const payload = { kind: "rusty-scope-authority-status", version: 1, serviceId, origin: url.origin,
        scopeId: "scope-1", workspaceId: "workspace-1", state: "ready", controllerPersonId: f.profile.identity.personId,
        controlEpoch: 1, requestId, requestHash, issuedAt: Date.now(), enforcement: { mode: "additive", epoch: 0 },
        scopeAuthority: f.scopeAuthority }
      const status = await signEnvelope(f.profile.privateKeys.identityPrivateKey!, payload, serviceId, "RUSTY/2")
      return new Response(JSON.stringify({ status }), { status: 200 })
    }
    return new Response("ok")
  })
  const fetcher = createRustyIdentityScopeFetcher({ ...f.base, principal: { grantId: "member-grant", policyEpoch: 2,
    actions: ["read"], scopeAuthority: f.scopeAuthority },
    workspace: { workspaceId: "workspace-1", scopeAuthority: async () => f.scopeAuthority }, fetcher: server })

  await fetcher("https://rusty.example/v2/scopes/scope-1/objects/object-1", {
    method: "GET", headers: { Authorization: "Bearer read-token" },
  })
  expect(calls).toEqual(["/v2/scopes/scope-1/authority/status", "/v2/scopes/scope-1/objects/object-1"])
})

it("Given an accepted member grant from before controller handoff, When its ledger is a prefix of Rusty's current ledger, Then keep the read grant usable", async () => {
  const f = await fixture()
  const member = await identityProfile("Member")
  const root = createPersonalRoot(member, await certHashDefault(member.certificate))
  const memberView = await createIdentityAuthorityView(member.identity, { certificates: [member.certificate], revocations: [] },
    await rootIdentityProfileState(root))
  const { snapshot: currentSnapshot, current } = await transferredScopeSnapshot(f, "Successor")
  const serviceId = await publicKeyId(f.profile.identity.publicKey)
  const calls: string[] = []
  const fetcher = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input)
    calls.push(url.pathname)
    if (url.pathname.endsWith("/authority/status")) {
      const requestId = url.searchParams.get("requestId")!
      const requestHash = url.searchParams.get("requestHash")!
      const status = await signEnvelope(f.profile.privateKeys.identityPrivateKey!, {
        kind: "rusty-scope-authority-status", version: 1, serviceId, origin: url.origin, scopeId: "scope-1",
        workspaceId: "workspace-1", state: "ready", controllerPersonId: current.controller.personId,
        controlEpoch: current.controlEpoch, requestId, requestHash, issuedAt: Date.now(),
        enforcement: { mode: "strict", epoch: 1 }, scopeAuthority: currentSnapshot,
      }, serviceId, "RUSTY/2")
      return new Response(JSON.stringify({ status }), { status: 200 })
    }
    expect(new Headers(init.headers).get("X-Rusty-Identity-Proof")).toBeTruthy()
    return new Response("ok")
  })
  const fetchRequest = createRustyIdentityScopeFetcher({ ...f.base, identity: member.identity, deviceId: member.device.deviceId,
    devicePublicKey: member.device.publicKey, authorityView: async () => memberView,
    signAuthorization: async payload => signEnvelope(member.privateKeys.devicePrivateKey!, payload, member.device.deviceId),
    principal: { grantId: "member-grant", policyEpoch: 2, actions: ["read"], scopeAuthority: f.scopeAuthority },
    workspace: { workspaceId: "workspace-1", scopeAuthority: async () => f.scopeAuthority }, fetcher })

  await expect(fetchRequest("https://rusty.example/v2/scopes/scope-1/objects/object-1", {
    method: "GET", headers: { Authorization: "Bearer read-token" },
  })).resolves.toMatchObject({ status: 200 })
  expect(calls).toEqual(["/v2/scopes/scope-1/authority/status", "/v2/scopes/scope-1/objects/object-1"])
})

it("Given a member grant on a forked controller ledger, When current status reports another branch, Then fail before requesting data", async () => {
  const f = await fixture()
  const member = await identityProfile("Member")
  const root = createPersonalRoot(member, await certHashDefault(member.certificate))
  const memberView = await createIdentityAuthorityView(member.identity, { certificates: [member.certificate], revocations: [] },
    await rootIdentityProfileState(root))
  const { successor: branchA, snapshot: currentSnapshot, current } = await transferredScopeSnapshot(f, "Branch A")
  const branchB = await identityProfile("Branch B")
  const forkPayload = meshRustRuntime().state.createScopeControlTransferPayload({ snapshot: f.scopeAuthority,
    toController: { personId: branchB.identity.personId, publicKey: branchB.identity.publicKey,
      certificates: [branchB.certificate] } }, Date.now())
  const forkTransfer = await signEnvelope(f.profile.privateKeys.devicePrivateKey!, forkPayload as { kind: string }, f.profile.device.deviceId)
  const forkedGrantSnapshot = { ...f.scopeAuthority, controlTransfers: [forkTransfer] }
  expect(branchA.identity.personId).not.toBe(branchB.identity.personId)
  const serviceId = await publicKeyId(f.profile.identity.publicKey)
  const calls: string[] = []
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input)
    calls.push(url.pathname)
    if (!url.pathname.endsWith("/authority/status")) return new Response("must not reach data", { status: 500 })
    const requestId = url.searchParams.get("requestId")!
    const requestHash = url.searchParams.get("requestHash")!
    const status = await signEnvelope(f.profile.privateKeys.identityPrivateKey!, {
      kind: "rusty-scope-authority-status", version: 1, serviceId, origin: url.origin, scopeId: "scope-1",
      workspaceId: "workspace-1", state: "ready", controllerPersonId: current.controller.personId,
      controlEpoch: current.controlEpoch, requestId, requestHash, issuedAt: Date.now(),
      enforcement: { mode: "strict", epoch: 1 }, scopeAuthority: currentSnapshot,
    }, serviceId, "RUSTY/2")
    return new Response(JSON.stringify({ status }), { status: 200 })
  })
  const fetchRequest = createRustyIdentityScopeFetcher({ ...f.base, identity: member.identity, deviceId: member.device.deviceId,
    devicePublicKey: member.device.publicKey, authorityView: async () => memberView,
    signAuthorization: async payload => signEnvelope(member.privateKeys.devicePrivateKey!, payload, member.device.deviceId),
    principal: { grantId: "member-grant", policyEpoch: 2, actions: ["read"], scopeAuthority: forkedGrantSnapshot },
    workspace: { workspaceId: "workspace-1", scopeAuthority: async () => forkedGrantSnapshot }, fetcher })

  await expect(fetchRequest("https://rusty.example/v2/scopes/scope-1/objects/object-1", {
    method: "GET", headers: { Authorization: "Bearer read-token" },
  })).rejects.toThrow()
  expect(calls).toEqual(["/v2/scopes/scope-1/authority/status"])
})

it("Given a bound request, When URL or token escapes the connection, Then fail closed", async () => {
  const f = await fixture()
  const fetcher = createRustyIdentityScopeFetcher({ ...f.base, fetcher: f.rawFetch })
  await expect(fetcher("https://attacker.example/v2/scopes/scope-1/objects/o", {
    method: "GET", headers: { Authorization: "Bearer read-token" },
  })).rejects.toThrow(/scope|origin/i)
  await expect(fetcher("https://rusty.example/v2/scopes/scope-1/objects/o", {
    method: "GET", headers: { Authorization: "Bearer other-token" },
  })).rejects.toThrow(/token|access/i)
  expect(f.rawFetch).not.toHaveBeenCalled()
})
