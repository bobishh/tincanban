import { afterEach, expect, it, vi } from "vitest"
import { IDBFactory } from "fake-indexeddb"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it("Given an incompatible automation, when starting device removal, then fail before freezing board replication or saving a transition", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.resetModules()
  const identity = await import("../domain/identity")
  const profile = await identity.bootstrapIdentity("owner")
  const local = await import("../localDb")
  await local.writeLocal("tincanban.local_profile.v1", JSON.stringify(profile))
  const key = (byte: number) => identity.toBase64Url(new Uint8Array(32).fill(byte))
  const repository = await import("./privateReplicaRepository")
  const config = { purpose: "workspace" as const, workspaceId: "board", scopeId: "scope", origin: "https://rusty.example",
    servicePublicKey: key(1), contentKey: key(2), readToken: key(3), writeToken: key(4), keyEpoch: 1, policyRevision: 1,
    cursor: 0, lastUploaded: "", minimumWriterVersion: 2 as const }
  await repository.setReplicaPreference(profile.identity.personId, config)
  vi.spyOn((await import("../storage")).defaultStorage, "loadPersonalRoot").mockResolvedValue({
    identity: profile.identity, devices: { "removed-device": {} },
  } as never)
  vi.spyOn(await import("./blindClient"), "discoverBlindKeeper").mockResolvedValue({ origin: config.origin,
    servicePublicKey: config.servicePublicKey, personManagement: 1, scopeManagement: 1, scopeEnrollmentRetry: 1,
    writerPolicy: { maximumWriterVersion: 2 },
  } as never)
  vi.spyOn(await import("./workspaceOwnerSigning"), "workspaceOwnerSigningContext").mockResolvedValue({} as never)
  vi.spyOn(await import("../domain/signingContext"), "assertSigningContextCurrent").mockResolvedValue(undefined)
  vi.spyOn(await import("./rustyManagementClient"), "ensureRustyPersonPolicy").mockResolvedValue(undefined)
  vi.spyOn(await import("./workspaceReplicaWorkers"), "discoverWorkspaceReplicaWorkers")
    .mockRejectedValue(new Error("Automation uses another storage epoch"))
  const app = { getCurrentProfile: () => profile,
    readWorkspaceDoc: async () => ({ id: config.workspaceId, ownerPersonId: profile.identity.personId }),
  }
  const { revokeRustyIdentityDevice } = await import("./rustyCredentialTransition")
  await expect(revokeRustyIdentityDevice(app as never, config.origin, "removed-device", () => {}))
    .rejects.toThrow("Automation uses another storage epoch")
  const freeze = await import("./replicaCredentialFreeze")
  expect(await freeze.readReplicaCredentialFreeze(profile.identity.personId, config.origin)).toBeUndefined()
  expect(await (await import("./replicaCredentialTransitionJournal")).readCredentialTransitionJournal(profile, config.origin)).toBeUndefined()
  await expect(freeze.assertReplicaCredentialsUnfrozen(profile.identity.personId, config)).resolves.toBeUndefined()
})
