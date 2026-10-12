import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { WorkerEnv } from "../src/index";
import * as Automerge from "@automerge/automerge/slim";
import automergeWasm from "@automerge/automerge/automerge.wasm";
import { initSync, WasmStateCore } from "@meta-uber/mesh-transport/wasm";
import { profileFromIdentitySeedForDevice, signEnvelope } from "../../../vendor/meta-mesh/packages/mesh-identity/src/index";
import { createWorkspaceDoc } from "../../../src/domain/seeds";
import { createAutomationWorkspaceGrant } from "../../../src/domain/proofs";
import { executeCommand } from "../../../src/domain/commands";
import { blindHash, blindObjectId, canonicalBlindJson, type BlindReceipt } from "../../../src/sync/blindClient";
import { decodeBlindBytes, decryptBlindObject, encodeBlindBytes, encryptBlindObject } from "../../../src/sync/blindEnvelope";
import { AutomationReplica, type AutomationActivationPacket, type ReplicaTransport } from "../src/replica";
import { automationTypes, parseAutomationDefinition } from "../../../src/domain/automationContract";
import { automationEntityId } from "../../../src/domain/automationLifecycle";
import type { WorkspaceDocumentV2 } from "../../../src/domain/model";

await Automerge.initializeWasm(automergeWasm as unknown as Uint8Array);

async function typedFixture(subjectPersonId?: string) {
  const data = await fixture(subjectPersonId);
  const payload = parseAutomationDefinition({ kind: "automation-definition", version: 1, id: "typed-intake", name: "Job intake",
    type: "job-intake" as const, typeVersion: 1 as const, parameters: { sources: ["website" as const] },
    permissions: [...automationTypes[0].permissions],
    scope: { workspaceId: data.packet.workspaceId, boardId: data.packet.bindings.boardId, grantId: data.packet.grant.payload.grantId } });
  const definition = await signEnvelope(data.owner.privateKeys.devicePrivateKey, payload, data.owner.device.deviceId);
  const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(data.packet.initial.document));
  const added = await executeCommand(document, { kind: "createAutomation", definition: payload, approval: JSON.stringify({ definition, grant: data.packet.grant }),
    executor: { origin: "https://automation.example.test", personId: data.packet.grant.payload.personId } }, data.owner);
  if (!added.ok) throw new Error(added.error.message);
  const signed = await ownerSnapshot(added.value.newDoc, data.owner, data.packet);
  Automerge.free(document); Automerge.free(added.value.newDoc);
  return { ...data, packet: { ...data.packet, version: 2 as const, definition, initial: signed } };
}

async function ownerSnapshot(document: Automerge.Doc<WorkspaceDocumentV2>, owner: Awaited<ReturnType<typeof profileFromIdentitySeedForDevice>>,
  packet: AutomationActivationPacket) {
  const signed = await signEnvelope(owner.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: packet.workspaceId,
    hashes: Automerge.getAllChanges(document).map(bytes => Automerge.decodeChange(bytes).hash),
    personId: owner.identity.personId, deviceId: owner.device.deviceId,
  }, owner.device.deviceId);
  return { document: encodeBlindBytes(Automerge.save(document)), chat: null,
    authorization: { version: 1 as const, records: [{ signed, publicKey: owner.identity.publicKey, certificates: [owner.certificate],
      ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate] }], authority: packet.initial.authorization.authority } };
}

it("Given an owner-signed type contract, when activated and restored, then only its registered event sources can execute", async () => {
  const data = await typedFixture();
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  expect(replica.allowsSource("website")).toBe(true);
  expect(replica.allowsSource("email")).toBe(false);
  const restored = await AutomationReplica.restore(replica.serialize(), data.automation, async () => {});
  expect(restored.definitionForRuntime()).toMatchObject({ type: "job-intake", typeVersion: 1, parameters: { sources: ["website"] } });
  expect(restored.allowsSource("email")).toBe(false);
});

it.each([false, true])("Given a signed email scope renewal with rotated storage=%s, when reactivated, then preserves the executor, pending upload and event deduplication", async rotated => {
  const data = await typedFixture();
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  const created = await replica.createLead("renewal-lead", { company: "Example GmbH", role: "Senior Engineer" }, {});
  const stored = JSON.parse(replica.serialize());
  const pendingPlaintext = new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: stored.workspaceId,
    document: stored.rawDocument, authorization: { version: 1, authority: stored.authority, records: stored.authorizations }, chat: stored.chat }));
  stored.pending = { hash: await blindHash(pendingPlaintext), object: await encryptBlindObject(stored.blind.scopeId,
    stored.blind.keyEpoch, decodeBlindBytes(stored.blind.contentKey), pendingPlaintext) };
  stored.blind.cursor = 17;
  stored.blind.lastUploaded = stored.pending.hash;
  const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(stored.rawDocument));
  const board = document.entities[data.packet.bindings.boardId];
  if (board.kind !== "board") throw new Error("Missing board");
  const bindings = { ...data.packet.bindings, columns: { ...data.packet.bindings.columns, applied: board.preset!.bindings["status.applied"]! } };
  const grant = await createAutomationWorkspaceGrant(data.owner, data.packet.workspaceId, data.automation.identity.personId,
    { ...data.packet.grant.payload.automation!, columns: bindings.columns });
  const payload = { ...data.packet.definition!.payload, parameters: { sources: ["website", "email"] as Array<"website" | "email"> },
    scope: { ...data.packet.definition!.payload.scope, grantId: grant.payload.grantId } };
  const definition = await signEnvelope(data.owner.privateKeys.devicePrivateKey, payload, data.owner.device.deviceId);
  const changed = await executeCommand(document, { kind: "configureAutomation", definition: payload,
    approval: JSON.stringify({ definition, grant }) }, data.owner);
  if (!changed.ok) throw new Error(changed.error.message);
  const signed = await signEnvelope(data.owner.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: data.packet.workspaceId,
    hashes: [changed.value.receipt.changeHash], personId: data.owner.identity.personId, deviceId: data.owner.device.deviceId,
  }, data.owner.device.deviceId);
  const blind = rotated ? { ...data.packet.blind, scopeId: "rotated-scope", keyEpoch: 2,
    contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), cursor: 3 } : data.packet.blind;
  const packet = { ...data.packet, blind, grant, definition, bindings, initial: {
    ...data.packet.initial, document: encodeBlindBytes(Automerge.save(changed.value.newDoc)),
    authorization: { version: 1 as const, authority: stored.authority, records: [...stored.authorizations, {
      signed, publicKey: data.owner.identity.publicKey, certificates: [data.owner.certificate],
      ownerPublicKey: data.owner.identity.publicKey, ownerCertificates: [data.owner.certificate],
    }] },
  } };
  const renewed = await AutomationReplica.renew(JSON.stringify(stored), packet, data.automation, "https://automation.example.test");
  const next = JSON.parse(renewed.serialize());
  expect(next.blind.cursor).toBe(blind.cursor);
  expect(next.blind.lastUploaded).toBe(rotated ? "" : stored.pending.hash);
  expect(next.pending.hash).toBe(stored.pending.hash);
  expect(await decryptBlindObject(next.pending.object, blind.scopeId, blind.keyEpoch, decodeBlindBytes(blind.contentKey))).toEqual(pendingPlaintext);
  expect(renewed.allowsSource("email")).toBe(true);
  expect(await renewed.createLead("renewal-lead", { company: "Example GmbH", role: "Senior Engineer" }, {})).toEqual({ cardId: created.cardId, duplicate: true });
  Automerge.free(document); Automerge.free(changed.value.newDoc);
});

it("Given an explicitly signed Applied binding, when a new confirmed application is created, then it starts in Applied and duplicate delivery creates no second card", async () => {
  const data = await fixture();
  const doc = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(data.packet.initial.document));
  const board = doc.entities[data.packet.bindings.boardId];
  if (board.kind !== "board") throw new Error("Missing board");
  const applied = board.preset!.bindings["status.applied"]!;
  const bindings = { ...data.packet.bindings, columns: { ...data.packet.bindings.columns, applied } };
  const grant = await createAutomationWorkspaceGrant(data.owner, data.packet.workspaceId, data.automation.identity.personId,
    { ...data.packet.grant.payload.automation!, columns: bindings.columns });
  const replica = await AutomationReplica.activate({ ...data.packet, grant, bindings }, data.automation);
  const created = await replica.createLead("new-application", { company: "Example GmbH", role: "Senior Engineer", messageIds: ["<original@example.test>"] }, {}, applied);
  expect(replica.candidates().find(card => card.cardId === created.cardId)?.messageIds).toEqual(["<original@example.test>"]);
  expect(replica.candidates().find(card => card.cardId === created.cardId)?.columnId).toBe(applied);
  expect(await replica.createLead("new-application", { company: "Example GmbH", role: "Senior Engineer" }, {}, applied)).toEqual({ cardId: created.cardId, duplicate: true });
  Automerge.free(doc);
});

it("Given already verified workspace evidence, when controls are read repeatedly with no CPU budget for revalidation, then observations remain available but expired grants fail", async () => {
  const data = await typedFixture();
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  const admission = vi.spyOn(WasmStateCore, "evaluateCausalAdmission").mockImplementation(() => { throw new Error("Admission CPU budget exhausted"); });
  try {
    expect(replica.controlForRuntime().state).toBe("active");
    expect(replica.observationForRuntime("https://automation.example.test", "unchanged-evidence").state).toBe("active");
    vi.useFakeTimers();
    vi.setSystemTime(data.packet.grant.payload.automation!.expiresAt + 1);
    expect(() => replica.controlForRuntime()).toThrow(/expired/);
  } finally { admission.mockRestore(); vi.useRealTimers(); }
});

it("Given a signed workspace with over 312k text operations, when automation activates, restores and creates a lead, then its controls remain admitted within the policy memory budget", async () => {
  const data = await typedFixture();
  const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(data.packet.initial.document));
  const added = await executeCommand(document, { kind: "createItem", parentId: data.packet.bindings.columns.lead,
    title: "Large source", body: "Source text. ".repeat(26_100), values: {
      [data.packet.bindings.fieldIds.company]: "Example", [data.packet.bindings.fieldIds.role]: "Engineer",
    } }, data.owner);
  if (!added.ok) throw new Error(added.error.message);
  expect(Automerge.stats(added.value.newDoc).numOps).toBeGreaterThan(312_000);
  data.packet.initial = await ownerSnapshot(added.value.newDoc, data.owner, data.packet);
  Automerge.free(document); Automerge.free(added.value.newDoc);
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  expect(replica.controlForRuntime().state).toBe("active");
  const restored = await AutomationReplica.restore(replica.serialize(), data.automation, async () => {});
  expect(restored.controlForRuntime().state).toBe("active");
  const created = await restored.createLead("large-workspace-intake", { company: "Example", role: "Senior engineer" }, {});
  expect(restored.candidates().find(candidate => candidate.cardId === created.cardId)?.columnId).toBe(data.packet.bindings.columns.lead);
  expect(initSync().memory.buffer.byteLength).toBeLessThanOrEqual(64 * 1024 * 1024);
}, 60_000);

it("Given a modified type contract, when activated, then scope, signature and unsupported types are rejected", async () => {
  const data = await typedFixture();
  for (const patch of [{ type: "run-code" }, { typeVersion: 2 }, { name: "Tampered" },
    { scope: { ...data.packet.definition!.payload.scope, boardId: "another-board" } }]) {
    const packet = { ...data.packet, definition: { ...data.packet.definition!, payload: { ...data.packet.definition!.payload, ...patch } } };
    await expect(AutomationReplica.activate(packet as never, data.automation)).rejects.toThrow();
  }
});

it("Given a version-2 activation missing its contract, when activated, then no legacy default is substituted", async () => {
  const data = await fixture();
  await expect(AutomationReplica.activate({ ...data.packet, version: 2 } as never, data.automation)).rejects.toThrow();
});

it("Given typed activation without its CRDT controls, when activated or restored without the contract, then execution cannot fall back to legacy behavior", async () => {
  const data = await typedFixture();
  const legacy = await fixture();
  await expect(AutomationReplica.activate({ ...data.packet, initial: legacy.packet.initial }, data.automation)).rejects.toThrow();
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  const serialized = JSON.parse(replica.serialize());
  delete serialized.definition;
  await expect(AutomationReplica.restore(JSON.stringify(serialized), data.automation, async () => {})).rejects.toThrow();
});

it("Given owner controls delivered through encrypted Rusty, when paused, resumed and deleted, then execution stops, resumes and remains deleted after restart and old snapshot replay", async () => {
  const data = await typedFixture();
  let remoteObject: Awaited<ReturnType<typeof encryptBlindObject>> | undefined;
  let sequence = 0;
  const transport: ReplicaTransport = {
    inventory: async (_access, after) => remoteObject && after < sequence
      ? { objects: [{ objectId: await blindObjectId(remoteObject), sequence }], cursor: sequence, hasMore: false }
      : { objects: [], cursor: after, hasMore: false },
    download: async () => { if (!remoteObject) throw new Error("Missing remote"); return remoteObject; },
    upload: signedReceipt,
  };
  data.packet.transport = transport;
  let replica = await AutomationReplica.activate(data.packet, data.automation);
  let ownerDocument = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(data.packet.initial.document));
  const publish = async (state: "active" | "paused" | "deleted") => {
    const result = await executeCommand(ownerDocument, { kind: "setAutomationState", automationId: automationEntityId("typed-intake"), state }, data.owner);
    if (!result.ok) throw new Error(result.error.message);
    Automerge.free(ownerDocument); ownerDocument = result.value.newDoc;
    const snapshot = await ownerSnapshot(ownerDocument, data.owner, data.packet);
    remoteObject = await encryptBlindObject(data.packet.blind.scopeId, 1, data.key,
      new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: data.packet.workspaceId, ...snapshot })));
    sequence++;
    await replica.sync();
  };
  await publish("paused");
  expect(replica.controlForRuntime()).toMatchObject({ state: "paused" });
  await expect(replica.createLead("paused-event", { company: "No", role: "Write" }, {})).rejects.toThrow(/paused/i);
  await publish("active");
  expect(replica.controlForRuntime()).toMatchObject({ state: "active" });
  await replica.createLead("resumed-event", { company: "Acme", role: "Engineer" }, {});
  await publish("deleted");
  replica = await AutomationReplica.restore(replica.serialize(), data.automation, async () => {}, transport);
  await expect(replica.createLead("deleted-event", { company: "No", role: "Write" }, {})).rejects.toThrow(/deleted/i);
  remoteObject = await encryptBlindObject(data.packet.blind.scopeId, 1, data.key,
    new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: data.packet.workspaceId, ...data.packet.initial })));
  sequence++;
  await replica.sync();
  expect(replica.controlForRuntime().state).toBe("deleted");
  Automerge.free(ownerDocument);
});

async function fixture(subjectPersonId?: string) {
  const owner = await profileFromIdentitySeedForDevice(new Uint8Array(32).fill(7), "Owner", new Uint8Array(32).fill(8));
  const automation = await profileFromIdentitySeedForDevice(new Uint8Array(32).fill(9), "Automation", new Uint8Array(32).fill(10));
  const document = Automerge.from(createWorkspaceDoc("automation-workspace", "Pipeline", owner.identity.personId, "job-search"), {
    actor: [...decodeBlindBytes(owner.device.deviceId)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
  });
  const board = Object.values(document.entities).find(value => "kind" in value && value.kind === "board")!;
  if (!("kind" in board) || board.kind !== "board") throw new Error("Fixture board missing");
  const bindings = {
    boardId: board.id,
    columns: {
      lead: board.preset!.bindings["status.lead"]!,
      interview: board.preset!.bindings["status.interview"]!,
      rejected: board.preset!.bindings["status.rejected"]!,
    },
    fieldIds: {
      company: board.preset!.bindings["field.company"]!,
      role: board.preset!.bindings["field.role"]!,
      jobUrl: board.preset!.bindings["field.url"]!,
      notes: board.preset!.bindings["field.notes"]!,
      sourceText: board.preset!.bindings["field.sourceText"]!,
    },
  };
  const ownerAuthority = { personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] };
  const authority = {
    genesisOwner: ownerAuthority, genesisEpoch: 1,
    currentOwner: ownerAuthority, currentEpoch: 1,
    ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [],
  };
  const changes = Automerge.getAllChanges(document).map(bytes => Automerge.decodeChange(bytes).hash);
  const ownerProof = await signEnvelope(owner.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: document.id,
    hashes: changes, personId: owner.identity.personId, deviceId: owner.device.deviceId,
  }, owner.device.deviceId);
  const authorization = {
    version: 1 as const,
    records: [{ signed: ownerProof, publicKey: owner.identity.publicKey, certificates: [owner.certificate],
      ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate] }],
    authority,
  };
  const grant = await createAutomationWorkspaceGrant(owner, document.id, subjectPersonId ?? automation.identity.personId, {
    version: 1, boardId: board.id, columns: bindings.columns, fieldIds: Object.values(bindings.fieldIds),
    expiresAt: Date.now() + 60 * 60_000,
  });
  const key = crypto.getRandomValues(new Uint8Array(32));
  const blind = {
    origin: "https://rusty.example.test", scopeId: "opaque-scope", servicePublicKey: "unused", readToken: "read", writeToken: "write",
    policyRevision: 1, workspaceId: document.id, keyEpoch: 1, contentKey: encodeBlindBytes(key), cursor: 0, lastUploaded: "",
  };
  const persisted: string[] = [];
  const packet: AutomationActivationPacket = {
    version: 1, workspaceId: document.id, blind, grant, bindings,
    initial: { document: encodeBlindBytes(Automerge.save(document)), authorization, chat: null },
    persist: async value => { persisted.push(value); },
  };
  Automerge.free(document);
  return { owner, automation, packet, key, persisted };
}

it("Given a paused durable automation and queued event, when alarm fires, then queue stays pending without attempts and control polling continues even with an empty queue", async () => {
  const id = `paused-${crypto.randomUUID()}`;
  const stub = (env as WorkerEnv).AUTOMATION.getByName(id);
  const identitySecret = "test-only-identity-secret-at-least-thirty-two-bytes";
  const storageSecret = "test-only-storage-secret-at-least-thirty-two-bytes";
  const identity = await stub.provisionIdentity(id, identitySecret);
  const data = await typedFixture(identity.identity.personId);
  const sync = vi.spyOn(AutomationReplica.prototype, "sync").mockResolvedValue();
  try {
    await stub.activateReplica(id, identitySecret, storageSecret, data.packet);
    const state = JSON.parse((await stub.loadReplicaState(storageSecret))!);
    const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(state.rawDocument));
    const paused = await executeCommand(document, { kind: "setAutomationState", automationId: automationEntityId("typed-intake"), state: "paused" }, data.owner);
    if (!paused.ok) throw new Error(paused.error.message);
    const snapshot = await ownerSnapshot(paused.value.newDoc, data.owner, data.packet);
    state.rawDocument = snapshot.document; state.authorizations = snapshot.authorization.records;
    await stub.saveReplicaState(storageSecret, JSON.stringify(state));
    await runInDurableObject(stub, async (instance, ctx) => {
      Reflect.set(instance, "env", { ...env, IDENTITY_STORAGE_SECRET: identitySecret, EVENT_STORAGE_SECRET: storageSecret,
        AI: { run: () => { throw new Error("Paused automation must not call AI"); } } });
      await ctx.storage.deleteAlarm();
      await instance.alarm();
      expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
      await instance.enqueueEmail({ eventId: "paused-event", sourceId: "paused-event", bodyHash: "hash", payload: "unused-on-pause" });
      await instance.alarm();
      expect(instance.getEvent("paused-event")?.status).toBe("pending");
      const row = ctx.storage.sql.exec<{ attempt: number }>("SELECT attempt FROM events WHERE event_id = 'paused-event'").one();
      expect(row.attempt).toBe(0);
      expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
      await ctx.storage.deleteAlarm();
    });
    Automerge.free(document); Automerge.free(paused.value.newDoc);
  } finally { sync.mockRestore(); }
});

it("Given a verified durable replica, when unchanged controls are polled, then admission is reused until stored evidence changes", async () => {
  const id = `poll-cache-${crypto.randomUUID()}`;
  const stub = (env as WorkerEnv).AUTOMATION.getByName(id);
  const identitySecret = "test-only-identity-secret-at-least-thirty-two-bytes";
  const storageSecret = "test-only-storage-secret-at-least-thirty-two-bytes";
  const identity = await stub.provisionIdentity(id, identitySecret);
  const data = await typedFixture(identity.identity.personId);
  const registration = { integrationId: id, workspaceId: data.packet.workspaceId, ownerPersonId: data.owner.identity.personId };
  const sync = vi.spyOn(AutomationReplica.prototype, "sync").mockResolvedValue();
  try {
    await stub.enrollOwner(registration, identitySecret);
    await stub.activateReplica(id, identitySecret, storageSecret, data.packet);
    await runInDurableObject(stub, async (instance, ctx) => {
      Reflect.set(instance, "env", { ...env, IDENTITY_STORAGE_SECRET: identitySecret, EVENT_STORAGE_SECRET: storageSecret });
      const restore = vi.spyOn(AutomationReplica, "restore");
      try {
        const first = await instance.observeOwner(registration, "first", "https://automation.example.test");
        const second = await instance.observeOwner(registration, "second", "https://automation.example.test");
        expect(first?.signed.payload.nonce).toBe("first");
        expect(second?.signed.payload.nonce).toBe("second");
        expect(restore).toHaveBeenCalledTimes(1);
        const state = JSON.parse((await instance.loadReplicaState(storageSecret))!);
        state.authorizations = [];
        await instance.saveReplicaState(storageSecret, JSON.stringify(state));
        await expect(instance.observeOwner(registration, "changed", "https://automation.example.test")).rejects.toThrow();
        expect(restore).toHaveBeenCalledTimes(2);
      } finally { restore.mockRestore(); await ctx.storage.deleteAlarm(); }
    });
  } finally { sync.mockRestore(); }
});

it("Given an existing paused or deleted instance, when old activation is replayed, then it preserves pause and rejects resurrection", async () => {
  const id = `replay-${crypto.randomUUID()}`;
  const stub = (env as WorkerEnv).AUTOMATION.getByName(id);
  const identitySecret = "test-only-identity-secret-at-least-thirty-two-bytes";
  const storageSecret = "test-only-storage-secret-at-least-thirty-two-bytes";
  const identity = await stub.provisionIdentity(id, identitySecret);
  const data = await typedFixture(identity.identity.personId);
  const sync = vi.spyOn(AutomationReplica.prototype, "sync").mockResolvedValue();
  try {
    await stub.activateReplica(id, identitySecret, storageSecret, data.packet);
    for (const desired of ["paused", "deleted"] as const) {
      const state = JSON.parse((await stub.loadReplicaState(storageSecret))!);
      const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(state.rawDocument));
      const changed = await executeCommand(document, { kind: "setAutomationState", automationId: automationEntityId("typed-intake"), state: desired }, data.owner);
      if (!changed.ok) throw new Error(changed.error.message);
      const snapshot = await ownerSnapshot(changed.value.newDoc, data.owner, data.packet);
      state.rawDocument = snapshot.document; state.authorizations = snapshot.authorization.records;
      await stub.saveReplicaState(storageSecret, JSON.stringify(state));
      const replay = await stub.activateReplica(id, identitySecret, storageSecret, data.packet);
      expect(replay).toMatchObject(desired === "paused" ? { ok: true, status: "paused" } : { ok: false, status: 422 });
      Automerge.free(document); Automerge.free(changed.value.newDoc);
    }
    await runInDurableObject(stub, async (_instance, ctx) => { await ctx.storage.deleteAlarm(); });
  } finally { sync.mockRestore(); }
});

async function signedReceipt(access: Parameters<ReplicaTransport["upload"]>[0], object: Parameters<ReplicaTransport["upload"]>[1]): Promise<BlindReceipt> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const servicePublicKey = encodeBlindBytes(publicKey);
  const serviceId = await blindHash(publicKey);
  (access as { servicePublicKey: string }).servicePublicKey = servicePublicKey;
  const payload = { kind: "blind-storage-receipt" as const, version: 2 as const, serviceId,
    scopeId: access.scopeId, keyEpoch: object.keyEpoch, objectId: await blindObjectId(object),
    sequence: 1, policyRevision: access.policyRevision, requestId: "request-1" };
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey,
    new TextEncoder().encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)));
  return { payload, signerKeyId: serviceId, signature: encodeBlindBytes(signature) };
}

describe("AutomationReplica in workerd with the compiled Rust policy", () => {
  it("Given browser-supplied storage metadata, when the Worker pulls and uploads through its real adapter, then requests identify automation without claiming a browser build", async () => {
    const { automation, packet, key } = await fixture();
    packet.blind.client = "tincanban";
    packet.blind.clientBuild = "f".repeat(40);
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    packet.blind.servicePublicKey = encodeBlindBytes(publicKey);
    const serviceId = await blindHash(publicKey);
    const remote = await encryptBlindObject(packet.blind.scopeId, packet.blind.keyEpoch, key,
      new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: packet.workspaceId,
        ...packet.initial, chat: null })));
    const remoteId = await blindObjectId(remote);
    const requests: Array<{ method: string; headers: Headers }> = [];
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      requests.push({ method, headers });
      if (url.includes("?after=")) return Response.json({ objects: [{ objectId: remoteId, sequence: 1 }], cursor: 1, hasMore: false });
      if (method === "GET") return Response.json(remote);
      const object = JSON.parse(String(init?.body));
      const payload = { kind: "blind-storage-receipt" as const, version: 2 as const, serviceId,
        scopeId: packet.blind.scopeId, keyEpoch: packet.blind.keyEpoch, objectId: await blindObjectId(object),
        sequence: 2, policyRevision: packet.blind.policyRevision, requestId: headers.get("X-Rusty-Request-Id")! };
      const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey,
        new TextEncoder().encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)));
      return Response.json({ payload, signerKeyId: serviceId, signature: encodeBlindBytes(signature) });
    });
    try {
      const replica = await AutomationReplica.activate(packet, automation);
      await replica.sync();
      expect(requests.map(request => request.method)).toEqual(["GET", "GET", "PUT"]);
      for (const request of requests) {
        expect(request.headers.get("X-Rusty-Client")).toBe("automation");
        expect(request.headers.get("X-Rusty-Build")).toBeNull();
      }
      expect(JSON.parse(replica.serialize()).pending).toBeUndefined();
    } finally { network.mockRestore(); }
  });

  it.each([false, true])("Given a legacy pending snapshot and changed document=%s, when retrying after upgrade, then ciphertext is reused only for identical complete state", async changed => {
    const { automation, packet, persisted } = await fixture();
    const replica = await AutomationReplica.activate(packet, automation);
    const state = JSON.parse(replica.serialize());
    const legacyPlaintext = new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: packet.workspaceId,
      document: state.rawDocument, authorization: { version: 1, records: state.authorizations, authority: state.authority }, chat: state.chat }));
    const legacyObject = await encryptBlindObject(packet.blind.scopeId, packet.blind.keyEpoch,
      decodeBlindBytes(packet.blind.contentKey), legacyPlaintext);
    state.pending = { hash: await blindHash(legacyPlaintext), object: legacyObject };
    const uploads: string[] = [];
    const transport: ReplicaTransport = {
      inventory: async (_access, after) => ({ objects: [], cursor: after, hasMore: false }),
      download: async () => { throw new Error("Unexpected download"); },
      upload: async (access, object) => { uploads.push(await blindObjectId(object)); return signedReceipt(access, object); },
    };
    const restored = await AutomationReplica.restore(JSON.stringify(state), automation, async value => { persisted.push(value); }, transport);
    if (changed) await restored.createLead("changed-legacy-pending", { company: "Acme", role: "Engineer" }, {});
    await restored.sync();
    expect(uploads).toHaveLength(1);
    expect(uploads[0] === await blindObjectId(legacyObject)).toBe(!changed);
    expect(JSON.parse(restored.serialize()).pending).toBeUndefined();
    await restored.sync();
    expect(uploads).toHaveLength(1);
  });

  it("Given an unchanged durable snapshot, when Rusty echoes uploaded objects across polls and Worker restarts, then only one ciphertext is stored", async () => {
    const { automation, packet, persisted } = await fixture();
    const objects: Awaited<ReturnType<typeof encryptBlindObject>>[] = [];
    const transport: ReplicaTransport = {
      inventory: async (_access, after) => ({ objects: await Promise.all(objects.slice(after).map(async (object, index) => ({
        objectId: await blindObjectId(object), sequence: after + index + 1,
      }))), cursor: objects.length, hasMore: false }),
      download: async (_access, id) => {
        for (const object of objects) if (await blindObjectId(object) === id) return object;
        throw new Error("Snapshot missing");
      },
      upload: async (access, object) => { objects.push(object); return signedReceipt(access, object); },
    };
    packet.transport = transport;
    let replica = await AutomationReplica.activate(packet, automation);
    await replica.sync();
    expect(objects).toHaveLength(1);
    const initialState = JSON.parse(replica.serialize());
    for (let poll = 0; poll < 4; poll++) {
      await replica.sync();
      const after = JSON.parse(replica.serialize());
      expect(objects, `Unchanged poll ${poll} must not re-encrypt`).toHaveLength(1);
      expect(after.rawDocument).toBe(initialState.rawDocument);
      expect(after.chat).toEqual(initialState.chat);
      expect(after.authorizations.map((record: { signed: unknown }) => record.signed))
        .toEqual(initialState.authorizations.map((record: { signed: unknown }) => record.signed));
      replica = await AutomationReplica.restore(persisted.at(-1)!, automation, async value => { persisted.push(value); }, transport);
    }
    await replica.createLead("changed-after-polls", { company: "Acme", role: "Engineer" }, {});
    await replica.sync();
    expect(objects).toHaveLength(2);
    await replica.sync();
    expect(objects).toHaveLength(2);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(packet.grant.payload.automation!.expiresAt + 1);
      await expect(replica.sync()).rejects.toThrow("expired");
      expect(objects).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it("Given an owner-authorized snapshot, when a lead and application update are applied, then signed scope admits the same cards", async () => {
    const { automation, packet, persisted } = await fixture();
    packet.initial.chat = { version: 2, capabilities: ["contextual-v2"], messages: [
      { signed: { signature: "opaque-existing-chat-signature", signerKeyId: "device", payload: { kind: "chat-message" } },
        publicKey: "key", certificates: [], authority: {} },
    ], profiles: [], typing: [] };
    const replica = await AutomationReplica.activate(packet, automation);
    expect(JSON.parse(persisted.at(-1)!).chat.messages).toHaveLength(1);
    const created = await replica.createLead("web-event-1", {
      company: "Acme", role: "Backend engineer", jobUrl: "https://jobs.example.test/1", message: "Senior opening",
      sourceText: "Source page and complete Clef probabilities", roleType: "backend", seniority: "senior",
    }, { relevance: "yes", distributions: { job_opportunity: { yes: 0.9, no: 0.05, uncertain: 0.05 } } });
    const lead = replica.candidates().find(candidate => candidate.cardId === created.cardId);
    expect(lead?.columnId).toBe(packet.bindings.columns.lead);
    const moved = await replica.moveCard("mail-event-1", created.cardId, packet.bindings.columns.interview,
      { columnId: packet.bindings.columns.lead, changedAt: lead!.workflow!.changedAt });
    expect(moved.duplicate).toBe(false);
    expect(replica.candidates().find(candidate => candidate.cardId === created.cardId)?.columnId).toBe(packet.bindings.columns.interview);
    expect(persisted.length).toBeGreaterThan(1);
  });

  it("Given malformed chat records, when activating an owner snapshot, then it rejects before persistence", async () => {
    const { automation, packet, persisted } = await fixture();
    const saved = persisted.length;
    packet.initial.chat = { version: 1, messages: [{ signed: { signature: "unsigned-shape" } }], profiles: [], typing: [] };
    await expect(AutomationReplica.activate(packet, automation)).rejects.toThrow("unsigned record");
    expect(persisted).toHaveLength(saved);
  });

  it("Given durable save fails after authoring, when the same event retries, then rejected memory state is rolled back", async () => {
    const { automation, packet } = await fixture();
    let fail = false;
    const originalPersist = packet.persist!;
    packet.persist = async value => {
      if (fail) { fail = false; throw new Error("Durable write failed"); }
      await originalPersist(value);
    };
    const replica = await AutomationReplica.activate(packet, automation);
    fail = true;
    await expect(replica.createLead("persist-retry", { company: "Acme", role: "Engineer" }, { relevance: "yes" }))
      .rejects.toThrow("Durable write failed");
    expect(replica.candidates().some(candidate => candidate.company === "Acme")).toBe(false);
    const retry = await replica.createLead("persist-retry", { company: "Acme", role: "Engineer" }, { relevance: "yes" });
    expect(retry.duplicate).toBe(false);
  });

  it("Given a human moves a card after capture, when synced status automation acts on the stale workflow, then it requires review", async () => {
    const { owner, automation, packet } = await fixture();
    let remoteObject: Awaited<ReturnType<typeof encryptBlindObject>> | undefined;
    let remoteSequence = 0;
    const transport: ReplicaTransport = {
      inventory: async (_access, after) => remoteObject && after < remoteSequence
        ? { objects: [{ objectId: await blindObjectId(remoteObject), sequence: remoteSequence }], cursor: remoteSequence, hasMore: false }
        : { objects: [], cursor: after, hasMore: false },
      download: async (_access, objectId) => {
        if (!remoteObject || objectId !== await blindObjectId(remoteObject)) throw new Error("Remote snapshot missing");
        return remoteObject;
      },
      upload: signedReceipt,
    };
    packet.transport = transport;
    const replica = await AutomationReplica.activate(packet, automation);
    const created = await replica.createLead("stale-mail-lead", { company: "Acme", role: "Engineer" }, { relevance: "yes" });
    const captured = replica.candidates().find(candidate => candidate.cardId === created.cardId)!;
    await replica.sync();

    const serialized = JSON.parse(replica.serialize()) as { rawDocument: string; authorizations: unknown[] };
    const ownerDocument = Automerge.load(decodeBlindBytes(serialized.rawDocument));
    const moved = await executeCommand(ownerDocument, { kind: "moveEntity", entityId: created.cardId,
      parentId: packet.bindings.columns.rejected }, owner, [...decodeBlindBytes(owner.device.deviceId)]
        .map(byte => byte.toString(16).padStart(2, "0")).join(""));
    if (!moved.ok) throw new Error(`Human fixture move failed: ${moved.error.message}`);
    const changeHash = moved.value.receipt.changeHash;
    const signed = await signEnvelope(owner.privateKeys.devicePrivateKey, {
      kind: "workspace-changes" as const, version: 1 as const, workspaceId: packet.workspaceId,
      hashes: [changeHash], personId: owner.identity.personId, deviceId: owner.device.deviceId,
    }, owner.device.deviceId);
    const remoteChat = packet.initial.chat ?? null;
    const snapshot = { version: 1, workspaceId: packet.workspaceId,
      document: encodeBlindBytes(Automerge.save(moved.value.newDoc)),
      authorization: { version: 1, records: [...serialized.authorizations, { signed,
        publicKey: owner.identity.publicKey, certificates: [owner.certificate], ownerPublicKey: owner.identity.publicKey,
        ownerCertificates: [owner.certificate] }], authority: packet.initial.authorization.authority }, chat: remoteChat };
    remoteObject = await encryptBlindObject(packet.blind.scopeId, packet.blind.keyEpoch,
      decodeBlindBytes(packet.blind.contentKey), new TextEncoder().encode(JSON.stringify(snapshot)));
    remoteSequence = 1;
    Automerge.free(ownerDocument);
    Automerge.free(moved.value.newDoc);

    await replica.sync();
    expect(replica.candidates().find(candidate => candidate.cardId === created.cardId)?.columnId)
      .toBe(packet.bindings.columns.rejected);
    await expect(replica.moveCard("stale-mail-event", created.cardId, packet.bindings.columns.interview,
      { columnId: captured.columnId, changedAt: captured.workflow!.changedAt })).rejects.toThrow("workflow changed");
  });

  it("Given a pending encrypted upload, when the Worker restarts, then it persists before upload and retries the same ciphertext", async () => {
    const { automation, packet, persisted } = await fixture();
    let uploadAttempt = 0;
    const uploaded: string[] = [];
    const transport: ReplicaTransport = {
      inventory: async (_access, after) => ({ objects: [], cursor: after, hasMore: false }),
      download: async () => { throw new Error("Unexpected download"); },
      upload: async (access, object) => {
        const saved = JSON.parse(persisted.at(-1)!) as { pending?: { object: unknown } };
        expect(saved.pending?.object).toEqual(object);
        uploaded.push(await blindObjectId(object));
        uploadAttempt += 1;
        if (uploadAttempt === 1) throw new Error("Response lost after durable save");
        return signedReceipt(access, object);
      },
    };
    packet.transport = transport;
    const replica = await AutomationReplica.activate(packet, automation);
    await replica.createLead("web-event-2", { company: "Acme", role: "Engineer" }, { relevance: "yes" });
    await expect(replica.sync()).rejects.toThrow("Response lost");
    const stateAfterLoss = replica.serialize();
    expect(JSON.parse(stateAfterLoss)).toHaveProperty("pending.object");
    const restored = await AutomationReplica.restore(stateAfterLoss, automation, async value => { persisted.push(value); }, transport);
    await restored.sync();
    expect(uploaded[0]).toBe(uploaded[1]);
    expect(JSON.parse(restored.serialize()).pending).toBeUndefined();
  });
});

it("Given owner employee_profile and job priority settings, when intake is authored and restored, then profile and complete Clef assessment produce the same board priority", async () => {
  const { projectWorkspaceSettings } = await import("../../../src/domain/workspaceSettings");
  const { createDefaultPriorityPolicy, projectItemPriority } = await import("../../../src/domain/priority");
  const { classifyOpportunity } = await import("../src/clef");
  const { hasEntityKind, isItem } = await import("../../../src/domain/model");
  const data = await fixture();
  const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(data.packet.initial.document));
  const board = document.entities[data.packet.bindings.boardId];
  if (!hasEntityKind(board, "board")) throw new Error("Missing board");
  const settings = projectWorkspaceSettings(document, board.id);
  const profile = { stack: "Ruby, PostgreSQL", work_profile: "Senior Software Engineer, Product Engineer, AI / Founding Engineer" };
  settings.board.employee_profile = profile;
  settings.board.priorityPolicy = createDefaultPriorityPolicy(board, Object.values(document.entities).filter(entity => hasEntityKind(entity, "field")));
  const updated = await executeCommand(document, { kind: "updateWorkspaceSettings", settings }, data.owner);
  if (!updated.ok) throw new Error(updated.error.message);
  data.packet.initial = await ownerSnapshot(updated.value.newDoc, data.owner, data.packet);
  Automerge.free(document); Automerge.free(updated.value.newDoc);
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  expect(replica.employeeProfileForRuntime()).toEqual(profile);
  const decision = await classifyOpportunity({ run: async (_model, input) => {
    const request = input as { state: { employee_profile: unknown }; questions: Record<string, { criteria: Record<string, string> }> };
    expect(request.state.employee_profile).toEqual(profile);
    return { answers: Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
      const choice = key === "job_opportunity" ? "yes" : key === "role_type" ? "backend" : key === "seniority" ? "senior" : "strong";
      return [key, { type: "choice", choice, confidence: 1,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map(label => [label, label === choice ? 1 : 0])) }];
    })) };
  } }, "Senior product vacancy", replica.employeeProfileForRuntime(), replica.priorityBandsForRuntime());
  const created = await replica.createLead("assessed-intake", { company: "Acme", role: "Senior engineer",
    message: "Long vacancy ".repeat(1000), sourceText: "Long extraction ".repeat(1000) }, decision);
  const restored = await AutomationReplica.restore(replica.serialize(), data.automation, async () => {});
  expect(restored.employeeProfileForRuntime()).toEqual(profile);
  const stored = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(JSON.parse(restored.serialize()).rawDocument));
  try {
    const storedBoard = stored.entities[data.packet.bindings.boardId];
    const item = stored.entities[created.cardId];
    if (!hasEntityKind(storedBoard, "board") || !isItem(item)) throw new Error("Missing authored item");
    expect(projectItemPriority(storedBoard, item).values).toMatchObject({
      [storedBoard.priorityPolicy!.priorityFieldId]: decision.priority.optionId,
      [storedBoard.priorityPolicy!.fitFieldId!]: decision.priority.score,
    });
    expect(decision.priority.score).toBe(10);
    expect(JSON.parse(String(item.values[data.packet.bindings.fieldIds.sourceText!])).decision.assessment).toEqual(decision.assessment);
  } finally { Automerge.free(stored); }
});
