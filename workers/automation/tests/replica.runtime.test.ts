import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import worker, { type WorkerEnv } from "../src/index";
import { receiptAi } from "./receiptFixture";
import * as Automerge from "@automerge/automerge/slim";
import automergeWasm from "@automerge/automerge/automerge.wasm";
import { initSync, WasmStateCore } from "@meta-uber/mesh-transport/wasm";
import { profileFromIdentitySeedForDevice, signEnvelope } from "../../../vendor/meta-mesh/packages/mesh-identity/src/index";
import { createWorkspaceDoc } from "../../../src/domain/seeds";
import { createAutomationWorkspaceGrant } from "../../../src/domain/proofs";
import { executeCommand as executeCommandWithoutSigningContext } from "../../../src/domain/commands";
import { blindHash, blindObjectId, canonicalBlindJson, type BlindReceipt } from "../../../src/sync/blindClient";
import { decodeBlindBytes, decryptBlindObject, encodeBlindBytes, encryptBlindObject } from "../../../src/sync/blindEnvelope";
import { AutomationReplica, type AutomationActivationPacket, type ReplicaTransport } from "../src/replica";
import { automationTypes, parseAutomationDefinition } from "../../../src/domain/automationContract";
import { automationEntityId } from "../../../src/domain/automationLifecycle";
import { isItem, type WorkspaceDocumentV2 } from "../../../src/domain/model";
import { planApplicationMove } from "../src/applicationMove";
import type { ApplicationBindingProof } from "../../../src/domain/applicationBinding";
import { createWorkspaceDeviceRevocation, createWorkspaceOwnershipTransfer } from "../../../vendor/meta-mesh/packages/mesh-workspace/src/index";
import { applicationBindingEventHash, hashApplicationBindingDecision } from "../src/applicationBindingEvidence";
import { readApplicationBindingAudit, readApplicationBindingHistory } from "../src/applicationBindingStore";
import { CLEF_MODEL, APPLICATION_EVENT_POLICY_VERSION } from "../src/clef";
import type { AutomationEvent } from "../src/pipeline";
import { automationBodyHash } from "../../../src/domain/automationProtocol";
import { createApplicationReviewRequest, type ApplicationReviewRequestInput } from "../../../src/domain/applicationReviewProtocol";
import { createAutomationInstanceRequest, type AutomationInstanceAction } from "../../../src/domain/automationInstanceProtocol";
import { verifyAutomationInstanceIdentity } from "../../../src/domain/automationInstanceIdentity";
import { createApplicationBinding, type ApplicationBindingInput } from "../../../src/domain/applicationBinding";
import { resolveSigningContext } from "../../../src/domain/signingContext";
import { parseApplicationReviewMailbox, parseApplicationReviewResponse } from "../../../src/domain/applicationReviewData";
import { verifyAutomationObservation } from "../../../src/domain/automationProtocol";
import type { AttachmentLocator } from "../../../src/sync/attachmentCodec";

async function executeCommand(...args: Parameters<typeof executeCommandWithoutSigningContext>) {
  const [doc, command, profile, actorId, authorityGrantHash] = args;
  const authorityRevision = `runtime-fixture:${profile.identity.personId}:${profile.device.deviceId}`;
  return executeCommandWithoutSigningContext(doc, command, profile, actorId, authorityGrantHash,
    (purpose, binding) => resolveSigningContext({ profile, certificates: [profile.certificate], purpose, binding,
      authorityRevision, current: async () => ({ personId: profile.identity.personId, deviceId: profile.device.deviceId,
        authorityRevision }) }));
}

await Automerge.initializeWasm(automergeWasm as unknown as Uint8Array);

async function bindingFixture(integrationId = "legacy-routing-id") {
  const data = await typedFixture(undefined, true, 2);
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  const created = await replica.createLead("binding-original", { company: "Upvest", role: "Display label",
    source: { origin: "website" } }, {}, data.packet.bindings.columns.applied);
  const sourceRecordId = replica.candidates().find(candidate => candidate.cardId === created.cardId)!.sources![0]!.recordId;
  const event = { origin: "https://automation.example.test", integrationId, eventId: "A".repeat(43),
    eventHash: "B".repeat(43), decisionHash: "C".repeat(43) };
  const scope = await replica.bindingScopeForRuntime(event.origin, created.cardId, sourceRecordId);
  const payload = { kind: "automation-application-binding" as const, version: 1 as const, bindingId: crypto.randomUUID(),
    previousBindingId: null, ...scope, ...event, personId: data.owner.identity.personId, deviceId: data.owner.device.deviceId,
    issuedAt: Date.now() };
  const signedPayload = { ...payload };
  Reflect.deleteProperty(signedPayload, "ownerPersonId");
  const proof: ApplicationBindingProof = { publicKey: data.owner.identity.publicKey, certificates: [data.owner.certificate],
    signed: await signEnvelope(data.owner.privateKeys.devicePrivateKey, signedPayload, data.owner.device.deviceId) };
  return { data, replica, event, proof, cardId: created.cardId };
}

const reviewOrigin = "https://automation.example.test";
const reviewStorageSecret = "test-only-application-review-storage-secret-at-least-thirty-two-bytes";

async function signedReviewRequest(profile: Awaited<ReturnType<typeof fixture>>["owner"],
  action: ApplicationReviewRequestInput["action"], body: Record<string, unknown>, integrationId: string | null = null,
  origin = reviewOrigin) {
  const workspaceId = String(body.workspaceId);
  const definitionId = String(body.definitionId);
  const bodyHash = await automationBodyHash(body);
  const context = await resolveSigningContext({ profile, certificates: [], purpose: "automation-application-review-request",
    authorityRevision: "runtime-review-test", binding: { action, origin, workspaceId, definitionId, bodyHash,
      ...(integrationId ? { integrationId } : {}) },
    current: async () => ({ personId: profile.identity.personId, deviceId: profile.device.deviceId,
      authorityRevision: "runtime-review-test" }) });
  return createApplicationReviewRequest(context, { action, origin, workspaceId, definitionId, integrationId, bodyHash });
}

async function signedInstanceRequest(profile: Awaited<ReturnType<typeof fixture>>["owner"], action: AutomationInstanceAction,
  body: Record<string, unknown>, integrationId: string | null = null, origin = reviewOrigin) {
  const workspaceId = String(body.workspaceId);
  const definitionId = String(body.definitionId);
  const executorPersonId = String(body.executorPersonId);
  const bodyHash = await automationBodyHash(body);
  const binding = { action, origin, workspaceId, definitionId, executorPersonId, bodyHash,
    ...(integrationId === null ? {} : { integrationId }) };
  const context = await resolveSigningContext({ profile, certificates: [], purpose: "automation-instance-request",
    authorityRevision: "runtime-instance-test", binding, current: async () => ({ personId: profile.identity.personId,
      deviceId: profile.device.deviceId, authorityRevision: "runtime-instance-test" }) });
  return createAutomationInstanceRequest(context, { action, origin, workspaceId, definitionId, integrationId,
    executorPersonId, bodyHash });
}

async function postApplicationReview(action: ApplicationReviewRequestInput["action"], requestProof: unknown,
  body: Record<string, unknown>, testEnv: WorkerEnv) {
  return worker.fetch(new Request(`${reviewOrigin}/v2/application-review/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewRequest: requestProof, body }),
  }), testEnv);
}

async function postAutomationInstance(action: AutomationInstanceAction, instanceRequest: unknown,
  body: Record<string, unknown>, testEnv: WorkerEnv) {
  return worker.fetch(new Request(`${reviewOrigin}/v2/automation-instances/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instanceRequest, body }),
  }), testEnv);
}

it("Given a live Worker with a pending signed action, When its Owner refreshes confirmed Rusty access over HTTP, Then preserve exact queue and grant and return nonce-bound storage evidence", async () => {
  const integrationId = `refresh-${crypto.randomUUID().replace(/-/g, "")}`;
  const data = await typedFixture(undefined, true, 2);
  const transport: ReplicaTransport = { inventory: async (_access, after) => ({ objects: [], cursor: after, hasMore: false }),
    download: async () => { throw new Error("No maintenance download expected"); },
    upload: async () => { throw new Error("Upload accepted but reply lost"); } };
  data.packet.transport = transport;
  const original = await AutomationReplica.activate(data.packet, data.automation);
  await original.createLead("retained-before-access-refresh", { company: "Acme", role: "Engineer", source: { origin: "website" } }, {});
  await expect(original.sync()).rejects.toThrow("reply lost");
  const serialized = original.serialize();
  const before = JSON.parse(serialized);
  expect(before.pending).toBeDefined();
  const testEnv = reviewEnvironment(integrationId, data.packet.workspaceId, data.packet.bindings);
  const stub = testEnv.AUTOMATION.getByName(integrationId);
  await stub.saveReplicaState(reviewStorageSecret, serialized);
  await runInDurableObject(stub, async instance => {
    Reflect.set(instance, "env", testEnv);
    Reflect.set(instance, "managementInspectorNow", async () => ({ profile: data.automation,
      inspector: await AutomationReplica.inspectForManagement((await instance.loadReplicaState(reviewStorageSecret))!,
        data.automation, next => instance.saveReplicaState(reviewStorageSecret, next), transport) }));
  });
  const signer = await receiptSigner();
  const policy = { kind: "rusty-scope-policy-receipt" as const, version: 1 as const, serviceId: signer.serviceId,
    scopeId: before.blind.scopeId, personId: data.owner.identity.personId, revision: 2, revoked: false,
    challengeId: "floor-confirmed", authorizationHash: "A".repeat(43), minimumWriterVersion: 2 as const };
  const receipt = { payload: policy, signerKeyId: signer.serviceId, signature: encodeBlindBytes(new Uint8Array(
    await crypto.subtle.sign("Ed25519", signer.pair.privateKey,
      new TextEncoder().encode(`RUSTY/2/${policy.kind}\0${canonicalBlindJson(policy)}`)))) };
  const body = { workspaceId: data.packet.workspaceId, definitionId: "typed-intake", executorPersonId: data.automation.identity.personId,
    integrationId, storage: { origin: before.blind.origin, scopeId: before.blind.scopeId, keyEpoch: before.blind.keyEpoch,
      servicePublicKey: before.blind.servicePublicKey }, receipt };
  const invalid = { ...body, receipt: { ...receipt, payload: { ...policy, revision: 99 } } };
  const denied = await postAutomationInstance("refresh-access", await signedInstanceRequest(data.owner, "refresh-access", invalid, integrationId), invalid, testEnv);
  expect(denied.status).toBe(422);
  expect(await stub.loadReplicaState(reviewStorageSecret)).toBe(serialized);
  const proof = await signedInstanceRequest(data.owner, "refresh-access", body, integrationId);
  const response = await postAutomationInstance("refresh-access", proof, body, testEnv);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  const publicProof = await response.json();
  const observed = await verifyAutomationInstanceIdentity(publicProof, { origin: reviewOrigin, workspaceId: body.workspaceId,
    definitionId: body.definitionId, integrationId, executorPersonId: body.executorPersonId, requestNonce: proof.signed.payload.nonce });
  expect(observed.description.storage).toEqual({ ...body.storage, policyRevision: 2, minimumWriterVersion: 2 });
  expect(JSON.stringify(publicProof)).not.toContain("contentKey");
  const after = JSON.parse((await stub.loadReplicaState(reviewStorageSecret))!);
  expect(after.pending).toEqual(before.pending);
  expect(after.applied).toEqual(before.applied);
  expect(after.grant).toEqual(before.grant);
  expect(after.definition).toEqual(before.definition);
  expect(after.rawDocument).toBe(before.rawDocument);
  expect(after.blind).toEqual({ ...before.blind, policyRevision: 2, minimumWriterVersion: 2 });
  const repeated = await postAutomationInstance("refresh-access", proof, body, testEnv);
  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toEqual(publicProof);
  expect(JSON.parse((await stub.loadReplicaState(reviewStorageSecret))!).pending).toEqual(before.pending);
  const upload = vi.fn(async (access, object, requestId) => signedReceipt(access, object, requestId));
  const resumed = await AutomationReplica.restore((await stub.loadReplicaState(reviewStorageSecret))!, data.automation,
    next => stub.saveReplicaState(reviewStorageSecret, next), { ...transport, upload });
  await resumed.sync();
  expect(upload).toHaveBeenCalledTimes(1);
  expect(upload.mock.calls[0]![0].policyRevision).toBe(2);
  expect(upload.mock.calls[0]![1]).toEqual(before.pending.object);
  expect(upload.mock.calls[0]![2]).toBe(before.pending.requestId);
  expect((await resumed.createLead("retained-before-access-refresh", { company: "Acme", role: "Engineer" }, {})).duplicate).toBe(true);
  await runInDurableObject(stub, async (_instance, ctx) => { await ctx.storage.deleteAlarm(); });
});

it.each([false, true])("Given an existing executor with legacy=%s, When Owner confirms its new approval over HTTP, Then preserve routing and atomically update the same instance", async legacy => {
  const integrationId = `managed-${crypto.randomUUID().replace(/-/g, "")}`;
  const data = legacy ? await fixture() : await typedFixture();
  const oldReplica = await AutomationReplica.activate(data.packet, data.automation);
  const initial = oldReplica.serialize();
  const oldExpiry = data.packet.grant.payload.automation!.expiresAt;
  const grant = await createAutomationWorkspaceGrant(data.owner, data.packet.workspaceId, data.automation.identity.personId,
    { ...data.packet.grant.payload.automation!, version: 2, expiresAt: oldExpiry + 120_000 });
  const definitionPayload = parseAutomationDefinition({ kind: "automation-definition", version: 1, id: "typed-intake",
    name: "Job intake", type: "job-intake", typeVersion: 2, parameters: { sources: ["website", "email"] },
    permissions: automationTypes.find(type => type.version === 2)!.permissions,
    scope: { workspaceId: data.packet.workspaceId, boardId: data.packet.bindings.boardId, grantId: grant.payload.grantId } });
  const definition = await signEnvelope(data.owner.privateKeys.devicePrivateKey, definitionPayload, data.owner.device.deviceId);
  const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(data.packet.initial.document));
  const configured = await executeCommand(document, legacy ? { kind: "createAutomation", definition: definitionPayload,
    approval: JSON.stringify({ definition, grant }), executor: { origin: reviewOrigin, personId: data.automation.identity.personId } }
    : { kind: "configureAutomation", definition: definitionPayload, approval: JSON.stringify({ definition, grant }) }, data.owner);
  if (!configured.ok) throw new Error(configured.error.message);
  const packet = { ...data.packet, version: 2, definition, grant,
    initial: await ownerSnapshot(configured.value.newDoc, data.owner, data.packet) };
  Reflect.deleteProperty(packet, "persist");
  Automerge.free(document); Automerge.free(configured.value.newDoc);
  const testEnv = { ...reviewEnvironment(integrationId, data.packet.workspaceId, data.packet.bindings), AUTOMATION_OWNER_IDS: "" };
  const routing = JSON.parse(testEnv.INTEGRATIONS_JSON)[0];
  const transport: ReplicaTransport = { inventory: async (_access, after) => ({ objects: [], cursor: after, hasMore: false }),
    download: async () => { throw new Error("No management download expected"); }, upload: async () => { throw new Error("No management upload permitted"); } };
  const stub = testEnv.AUTOMATION.getByName(integrationId);
  await runInDurableObject(stub, async (instance, ctx) => {
    Reflect.set(instance, "env", testEnv);
    Reflect.set(instance, "managementInspectorNow", async () => ({ profile: data.automation,
      inspector: await AutomationReplica.inspectForManagement(await instance.loadReplicaState(reviewStorageSecret) ?? initial,
        data.automation, value => instance.saveReplicaState(reviewStorageSecret, value), transport) }));
    ctx.storage.sql.exec("INSERT INTO automation_registration (singleton, owner_id, workspace_id, integration_id, routing) VALUES (1, ?, ?, ?, ?)",
      "obsolete-registration-owner", data.packet.workspaceId, integrationId, JSON.stringify(routing));
  });
  const sync = vi.spyOn(AutomationReplica.prototype, "sync").mockResolvedValue();
  vi.useFakeTimers(); vi.setSystemTime(oldExpiry + 1);
  try {
    const body = { workspaceId: data.packet.workspaceId, definitionId: "typed-intake", executorPersonId: data.automation.identity.personId,
      integrationId, packet, adoptLegacy: legacy };
    if (legacy) {
      const unconfirmed = { ...body, adoptLegacy: false };
      const denied = await postAutomationInstance("activate", await signedInstanceRequest(data.owner, "activate", unconfirmed, integrationId), unconfirmed, testEnv);
      expect(denied.status).toBe(422);
      await runInDurableObject(stub, async instance => { expect(await instance.loadReplicaState(reviewStorageSecret)).toBeNull(); });
    }
    const proof = await signedInstanceRequest(data.owner, "activate", body, integrationId);
    const response = await postAutomationInstance("activate", proof, body, testEnv);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(await response.json()).toEqual({ status: "active", synced: true });
    await runInDurableObject(stub, async (instance, ctx) => {
      const stored = JSON.parse((await instance.loadReplicaState(reviewStorageSecret))!);
      expect(stored.definition.payload.id).toBe("typed-intake");
      expect(stored.grant.payload.grantId).toBe(grant.payload.grantId);
      expect(await instance.getRegisteredIntegration()).toMatchObject({ id: integrationId, emailAddress: routing.emailAddress,
        allowedForwarders: routing.allowedForwarders, scope: { expiresAt: new Date(grant.payload.automation!.expiresAt).toISOString() } });
      expect(ctx.storage.sql.exec<{ owner_id: string }>("SELECT owner_id FROM automation_registration WHERE singleton = 1").one().owner_id)
        .toBe(data.owner.identity.personId);
      await ctx.storage.deleteAlarm();
    });
    expect((await postAutomationInstance("activate", proof, body, testEnv)).status).toBe(200);
    expect(sync).toHaveBeenCalledTimes(1);
  } finally { sync.mockRestore(); vi.useRealTimers(); }
});

it("Given retained unbound mail on a legacy route, When the owner retries it, Then enqueue once and reject bound events", async () => {
  const integrationId = `legacy-${crypto.randomUUID().replace(/-/g, "")}`;
  const { data, replica, proof: templateProof } = await bindingFixture(integrationId);
  const baseEnv = reviewEnvironment(integrationId, data.packet.workspaceId, data.packet.bindings);
  const privateAddress = `jobs-${crypto.randomUUID().replace(/-/g, "")}@inbox.example.test`;
  const testEnv = { ...baseEnv, EMAIL_ROUTES_JSON: JSON.stringify([{ id: integrationId, address: privateAddress,
    mailbox: "owner@example.test" }]) } as WorkerEnv;
  const stub = (env as WorkerEnv).AUTOMATION.getByName(integrationId);
  await runInDurableObject(stub, async instance => {
    Reflect.set(instance, "env", testEnv);
    Reflect.set(instance, "refreshReplica", async () => replica);
  });

  const decisionEvidence = { event: "rejection" as const,
    distributions: { application_event: { type: "choice" as const, choice: "rejected" as const, confidence: 1,
      probabilities: Object.fromEntries(["applied", "new_opportunity", "interview", "rejected", "offer", "follow_up", "unrelated", "uncertain"]
        .map(label => [label, label === "rejected" ? 1 : 0])) } }, model: CLEF_MODEL, policyVersion: APPLICATION_EVENT_POLICY_VERSION };
  const { decision, decisionHash } = await hashApplicationBindingDecision(decisionEvidence);
  async function retainEmail(subject: string) {
    const mime = `From: hiring@example.test\r\nTo: owner@example.test\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${crypto.randomUUID()}@example.test>\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\nRetained application message.`;
    const messageId = mime.match(/Message-ID: ([^\r\n]+)/i)![1]!;
    const eventId = await blindHash(new TextEncoder().encode(`${integrationId}:email:${messageId}`));
    await worker.email({ from: "forwarder@anywhere.test", to: privateAddress, rawSize: new TextEncoder().encode(mime).byteLength,
      raw: new Response(mime).body!, setReject: (reason: string) => { throw new Error(reason); } } as ForwardableEmailMessage, testEnv);
    await runInDurableObject(stub, async (instance, ctx) => {
      Reflect.set(instance, "env", testEnv);
      Reflect.set(instance, "refreshReplica", async () => replica);
      ctx.storage.sql.exec("UPDATE events SET status = 'review', result = ? WHERE event_id = ?",
        JSON.stringify({ status: "review", reason: "Owner review required", decision }), eventId);
    });
    return eventId;
  }

  const unboundEventId = await retainEmail("Unbound retained application");
  const boundEventId = await retainEmail("Already bound application");
  await runInDurableObject(stub, async (instance, ctx) => {
    Reflect.set(instance, "env", testEnv);
    Reflect.set(instance, "refreshReplica", async () => replica);
    const row = ctx.storage.sql.exec<{ event_id: string; source_id: string; body_hash: string; payload: string }>(
      "SELECT * FROM events WHERE event_id = ?", boundEventId).one();
    const [nonce, ciphertext] = row.payload.split(".");
    const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`TIN/event-key/v1/${reviewStorageSecret}`));
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    const event = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM",
      iv: decodeBlindBytes(nonce!), additionalData: new TextEncoder().encode(`TIN/event-payload/v1/${boundEventId}`) }, key,
    decodeBlindBytes(ciphertext!)))) as Extract<AutomationEvent, { source: "email" }>;
    const eventHash = await applicationBindingEventHash(integrationId, data.packet.workspaceId,
      { eventId: boundEventId, sourceId: row.source_id, bodyHash: row.body_hash }, event);
    const signedPayload = { ...templateProof.signed.payload, eventId: boundEventId, eventHash, decisionHash, issuedAt: Date.now() };
    const bindingProof: ApplicationBindingProof = { ...templateProof, signed: await signEnvelope(
      data.owner.privateKeys.devicePrivateKey, signedPayload, data.owner.device.deviceId) };
    await expect(instance.bindEmailApplication(bindingProof, reviewOrigin)).resolves.toMatchObject({ duplicate: false });
  });

  const body = { workspaceId: data.packet.workspaceId, definitionId: "typed-intake", integrationId, eventId: unboundEventId };
  const requestProof = await signedReviewRequest(data.owner, "retry-unbound", body, integrationId);
  const firstResponse = await postApplicationReview("retry-unbound", requestProof, body, testEnv);
  expect(firstResponse.status).toBe(200);
  const firstResult = await firstResponse.json();
  expect(firstResult).toMatchObject({ eventId: unboundEventId, status: "pending", duplicate: false });
  const replay = await postApplicationReview("retry-unbound", requestProof, body, testEnv);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(firstResult);

  const changedBody = { ...body, eventId: boundEventId };
  expect((await postApplicationReview("retry-unbound", requestProof, changedBody, testEnv)).status).toBe(401);
  expect((await postApplicationReview("review", requestProof, body, testEnv)).status).toBe(401);
  const boundRequest = await signedReviewRequest(data.owner, "retry-unbound", changedBody, integrationId);
  expect((await postApplicationReview("retry-unbound", boundRequest, changedBody, testEnv)).status).not.toBe(200);
  await runInDurableObject(stub, async (instance, ctx) => {
    Reflect.set(instance, "env", testEnv);
    Reflect.set(instance, "refreshReplica", async () => replica);
    expect(instance.getEvent(unboundEventId)?.status).toBe("pending");
    expect(instance.getEvent(boundEventId)?.status).toBe("review");
    await ctx.storage.deleteAlarm();
  });
});

function reviewEnvironment(integrationId: string, workspaceId: string, bindings: AutomationActivationPacket["bindings"]): WorkerEnv {
  return { ...env, EVENT_STORAGE_SECRET: reviewStorageSecret, IDENTITY_STORAGE_SECRET: "test-only-review-identity-secret-with-at-least-thirty-two-bytes", AI: receiptAi, PUBLIC_ORIGIN: reviewOrigin,
    INTEGRATIONS_JSON: JSON.stringify([{ id: integrationId, workspaceId,
      scope: { version: 1, ...bindings, expiresAt: "2099-01-01T00:00:00.000Z" },
      emailAddress: `${integrationId}@example.test`, allowedForwarders: ["owner@example.test"] }]) } as WorkerEnv;
}

it("Given a current owner and configured legacy route, When requesting discovery, Then report the typed definition separately from its integration ID", async () => {
  const integrationId = `legacy-${crypto.randomUUID().replace(/-/g, "")}`;
  const { data, replica } = await bindingFixture(integrationId);
  const testEnv = reviewEnvironment(integrationId, data.packet.workspaceId, data.packet.bindings);
  const stub = (env as WorkerEnv).AUTOMATION.getByName(integrationId);
  await runInDurableObject(stub, async instance => {
    Reflect.set(instance, "env", testEnv);
    Reflect.set(instance, "refreshReplica", async () => replica);
  });
  const body = { workspaceId: data.packet.workspaceId, definitionId: "typed-intake" };
  const requestProof = await signedReviewRequest(data.owner, "discover", body);
  const response = await postApplicationReview("discover", requestProof, body, testEnv);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ origin: reviewOrigin, workspaceId: data.packet.workspaceId,
    definitionId: "typed-intake", integrations: [{ integrationId, personId: data.automation.identity.personId }] });
  const wrongOriginProof = await signedReviewRequest(data.owner, "discover", body, null, "https://other.example.test");
  expect((await postApplicationReview("discover", wrongOriginProof, body, testEnv)).status).toBe(401);
  const wrongWorkspace = { ...body, workspaceId: "another-workspace" };
  const wrongWorkspaceProof = await signedReviewRequest(data.owner, "discover", wrongWorkspace);
  expect((await postApplicationReview("discover", wrongWorkspaceProof, wrongWorkspace, testEnv)).status).not.toBe(200);
  const otherOwnerRequest = await signedReviewRequest(data.automation, "discover", body);
  const denied = await postApplicationReview("discover", otherOwnerRequest, body, testEnv);
  expect(denied.status).toBe(403);
});

it("Given an expired typed instance behind a legacy route, When its Owner discovers and reads identity, Then return a signed scoped description without provisioning or upload", async () => {
  const integrationId = `legacy-${crypto.randomUUID().replace(/-/g, "")}`;
  const data = await typedFixture();
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  const priorSerialized = replica.serialize();
  const priorExpiry = data.packet.grant.payload.automation!.expiresAt;
  const persist = vi.fn<(serialized: string) => Promise<void>>(async () => {});
  let revokedObject: Awaited<ReturnType<typeof encryptBlindObject>> | undefined;
  const inventory = vi.fn(async (_access: unknown, after: number) => revokedObject && after < 1
    ? { objects: [{ objectId: await blindObjectId(revokedObject), sequence: 1 }], cursor: 1, hasMore: false }
    : { objects: [], cursor: after, hasMore: false });
  const download = vi.fn(async () => {
    if (!revokedObject) throw new Error("Unexpected download before revocation publication");
    return revokedObject;
  });
  const upload = vi.fn(async () => { throw new Error("Management reads must not upload"); });
  const inspector = await AutomationReplica.inspectForManagement(priorSerialized, data.automation, persist,
    { inventory, download, upload } as unknown as ReplicaTransport);
  const baseEnv = reviewEnvironment(integrationId, data.packet.workspaceId, data.packet.bindings);
  const testEnv = { ...baseEnv, AUTOMATION_OWNER_IDS: "" } as WorkerEnv;
  const stub = (env as WorkerEnv).AUTOMATION.getByName(integrationId);
  await runInDurableObject(stub, async instance => {
    Reflect.set(instance, "env", testEnv);
    Reflect.set(instance, "managementInspectorNow", async () => ({ profile: data.automation, inspector }));
    Reflect.set(instance, "provisionIdentity", vi.fn(async () => { throw new Error("Management discovery must not create identity"); }));
  });

  vi.useFakeTimers();
  vi.setSystemTime(priorExpiry + 1);
  try {
    await expect(AutomationReplica.restore(priorSerialized, data.automation, async () => {})).rejects.toThrow(/expired/i);
    const capabilityResponse = await worker.fetch(new Request(`${reviewOrigin}/v2/capabilities`), testEnv);
    expect(capabilityResponse.status).toBe(200);
    expect(await capabilityResponse.json()).toMatchObject({ instanceManagement: {
      version: 1, actions: expect.arrayContaining(["discover", "identity", "activate"]),
    } });

    const executorPersonId = data.automation.identity.personId;
    const discoveryBody = { workspaceId: data.packet.workspaceId, definitionId: "typed-intake", executorPersonId };
    const discoveryRequest = await signedInstanceRequest(data.owner, "discover", discoveryBody);
    const discoveryResponse = await postAutomationInstance("discover", discoveryRequest, discoveryBody, testEnv);
    expect(discoveryResponse.status).toBe(200);
    expect(await discoveryResponse.json()).toMatchObject({ origin: reviewOrigin, ...discoveryBody,
      integrations: [{ integrationId }] });

    const identityBody = { ...discoveryBody, integrationId };
    const identityRequest = await signedInstanceRequest(data.owner, "identity", identityBody, integrationId);
    const identityResponse = await postAutomationInstance("identity", identityRequest, identityBody, testEnv);
    expect(identityResponse.status).toBe(200);
    const identityProof = await identityResponse.json();
    const exactReplay = await postAutomationInstance("identity", identityRequest, identityBody, testEnv);
    expect(exactReplay.status).toBe(200);
    expect(await exactReplay.json()).toEqual(identityProof);
    const strangerRequest = await signedInstanceRequest(data.automation, "discover", discoveryBody);
    const strangerDiscovery = await postAutomationInstance("discover", strangerRequest, discoveryBody, testEnv);
    expect(strangerDiscovery.status).toBe(200);
    expect(await strangerDiscovery.json()).toMatchObject({ integrations: [] });
    const unknownBody = { ...discoveryBody, definitionId: "unknown-definition" };
    const unknownRouteId = testEnv.AUTOMATION.getByName(unknownBody.definitionId);
    const provisionUnknown = vi.fn(async () => { throw new Error("Read-only discovery must not provision an executor"); });
    await runInDurableObject(unknownRouteId, instance => { Reflect.set(instance, "provisionIdentity", provisionUnknown); });
    const unknownRequest = await signedInstanceRequest(data.owner, "discover", unknownBody);
    const unknownDiscovery = await postAutomationInstance("discover", unknownRequest, unknownBody, testEnv);
    expect(unknownDiscovery.status).toBe(200);
    expect(await unknownDiscovery.json()).toMatchObject({ integrations: [] });
    expect(provisionUnknown).not.toHaveBeenCalled();
    const wrongOriginRequest = await signedInstanceRequest(data.owner, "discover", discoveryBody, null, "https://other.example.test");
    expect((await postAutomationInstance("discover", wrongOriginRequest, discoveryBody, testEnv)).status).toBe(401);
    const substitutedBody = { ...identityBody, integrationId: `${integrationId}-other` };
    expect((await postAutomationInstance("identity", identityRequest, substitutedBody, testEnv)).status).toBe(401);
    const identity = await verifyAutomationInstanceIdentity(identityProof, { origin: reviewOrigin, workspaceId: data.packet.workspaceId,
      definitionId: "typed-intake", integrationId, executorPersonId,
      requestNonce: (identityRequest as { signed: { payload: { nonce: string } } }).signed.payload.nonce });
    expect(identity.description).toMatchObject({ workspaceId: data.packet.workspaceId,
      boardId: data.packet.bindings.boardId, definitionId: "typed-intake", executorPersonId,
      grantId: data.packet.grant.payload.grantId, expiresAt: priorExpiry, adoptionRequired: false });
    expect(identity.description.expiresAt).toBeLessThan(Date.now());
    expect((identityProof as { signed: { signerKeyId: string } }).signed.signerKeyId).toBe(data.automation.device.deviceId);
    expect(persist).not.toHaveBeenCalled();

    const revocationDocument = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(data.packet.initial.document));
    const revocation = await createWorkspaceDeviceRevocation(data.owner, data.packet.workspaceId,
      data.owner.identity.personId, data.owner.device.deviceId, Automerge.getHeads(revocationDocument), [data.owner.certificate]);
    Automerge.free(revocationDocument);
    const revokedSnapshot = structuredClone(data.packet.initial);
    revokedSnapshot.authorization.authority.deviceRevocations.push({ record: revocation.record, signer: revocation.authority });
    revokedObject = await encryptBlindObject(data.packet.blind.scopeId, data.packet.blind.keyEpoch, data.key,
      new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: data.packet.workspaceId, ...revokedSnapshot })));
    expect((await postAutomationInstance("identity", identityRequest, identityBody, testEnv)).status).toBe(403);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(inventory).toHaveBeenCalledTimes(4);
    expect(download).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("Given a current owner and retained mailbox events, When listing, Then return private route, capped history and a verified executor observation", async () => {
  const integrationId = `legacy-${crypto.randomUUID().replace(/-/g, "")}`;
  const { data, replica: originalReplica, proof: templateProof } = await bindingFixture(integrationId);
  let activeReplica = originalReplica;
  const baseEnv = reviewEnvironment(integrationId, data.packet.workspaceId, data.packet.bindings);
  const privateAddress = `jobs-${crypto.randomUUID().replace(/-/g, "")}@inbox.example.test`;
  const testEnv = { ...baseEnv, EMAIL_ROUTES_JSON: JSON.stringify([{ id: integrationId, address: privateAddress,
    mailbox: "owner@example.test" }]) } as WorkerEnv;
  const stub = (env as WorkerEnv).AUTOMATION.getByName(integrationId);
  await runInDurableObject(stub, async instance => {
    Reflect.set(instance, "env", testEnv);
    Reflect.set(instance, "refreshReplica", async () => activeReplica);
  });

  const longSubject = `Application update ${"S".repeat(700)}`;
  const mime = `From: hiring@example.test\r\nTo: owner@example.test\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <list-${crypto.randomUUID()}@example.test>\r\nSubject: ${longSubject}\r\nContent-Type: text/plain\r\n\r\nRetained application update.`;
  const messageId = mime.match(/Message-ID: ([^\r\n]+)/i)![1]!;
  const eventId = await blindHash(new TextEncoder().encode(`${integrationId}:email:${messageId}`));
  await worker.email({ from: "forwarder@anywhere.test", to: privateAddress, rawSize: new TextEncoder().encode(mime).byteLength,
    raw: new Response(mime).body!, setReject: (reason: string) => { throw new Error(reason); } } as ForwardableEmailMessage, testEnv);

  const decisionEvidence = { event: "rejection" as const,
    distributions: { application_event: { type: "choice" as const, choice: "rejected" as const, confidence: 1,
      probabilities: Object.fromEntries(["applied", "new_opportunity", "interview", "rejected", "offer", "follow_up", "unrelated", "uncertain"]
        .map(label => [label, label === "rejected" ? 1 : 0])) } }, model: CLEF_MODEL, policyVersion: APPLICATION_EVENT_POLICY_VERSION };
  const { decision, decisionHash } = await hashApplicationBindingDecision(decisionEvidence);
  let bindingId = "";
  await runInDurableObject(stub, async (instance, ctx) => {
    Reflect.set(instance, "env", testEnv);
    Reflect.set(instance, "refreshReplica", async () => activeReplica);
    const row = ctx.storage.sql.exec<{ event_id: string; source_id: string; body_hash: string; payload: string }>(
      "SELECT * FROM events WHERE event_id = ?", eventId).one();
    const [nonce, ciphertext] = row.payload.split(".");
    const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`TIN/event-key/v1/${reviewStorageSecret}`));
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    const event = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM",
      iv: decodeBlindBytes(nonce!), additionalData: new TextEncoder().encode(`TIN/event-payload/v1/${eventId}`) }, key,
    decodeBlindBytes(ciphertext!)))) as Extract<AutomationEvent, { source: "email" }>;
    const eventHash = await applicationBindingEventHash(integrationId, data.packet.workspaceId,
      { eventId, sourceId: row.source_id, bodyHash: row.body_hash }, event);
    const reason = "R".repeat(3_000);
    ctx.storage.sql.exec("UPDATE events SET status = 'review', result = ?, updated_at = ? WHERE event_id = ?",
      JSON.stringify({ status: "review", reason, decision }), Date.now(), eventId);
    const signedPayload = { ...templateProof.signed.payload, eventId, eventHash, decisionHash, issuedAt: Date.now() };
    const bindingProof: ApplicationBindingProof = { ...templateProof, signed: await signEnvelope(
      data.owner.privateKeys.devicePrivateKey, signedPayload, data.owner.device.deviceId) };
    bindingId = bindingProof.signed.payload.bindingId;
    await expect(instance.bindEmailApplication(bindingProof, reviewOrigin)).resolves.toMatchObject({ duplicate: false });
    await ctx.storage.deleteAlarm();
  });

  const body = { workspaceId: data.packet.workspaceId, definitionId: "typed-intake", integrationId };
  const requestProof = await signedReviewRequest(data.owner, "list", body, integrationId);
  const response = await postApplicationReview("list", requestProof, body, testEnv);
  expect(response.status).toBe(200);
  const mailboxBody = await response.json();
  const mailbox = parseApplicationReviewMailbox(mailboxBody);
  expect(mailbox).toMatchObject({ origin: reviewOrigin, workspaceId: data.packet.workspaceId, definitionId: "typed-intake",
    integrationId, route: { address: privateAddress, mailbox: "owner@example.test" }, receipt: { confirmation: null } });
  expect(mailbox.receipt.events).toEqual([expect.objectContaining({ eventId, status: "review", bindingId })]);
  expect(mailbox.receipt.events[0]!.subject).toHaveLength(500);
  expect(mailbox.receipt.events[0]!.subject.length).toBeLessThanOrEqual(512);
  expect(mailbox.receipt.events[0]!.result?.reason).toHaveLength(2_048);
  const observation = mailbox.observation as { signed: { payload: { nonce: string } } };
  await expect(verifyAutomationObservation(mailbox.observation, { personId: data.automation.identity.personId,
    origin: reviewOrigin, integrationId: "typed-intake", workspaceId: data.packet.workspaceId,
    grantId: data.packet.grant.payload.grantId, nonce: observation.signed.payload.nonce })).resolves.toMatchObject({ state: "active" });
  const cached = await postApplicationReview("list", requestProof, body, testEnv);
  expect(cached.status).toBe(200);
  expect(await cached.json()).toEqual(mailboxBody);

  const nonOwnerProof = await signedReviewRequest(data.automation, "list", body, integrationId);
  expect((await postApplicationReview("list", nonOwnerProof, body, testEnv)).status).toBe(403);
  const serialized = JSON.parse(originalReplica.serialize());
  const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(serialized.rawDocument));
  const revocation = await createWorkspaceDeviceRevocation(data.owner, data.packet.workspaceId,
    data.owner.identity.personId, data.owner.device.deviceId, Automerge.getHeads(document), [data.owner.certificate]);
  Automerge.free(document);
  serialized.authority.deviceRevocations.push({ record: revocation.record, signer: revocation.authority });
  activeReplica = await AutomationReplica.restore(JSON.stringify(serialized), data.automation, async () => {});
  expect((await postApplicationReview("list", requestProof, body, testEnv)).status).toBe(403);
});

it("Given a retained clear email decision, When owner reviews, binds and retries it, Then queue once without changing the card", async () => {
  const integrationId = `legacy-${crypto.randomUUID().replace(/-/g, "")}`;
  const { data, replica, cardId } = await bindingFixture(integrationId);
  const testEnv = reviewEnvironment(integrationId, data.packet.workspaceId, data.packet.bindings);
  const stub = (env as WorkerEnv).AUTOMATION.getByName(integrationId);
  await runInDurableObject(stub, async instance => {
    Reflect.set(instance, "env", testEnv);
    Reflect.set(instance, "refreshReplica", async () => replica);
  });
  const mime = `From: hiring@example.test\r\nTo: owner@example.test\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <review-${crypto.randomUUID()}@example.test>\r\nSubject: Application received\r\nContent-Type: text/plain\r\n\r\nWe received your application. No role or vacancy URL.`;
  const sourceMessageId = mime.match(/Message-ID: ([^\r\n]+)/i)![1]!;
  const eventId = await blindHash(new TextEncoder().encode(`${integrationId}:email:${sourceMessageId}`));
  await worker.email({ from: "owner@example.test", to: `${integrationId}@example.test`,
    rawSize: new TextEncoder().encode(mime).byteLength, raw: new Response(mime).body!,
    setReject: (reason: string) => { throw new Error(reason); } } as ForwardableEmailMessage, testEnv);
  const sync = vi.spyOn(replica, "sync").mockResolvedValue();
  try {
    await runInDurableObject(stub, async (instance, ctx) => {
      Reflect.set(instance, "env", testEnv);
      Reflect.set(instance, "refreshReplica", async () => replica);
      await instance.alarm();
      expect(instance.getEvent(eventId)).toMatchObject({ status: "review", result: { decision: { event: "applied" } } });
      await ctx.storage.deleteAlarm();
    });

    const reviewBody = { workspaceId: data.packet.workspaceId, definitionId: "typed-intake", integrationId, eventId, offset: 0 };
    const reviewProof = await signedReviewRequest(data.owner, "review", reviewBody, integrationId);
    const reviewResponse = await postApplicationReview("review", reviewProof, reviewBody, testEnv);
    expect(reviewResponse.status).toBe(200);
    const review = parseApplicationReviewResponse(await reviewResponse.json());
    expect(review).toMatchObject({ origin: reviewOrigin, workspaceId: data.packet.workspaceId, definitionId: "typed-intake",
      integrationId, eventId, status: "review", decisionEvent: "applied", decisionHash: expect.any(String),
      eventHash: expect.any(String), grantId: data.packet.grant.payload.grantId, accessEpoch: 1 });
    const option = review.options.find(value => value.cardId === cardId && value.sourceRecordId !== null);
    expect(option).toMatchObject({ sourceHash: expect.any(String), workflow: { columnId: expect.any(String), changedAt: expect.any(String) } });
    const originalReplica = replica.serialize();
    const binding: ApplicationBindingInput = { bindingId: crypto.randomUUID(), previousBindingId: null,
      origin: reviewOrigin, integrationId, definitionId: "typed-intake", workspaceId: data.packet.workspaceId,
      cardId, grantId: review.grantId, eventId, eventHash: review.eventHash, decisionHash: review.decisionHash!,
      sourceRecordId: option!.sourceRecordId!, sourceHash: option!.sourceHash!, accessEpoch: review.accessEpoch,
      workflow: option!.workflow! };
    const bindingContext = await resolveSigningContext({ profile: data.owner, certificates: [], purpose: "automation-application-binding",
      authorityRevision: "runtime-review-test", binding: {
        origin: binding.origin, integrationId, definitionId: binding.definitionId, workspaceId: binding.workspaceId,
        cardId, grantId: binding.grantId, eventId, eventHash: binding.eventHash, decisionHash: binding.decisionHash,
        sourceRecordId: binding.sourceRecordId, sourceHash: binding.sourceHash, accessEpoch: binding.accessEpoch,
      }, current: async () => ({ personId: data.owner.identity.personId, deviceId: data.owner.device.deviceId,
        authorityRevision: "runtime-review-test" }) });
    const applicationProof = await createApplicationBinding(bindingContext, binding);
    const bindBody = { workspaceId: data.packet.workspaceId, definitionId: "typed-intake", integrationId, proof: applicationProof };
    const bindRequest = await signedReviewRequest(data.owner, "bind", bindBody, integrationId);
    const bound = await postApplicationReview("bind", bindRequest, bindBody, testEnv);
    expect(bound.status).toBe(200);
    expect(await bound.json()).toMatchObject({ bindingId: binding.bindingId, duplicate: false });
    expect(replica.serialize()).toBe(originalReplica);
    const wrongAction = await postApplicationReview("retry", bindRequest, bindBody, testEnv);
    expect(wrongAction.status).toBe(401);
    for (const changedBody of [
      { ...bindBody, workspaceId: "other-workspace" }, { ...bindBody, definitionId: "other-definition" },
      { ...bindBody, integrationId: "other-integration" },
    ]) expect((await postApplicationReview("bind", bindRequest, changedBody, testEnv)).status).toBe(401);

    const retryRequest = await signedReviewRequest(data.owner, "retry", bindBody, integrationId);
    const firstRetry = await postApplicationReview("retry", retryRequest, bindBody, testEnv);
    expect(firstRetry.status).toBe(200);
    const firstRetryResult = await firstRetry.json();
    expect(firstRetryResult).toMatchObject({ eventId, status: "pending", duplicate: false });
    const exactRetry = await postApplicationReview("retry", retryRequest, bindBody, testEnv);
    expect(exactRetry.status).toBe(200);
    expect(await exactRetry.json()).toEqual(firstRetryResult);
    const changedBody = { ...bindBody, workspaceId: "other-workspace" };
    expect((await postApplicationReview("retry", retryRequest, changedBody, testEnv)).status).toBe(401);

    await runInDurableObject(stub, async (instance, ctx) => {
      Reflect.set(instance, "env", testEnv);
      Reflect.set(instance, "refreshReplica", async () => replica);
      expect(instance.getEvent(eventId)?.status).toBe("pending");
      expect(readApplicationBindingHistory(ctx.storage, eventId)).toHaveLength(1);
      await ctx.storage.deleteAlarm();
    });
    const alternateProof = await createApplicationBinding(bindingContext,
      { ...binding, bindingId: crypto.randomUUID(), previousBindingId: binding.bindingId });
    const changedNonceBody = { ...bindBody, proof: alternateProof };
    const changedNonceHash = await automationBodyHash(changedNonceBody);
    const changedNonceRequest = { ...retryRequest, signed: await signEnvelope(data.owner.privateKeys.devicePrivateKey,
      { ...retryRequest.signed.payload, bodyHash: changedNonceHash }, data.owner.device.deviceId) };
    expect((await postApplicationReview("retry", changedNonceRequest, changedNonceBody, testEnv)).status).toBe(409);
    await runInDurableObject(stub, async (instance, ctx) => {
      expect(instance.getEvent(eventId)?.status).toBe("pending");
      expect(readApplicationBindingHistory(ctx.storage, eventId)).toHaveLength(1);
      await ctx.storage.deleteAlarm();
    });
  } finally { sync.mockRestore(); }
});

it("Given a signed owner mail binding with distinct legacy routing and definition IDs, When current source and workflow match, Then accept without changing the card", async () => {
  const { replica, event, proof } = await bindingFixture();
  const before = replica.serialize();
  expect(proof.signed.payload.definitionId).toBe("typed-intake");
  expect(proof.signed.payload.integrationId).toBe("legacy-routing-id");
  await expect(replica.verifyApplicationBindingForRuntime(proof, event)).resolves.toMatchObject({ cardId: proof.signed.payload.cardId });
  expect(replica.serialize()).toBe(before);
});

it("Given a valid owner proof, When its current original, workflow or grant differs, Then reject rather than apply stale intent", async () => {
  const { replica, event, proof, data } = await bindingFixture();
  for (const patch of [{ sourceRecordId: "missing-original" }, { sourceHash: "D".repeat(43) },
    { grantId: "other-grant" }, { accessEpoch: 9 }, { definitionId: "other-definition" },
    { workflow: { ...proof.signed.payload.workflow, columnId: "wrong-column" } }]) {
    const changed = { ...proof, signed: await signEnvelope(data.owner.privateKeys.devicePrivateKey,
      { ...proof.signed.payload, ...patch }, data.owner.device.deviceId) };
    await expect(replica.verifyApplicationBindingForRuntime(changed, event)).rejects.toThrow();
  }
});

it("Given a historically valid owner binding, When its signing device is now revoked, Then current Rust policy denies the binding", async () => {
  const { replica, event, proof, data } = await bindingFixture();
  const state = JSON.parse(replica.serialize());
  const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(state.rawDocument));
  const revocation = await createWorkspaceDeviceRevocation(data.owner, data.packet.workspaceId,
    data.owner.identity.personId, data.owner.device.deviceId, Automerge.getHeads(document), [data.owner.certificate]);
  Automerge.free(document);
  state.authority.deviceRevocations.push({ record: revocation.record, signer: revocation.authority });
  const restored = await AutomationReplica.restore(JSON.stringify(state), data.automation, async () => {});
  await expect(restored.verifyApplicationBindingForRuntime(proof, event)).rejects.toThrow(/owner|revoked|authority/i);
});

it.each(["confirmed", "lost-receipt", "corrected", "stale-workflow", "deleted"])("Given retained ambiguous rejection mail with scenario=%s, When its owner binds and retries, Then preserve classification and current intent", async scenario => {
  const lostReceipt = scenario === "lost-receipt";
  const correction = scenario === "corrected";
  const staleWorkflow = scenario === "stale-workflow";
  const id = `binding-${crypto.randomUUID()}`;
  const { replica, proof: initialProof, data, cardId } = await bindingFixture(id);
  const stub = (env as WorkerEnv).AUTOMATION.getByName(id);
  const storageSecret = "test-only-binding-storage-secret-with-at-least-thirty-two-bytes";
  const ai = { run: vi.fn(async () => { throw new Error("Bound retry must use retained classification"); }) };
  const testEnv = { ...env, EVENT_STORAGE_SECRET: storageSecret, AI: ai,
    INTEGRATIONS_JSON: JSON.stringify([{ id, workspaceId: data.packet.workspaceId,
      scope: { version: 1, ...data.packet.bindings, expiresAt: "2099-01-01T00:00:00.000Z" },
      emailAddress: `${id}@example.test`, allowedForwarders: ["owner@example.test"] }]) } as WorkerEnv;
  const mime = `From: hiring@upvest.example.test\r\nTo: owner@example.test\r\nDate: ${new Date(Date.now() + 60_000).toUTCString()}\r\nMessage-ID: <bound-rejection@example.test>\r\nSubject: Application update\r\nContent-Type: text/plain\r\n\r\nUpvest declined an application. No role or vacancy URL.`;
  const eventId = await blindHash(new TextEncoder().encode(`${id}:email:<bound-rejection@example.test>`));
  await worker.email({ from: "owner@example.test", to: `${id}@example.test`, rawSize: mime.length,
    raw: new Response(mime).body!, setReject: (reason: string) => { throw new Error(reason); } } as ForwardableEmailMessage, testEnv);
  const { decision, decisionHash } = await hashApplicationBindingDecision({ event: "rejection",
    distributions: { application_event: { type: "choice", choice: "rejected", confidence: 1,
      probabilities: Object.fromEntries(["applied", "new_opportunity", "interview", "rejected", "offer", "follow_up", "unrelated", "uncertain"].map(label => [label, label === "rejected" ? 1 : 0])) } },
    model: CLEF_MODEL, policyVersion: APPLICATION_EVENT_POLICY_VERSION });
  const sync = vi.spyOn(replica, "sync").mockResolvedValue();
  try {
    await runInDurableObject(stub, async (instance, ctx) => {
      Reflect.set(instance, "env", testEnv);
      Reflect.set(instance, "refreshReplica", async () => replica);
      const row = ctx.storage.sql.exec<{ event_id: string; source_id: string; body_hash: string; payload: string }>(
        "SELECT * FROM events WHERE event_id = ?", eventId).one();
      const [nonce, ciphertext] = row.payload.split(".");
      const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256",
        new TextEncoder().encode(`TIN/event-key/v1/${storageSecret}`)), "AES-GCM", false, ["decrypt"]);
      const event = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM",
        iv: decodeBlindBytes(nonce!), additionalData: new TextEncoder().encode(`TIN/event-payload/v1/${eventId}`) }, key,
      decodeBlindBytes(ciphertext!)))) as Extract<AutomationEvent, { source: "email" }>;
      const eventHash = await applicationBindingEventHash(id, data.packet.workspaceId,
        { eventId, sourceId: row.source_id, bodyHash: row.body_hash }, event);
      let proof = { ...initialProof, signed: await signEnvelope(data.owner.privateKeys.devicePrivateKey,
        { ...initialProof.signed.payload, eventId, eventHash, decisionHash }, data.owner.device.deviceId) };
      ctx.storage.sql.exec("UPDATE events SET status = 'review', result = ? WHERE event_id = ?",
        JSON.stringify({ status: "review", reason: "Ambiguous application", source: { type: "email", receivedAt: event.receivedAt }, decision }), eventId);
      await ctx.storage.deleteAlarm();
      await expect(instance.bindEmailApplication(proof, "https://automation.example.test")).resolves.toMatchObject({ duplicate: false });
      const registration = { integrationId: id, workspaceId: data.packet.workspaceId, ownerPersonId: data.owner.identity.personId };
      ctx.storage.sql.exec("INSERT INTO automation_registration (singleton, owner_id, workspace_id, integration_id) VALUES (1, ?, ?, ?)",
        registration.ownerPersonId, registration.workspaceId, registration.integrationId);
      await expect(instance.retryEmail(registration, eventId)).rejects.toThrow(/signed application-binding retry/);
      expect(instance.getEvent(eventId)?.status).toBe("review");
      expect(await ctx.storage.getAlarm()).toBeNull();
      expect(replica.candidates().find(candidate => candidate.cardId === cardId)?.columnId).toBe(data.packet.bindings.columns.applied);
      expect(readApplicationBindingHistory(ctx.storage, eventId)).toHaveLength(1);
      if (correction) {
        const superseded = proof;
        proof = { ...proof, signed: await signEnvelope(data.owner.privateKeys.devicePrivateKey,
          { ...proof.signed.payload, bindingId: crypto.randomUUID(), previousBindingId: proof.signed.payload.bindingId }, data.owner.device.deviceId) };
        await instance.bindEmailApplication(proof, "https://automation.example.test");
        await expect(instance.bindEmailApplication(superseded, "https://automation.example.test")).rejects.toThrow(/superseded|changed/i);
        await expect(instance.retryBoundEmailApplication(superseded, "https://automation.example.test")).rejects.toThrow(/changed/i);
      }
      await instance.retryBoundEmailApplication(proof, "https://automation.example.test");
      if (scenario === "deleted") {
        const control = vi.spyOn(replica, "controlForRuntime").mockReturnValue({ state: "deleted", heads: [] });
        try { await instance.alarm(); } finally { control.mockRestore(); }
        expect(instance.getEvent(eventId)).toMatchObject({ status: "review", result: { decision } });
        expect(replica.appliedForRuntime(eventId)).toBeUndefined();
        expect(readApplicationBindingAudit(ctx.storage, eventId).map(entry => entry.kind)).toEqual(["saved"]);
        expect(ai.run).not.toHaveBeenCalled();
        expect(await ctx.storage.getAlarm()).toBeNull();
        return;
      }
      if (lostReceipt) sync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Storage receipt response lost"));
      if (staleWorkflow) sync.mockImplementationOnce(async () => {
        await replica.moveCard("concurrent-interview", cardId, data.packet.bindings.columns.interview, proof.signed.payload.workflow);
      });
      await instance.alarm();
      if (staleWorkflow) {
        expect(instance.getEvent(eventId)).toMatchObject({ status: "review", result: { decision } });
        expect(replica.appliedForRuntime(eventId)).toBeUndefined();
        expect(replica.candidates().find(candidate => candidate.cardId === cardId)?.columnId).toBe(data.packet.bindings.columns.interview);
        expect(readApplicationBindingAudit(ctx.storage, eventId).map(entry => entry.kind)).toEqual(["saved"]);
        expect(ai.run).not.toHaveBeenCalled();
        await ctx.storage.deleteAlarm();
        return;
      }
      if (lostReceipt) {
        expect(instance.getEvent(eventId)).toMatchObject({ status: "pending", result: { decision } });
        expect(readApplicationBindingAudit(ctx.storage, eventId).map(audit => audit.kind)).toEqual(["saved"]);
        const changeHash = replica.appliedForRuntime(eventId)?.changeHash;
        ctx.storage.sql.exec("UPDATE events SET next_attempt_at = 0 WHERE event_id = ?", eventId);
        await instance.alarm();
        expect(replica.appliedForRuntime(eventId)?.changeHash).toBe(changeHash);
      }
      expect(ai.run).not.toHaveBeenCalled();
      expect(instance.getEvent(eventId)).toMatchObject({ status: "applied", result: { decision, action: { cardId,
        columnId: data.packet.bindings.columns.rejected, bindingId: proof.signed.payload.bindingId } } });
      expect(replica.appliedForRuntime(eventId)?.changeHash).toMatch(/^[0-9a-f]{64}$/);
      const audit = readApplicationBindingAudit(ctx.storage, eventId);
      expect(audit.map(entry => entry.kind)).toEqual(correction ? ["saved", "saved", "applied"] : ["saved", "applied"]);
      expect(audit.at(-1)).toMatchObject({ bindingId: proof.signed.payload.bindingId, kind: "applied", changeHash: replica.appliedForRuntime(eventId)?.changeHash });
      await expect(instance.bindEmailApplication(proof, "https://automation.example.test")).resolves.toMatchObject({ duplicate: true });
      expect(readApplicationBindingHistory(ctx.storage, eventId)).toHaveLength(correction ? 2 : 1);
      await ctx.storage.deleteAlarm();
    });
  } finally { sync.mockRestore(); }
});

async function typedFixture(subjectPersonId?: string, email = false, typeVersion: 1 | 2 = 1) {
  const data = await fixture(subjectPersonId, email);
  if (typeVersion === 2) data.packet.grant = await createAutomationWorkspaceGrant(data.owner,
    data.packet.workspaceId, data.packet.grant.payload.personId, { ...data.packet.grant.payload.automation!, version: 2 });
  const payload = parseAutomationDefinition({ kind: "automation-definition", version: 1, id: "typed-intake", name: "Job intake",
    type: "job-intake" as const, typeVersion, parameters: { sources: email ? ["website" as const, "email" as const] : ["website" as const] },
    permissions: [...automationTypes.find(type => type.version === typeVersion)!.permissions],
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

it.each(["paused", "deleted"] as const)("Given a %s expired automation with a durable pending object, When its storage floor is refreshed, Then change only the Rusty revision and retain exact executor progress", async state => {
  const data = await typedFixture();
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  const stored = JSON.parse(replica.serialize());
  const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(stored.rawDocument));
  const controlled = await executeCommand(document, { kind: "setAutomationState", automationId: automationEntityId("typed-intake"), state }, data.owner);
  if (!controlled.ok) throw new Error(controlled.error.message);
  const snapshot = await ownerSnapshot(controlled.value.newDoc, data.owner, data.packet);
  stored.rawDocument = snapshot.document;
  stored.authorizations = snapshot.authorization.records;
  stored.authority = snapshot.authorization.authority;
  stored.applied = { "retained-event": { kind: "lead", cardId: "retained-card", changeHash: "retained-change" } };
  const plaintext = new TextEncoder().encode("exact encrypted pending snapshot bytes");
  stored.pending = { requestId: crypto.randomUUID(), hash: await blindHash(plaintext), bytes: plaintext.byteLength,
    revision: "captured-revision", identity: "captured-identity",
    object: await encryptBlindObject(stored.blind.scopeId, stored.blind.keyEpoch,
      decodeBlindBytes(stored.blind.contentKey), plaintext) };
  stored.blind.cursor = 17;
  stored.blind.lastUploaded = "B".repeat(43);
  stored.replication.generation = 7;
  stored.replication.uploadedRevision = "confirmed-content";
  stored.replication.contentIdentity = "workspace-content-identity";
  const before = JSON.stringify(stored);
  const applied = structuredClone(stored.applied);
  const priorExpiry = data.packet.grant.payload.automation!.expiresAt;
  const saves: string[] = [];
  const persist = async (next: string) => { saves.push(next); };
  const guard = vi.fn(async () => {});
  vi.useFakeTimers();
  vi.setSystemTime(priorExpiry + 1);
  try {
    const inspector = await AutomationReplica.refreshStoragePolicy(before, data.automation, 2, persist, guard);
    expect(saves).toHaveLength(1);
    const refreshed = JSON.parse(saves[0]!);
    const expected = structuredClone(stored);
    expected.blind.policyRevision = 2;
    expected.blind.minimumWriterVersion = 2;
    expected.replication.binding = canonicalBlindJson([expected.workspaceId, expected.blind.origin, expected.blind.scopeId,
      expected.blind.keyEpoch, expected.blind.policyRevision, expected.blind.servicePublicKey,
      expected.blind.readToken, expected.blind.writeToken, expected.blind.contentKey]);
    expect(refreshed).toEqual(expected);
    expect(refreshed.applied).toEqual(applied);
    const description = inspector.describe(reviewOrigin, data.packet.workspaceId, "typed-intake");
    expect(description.state).toBe(state);
    expect(description.storage).toEqual({ origin: data.packet.blind.origin, scopeId: data.packet.blind.scopeId,
      keyEpoch: data.packet.blind.keyEpoch, servicePublicKey: data.packet.blind.servicePublicKey,
      policyRevision: 2, minimumWriterVersion: 2 });
    expect(JSON.stringify(description)).not.toContain(data.packet.blind.contentKey);
    expect(JSON.stringify(description)).not.toContain(data.packet.blind.readToken);
    expect(JSON.stringify(description)).not.toContain(data.packet.blind.writeToken);
    expect(guard.mock.calls.length).toBeGreaterThanOrEqual(3);

    const second = await AutomationReplica.refreshStoragePolicy(saves[0]!, data.automation, 2, persist, guard);
    expect(saves).toHaveLength(1);
    expect(second.describe(reviewOrigin, data.packet.workspaceId, "typed-intake").state).toBe(state);
  } finally {
    vi.useRealTimers();
    Automerge.free(document);
    Automerge.free(controlled.value.newDoc);
  }
})

it("Given a stale or failed storage revision refresh, When publication is attempted, Then preserve the prior durable bytes", async () => {
  const data = await typedFixture();
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  const serialized = replica.serialize();
  const writes: string[] = [];
  const persist = async (next: string) => { writes.push(next); };
  await expect(AutomationReplica.refreshStoragePolicy(serialized, data.automation, 0, persist, () => {})).rejects.toThrow(/revision/i);
  expect(writes).toHaveLength(0);

  let durable = serialized;
  await expect(AutomationReplica.refreshStoragePolicy(serialized, data.automation, 2, async () => {
    throw new Error("Durable publication aborted");
  }, () => {})).rejects.toThrow("Durable publication aborted");
  expect(durable).toBe(serialized);

  let checks = 0;
  await expect(AutomationReplica.refreshStoragePolicy(serialized, data.automation, 2, async next => { durable = next; }, () => {
    checks++;
    if (checks === 4) throw new Error("Current owner changed after publication");
  })).rejects.toThrow("Current owner changed after publication");
  expect(durable).not.toBe(serialized);
  expect(JSON.parse(durable).blind.policyRevision).toBe(2);
})

it("Given explicit intake v2, when creating a mislabeled card, then its extracted original is signed atomically and survives restore and duplicate delivery", async () => {
  const data = await typedFixture(undefined, false, 2);
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  const before = JSON.parse(replica.serialize());
  const normalized = { company: "Wrong company label", role: "Wrong role label", jobUrl: "https://jobs.example.test/upvest/123",
    source: { origin: "website" as const, page: { url: "https://jobs.example.test/upvest/123", finalUrl: "https://jobs.example.test/upvest/123",
      status: 200, contentType: "text/html", fetchedAt: "2026-10-14T10:00:00.000Z", company: "Upvest",
      role: "Senior Product Engineer", title: "Senior Product Engineer", description: "Build an investment API",
      body: "Build an investment API", source: "jobposting" as const } } };
  const created = await replica.createLead("immutable-original", normalized, {});
  const after = JSON.parse(replica.serialize());
  const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(after.rawDocument));
  const previous = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(before.rawDocument));
  try {
    const sources = Object.values(document.entities).filter(entity => entity.kind === "application_source");
    expect(sources).toHaveLength(1);
    expect(sources[0]?.placement.parentId).toBe(created.cardId);
    if (sources[0]?.kind !== "application_source") throw new Error("Missing immutable source");
    expect(JSON.parse(sources[0].data)).toMatchObject({ applicationId: `${document.id}:${created.cardId}`,
      observation: { phase: "original", status: "available", company: "Upvest", title: "Senior Product Engineer", text: "Build an investment API" } });
    expect(document.entities[created.cardId].title).toBe("Wrong company label — Wrong role label");
    expect(Automerge.getChanges(previous, document)).toHaveLength(1);
    const restored = await AutomationReplica.restore(replica.serialize(), data.automation, async () => {});
    expect(await restored.createLead("immutable-original", normalized, {})).toEqual({ cardId: created.cardId, duplicate: true });
    expect(JSON.parse(restored.serialize()).rawDocument).toBe(after.rawDocument);
    const candidates = restored.candidates();
    expect(candidates.find(candidate => candidate.cardId === created.cardId)?.sources).toHaveLength(1);
    const planned = await planApplicationMove({ messageId: "<source-rejection@example.test>", inReplyTo: null, references: [],
      from: "hiring@upvest.example", to: "owner@example.test", subject: "Upvest application update",
      text: "Your Senior Product Engineer application was declined", urls: [],
      date: new Date(Date.now() + 60_000).toUTCString(), confirmation: false, attachments: [] }, candidates,
      restored.bindingsForRuntime(), "rejection", async () => { throw new Error("The retained original must survive a page 404"); });
    expect(planned.kind).toBe("move");
    if (planned.kind !== "move") throw new Error(planned.reason);
    await restored.moveCard("source-rejection", planned.candidate.cardId, planned.columnId,
      planned.candidate.workflow ?? { columnId: planned.candidate.columnId });
    expect(restored.candidates().find(candidate => candidate.cardId === created.cardId)?.columnId).toBe(data.packet.bindings.columns.rejected);
  } finally { Automerge.free(previous); Automerge.free(document); }
});

it("Given v2 source authority, when activation definition or packet omits that exact contract, then no replica becomes executable", async () => {
  const data = await typedFixture(undefined, false, 2);
  const v1Definition = parseAutomationDefinition({ ...data.packet.definition!.payload, typeVersion: 1,
    permissions: automationTypes.find(type => type.version === 1)!.permissions });
  const definition = await signEnvelope(data.owner.privateKeys.devicePrivateKey, v1Definition, data.owner.device.deviceId);
  await expect(AutomationReplica.activate({ ...data.packet, definition }, data.automation)).rejects.toThrow(/version|match/i);
  const untyped = { ...data.packet };
  delete untyped.definition;
  await expect(AutomationReplica.activate({ ...untyped, version: 1 }, data.automation)).rejects.toThrow(/version|contract/i);
});

it("Given a v1 automation and owner-captured original, when processing a rejection, then read original evidence and move without acquiring source-write rights", async () => {
  const data = await typedFixture();
  const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(data.packet.initial.document));
  const text = "Upvest is hiring a Senior Product Engineer";
  const result = await executeCommand(document, { kind: "createItemWithApplicationSource", id: "owner-application",
    parentId: data.packet.bindings.columns.lead, title: "Incorrect label", values: {
      [data.packet.bindings.fieldIds.company]: "Incorrect employer", [data.packet.bindings.fieldIds.role]: "Incorrect role",
    }, data: { kind: "application-source-observation", version: 1, recordId: "owner-original", workspaceId: data.packet.workspaceId,
      cardId: "owner-application", applicationId: `${data.packet.workspaceId}:owner-application`,
      observation: { phase: "original", origin: "website", status: "available", observedAt: "2026-10-14T10:00:00.000Z",
        jobUrl: "https://jobs.example.test/upvest/original", company: "Upvest", title: "Senior Product Engineer",
        text, extractorVersion: "fixture-v1", contentDigest: await blindHash(new TextEncoder().encode(text)) } } }, data.owner);
  if (!result.ok) throw new Error(result.error.message);
  data.packet.initial = await ownerSnapshot(result.value.newDoc, data.owner, data.packet);
  Automerge.free(document); Automerge.free(result.value.newDoc);
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  const candidate = replica.candidates().find(value => value.cardId === "owner-application")!;
  expect(candidate.sources).toHaveLength(1);
  const plan = await planApplicationMove({ messageId: "<v1-rejection@example.test>", inReplyTo: null, references: [],
    from: "hiring@upvest.example", to: "owner@example.test", subject: "Application update",
    text: "Upvest declined your Senior Product Engineer application", urls: [], date: new Date(Date.now() + 60_000).toUTCString(),
    confirmation: false, attachments: [] }, [candidate], replica.bindingsForRuntime(), "rejection",
    async () => { throw new Error("Original lookup must not fetch the changed page"); });
  expect(plan.kind).toBe("move");
  if (plan.kind !== "move") throw new Error(plan.reason);
  await replica.moveCard("v1-original-rejection", candidate.cardId, plan.columnId, candidate.workflow!);
  expect(replica.candidates().find(value => value.cardId === candidate.cardId)?.columnId).toBe(data.packet.bindings.columns.rejected);
  expect(JSON.parse(replica.serialize()).grant.payload.automation.version).toBe(1);
});

it("Given v2 intake without captured page content, when authoring a lead, then labels do not invent original evidence", async () => {
  const data = await typedFixture(undefined, false, 2);
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  await expect(replica.createLead("missing-source-context", { company: "Label", role: "Role" }, {})).rejects.toThrow(/source/i);
  const created = await replica.createLead("unavailable-source", { company: "Label", role: "Role",
    source: { origin: "website" } }, {});
  const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(JSON.parse(replica.serialize()).rawDocument));
  try {
    const source = Object.values(document.entities).find(entity => entity.kind === "application_source" && entity.placement.parentId === created.cardId);
    if (source?.kind !== "application_source") throw new Error("Missing original observation");
    const data = JSON.parse(source.data);
    expect(data.observation).toMatchObject({ phase: "original", status: "unavailable" });
    expect(data.observation).not.toHaveProperty("company");
    expect(data.observation).not.toHaveProperty("title");
    expect(data.observation).not.toHaveProperty("text");
  } finally { Automerge.free(document); }
});

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
  expect(next.blind.cursor).toBe(rotated ? blind.cursor : stored.blind.cursor);
  expect(next.blind.lastUploaded).toBe(rotated ? "" : stored.pending.hash);
  expect(next.pending.hash).toBe(stored.pending.hash);
  expect(await decryptBlindObject(next.pending.object, blind.scopeId, blind.keyEpoch, decodeBlindBytes(blind.contentKey))).toEqual(pendingPlaintext);
  expect(renewed.allowsSource("email")).toBe(true);
  expect(await renewed.createLead("renewal-lead", { company: "Example GmbH", role: "Senior Engineer" }, {})).toEqual({ cardId: created.cardId, duplicate: true });
  Automerge.free(document); Automerge.free(changed.value.newDoc);
});

it("Given an expired but intact prior grant and a fresh owner renewal, When renewing, Then retain paused controls and durable event state", async () => {
  const data = await typedFixture();
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  await replica.createLead("expired-renewal-event", { company: "Example GmbH", role: "Engineer" }, { retained: true });
  const stored = JSON.parse(replica.serialize());
  const pendingPlaintext = new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: stored.workspaceId,
    document: stored.rawDocument, authorization: { version: 1, authority: stored.authority, records: stored.authorizations }, chat: stored.chat }));
  stored.pending = { hash: await blindHash(pendingPlaintext), object: await encryptBlindObject(stored.blind.scopeId,
    stored.blind.keyEpoch, decodeBlindBytes(stored.blind.contentKey), pendingPlaintext) };
  stored.blind.cursor = 17;
  stored.blind.lastUploaded = stored.pending.hash;
  const applied = structuredClone(stored.applied);
  const previousExpiry = data.packet.grant.payload.automation!.expiresAt;
  vi.useFakeTimers();
  vi.setSystemTime(previousExpiry + 1);
  let currentDoc: Automerge.Doc<WorkspaceDocumentV2> | undefined;
  let configuredDoc: Automerge.Doc<WorkspaceDocumentV2> | undefined;
  try {
    await expect(AutomationReplica.restore(JSON.stringify(stored), data.automation, async () => {})).rejects.toThrow(/expired/i);

    const originalDocument = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(stored.rawDocument));
    const grant = await createAutomationWorkspaceGrant(data.owner, data.packet.workspaceId, data.automation.identity.personId,
      { ...data.packet.grant.payload.automation!, expiresAt: Date.now() + 60 * 60_000 });
    const definitionPayload = { ...data.packet.definition!.payload,
      scope: { ...data.packet.definition!.payload.scope, grantId: grant.payload.grantId } };
    const definition = await signEnvelope(data.owner.privateKeys.devicePrivateKey, definitionPayload, data.owner.device.deviceId);
    const configured = await executeCommand(originalDocument, { kind: "configureAutomation", definition: definitionPayload,
      approval: JSON.stringify({ definition, grant }) }, data.owner);
    if (!configured.ok) throw new Error(configured.error.message);
    currentDoc = configured.value.newDoc;
    Automerge.free(originalDocument);
    const paused = await executeCommand(currentDoc, { kind: "setAutomationState", automationId: automationEntityId("typed-intake"), state: "paused" }, data.owner);
    if (!paused.ok) throw new Error(paused.error.message);
    configuredDoc = paused.value.newDoc;
    Automerge.free(currentDoc);
    currentDoc = undefined;
    const packet = { ...data.packet, grant, definition, initial: await ownerSnapshot(configuredDoc, data.owner, data.packet) };
    const renewed = await AutomationReplica.renew(JSON.stringify(stored), packet, data.automation, "https://automation.example.test");
    expect(renewed.controlForRuntime().state).toBe("paused");
    const next = JSON.parse(renewed.serialize());
    expect(next.applied).toEqual(applied);
    expect(next.pending.hash).toBe(stored.pending.hash);
    expect(next.pending.object).toEqual(stored.pending.object);
    expect(next.pending.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(next.pending.bytes).toBe(pendingPlaintext.byteLength);
    expect(next.blind.cursor).toBe(stored.blind.cursor);
    expect(next.blind.lastUploaded).toBe(stored.pending.hash);
    const restoredRenewal = await AutomationReplica.restore(renewed.serialize(), data.automation, async () => {});
    const restoredPending = JSON.parse(restoredRenewal.serialize()).pending;
    expect(restoredPending).toMatchObject({ hash: next.pending.hash, requestId: next.pending.requestId, bytes: next.pending.bytes,
      object: next.pending.object });

    const invalidPrior = structuredClone(stored);
    const firstSignatureChar = invalidPrior.grant.signature[0] === "X" ? "Y" : "X";
    invalidPrior.grant.signature = `${firstSignatureChar}${invalidPrior.grant.signature.slice(1)}`;
    await expect(AutomationReplica.renew(JSON.stringify(invalidPrior), packet, data.automation,
      "https://automation.example.test")).rejects.toThrow(/signature/i);
  } finally {
    if (currentDoc) Automerge.free(currentDoc);
    if (configuredDoc) Automerge.free(configuredDoc);
    vi.useRealTimers();
  }
});

it("Given a legacy v1 executor with durable history, When its Owner explicitly adopts the typed contract, Then preserve its history and exact pending upload", async () => {
  const legacyData = await fixture();
  const legacy = await AutomationReplica.activate(legacyData.packet, legacyData.automation);
  const lead = await legacy.createLead("adopted-lead-event", { company: "Example GmbH", role: "Engineer" }, { source: "retained" });
  const prior = JSON.parse(legacy.serialize());
  const pendingBytes = new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: prior.workspaceId,
    document: prior.rawDocument, authorization: { version: 1, authority: prior.authority, records: prior.authorizations }, chat: prior.chat }));
  const pendingObject = await encryptBlindObject(prior.blind.scopeId, prior.blind.keyEpoch,
    decodeBlindBytes(prior.blind.contentKey), pendingBytes);
  prior.pending = { requestId: crypto.randomUUID(), hash: await blindHash(pendingBytes), bytes: pendingBytes.byteLength, object: pendingObject };
  prior.blind.cursor = 23;
  prior.blind.lastUploaded = prior.pending.hash;
  const grant = await createAutomationWorkspaceGrant(legacyData.owner, legacyData.packet.workspaceId,
    legacyData.automation.identity.personId, { ...legacyData.packet.grant.payload.automation!, version: 2 });
  const definitionPayload = parseAutomationDefinition({ kind: "automation-definition", version: 1, id: "typed-intake",
    name: "Job intake", type: "job-intake", typeVersion: 2, parameters: { sources: ["website"] },
    permissions: [...automationTypes.find(type => type.version === 2)!.permissions],
    scope: { workspaceId: legacyData.packet.workspaceId, boardId: legacyData.packet.bindings.boardId, grantId: grant.payload.grantId } });
  const definition = await signEnvelope(legacyData.owner.privateKeys.devicePrivateKey, definitionPayload,
    legacyData.owner.device.deviceId);
  const adoptionDocument = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(legacyData.packet.initial.document));
  const configured = await executeCommand(adoptionDocument, { kind: "createAutomation", definition: definitionPayload,
    approval: JSON.stringify({ definition, grant }),
    executor: { origin: "https://automation.example.test", personId: legacyData.automation.identity.personId } }, legacyData.owner);
  if (!configured.ok) throw new Error(configured.error.message);
  const newPacket: AutomationActivationPacket = { ...legacyData.packet, version: 2, grant, definition,
    initial: await ownerSnapshot(configured.value.newDoc, legacyData.owner, legacyData.packet) };
  Automerge.free(adoptionDocument);
  Automerge.free(configured.value.newDoc);
  const adoptLegacy = (AutomationReplica as unknown as { adoptLegacy(serialized: string, packet: AutomationActivationPacket,
    profile: typeof legacyData.automation, origin: string): Promise<AutomationReplica> }).adoptLegacy;

  const adopted = await adoptLegacy(JSON.stringify(prior), newPacket, legacyData.automation, "https://automation.example.test");
  const next = JSON.parse(adopted.serialize());
  expect(next.applied).toEqual(prior.applied);
  expect(next.applied["adopted-lead-event"]).toMatchObject({ kind: "lead", cardId: lead.cardId });
  expect(next.pending).toEqual(prior.pending);
  expect(next.blind).toMatchObject({ cursor: 23, lastUploaded: prior.pending.hash });
  expect(next.rawDocument).not.toBe(prior.rawDocument);
  expect(adopted.allowsSource("website")).toBe(true);
  expect(await adopted.createLead("adopted-lead-event", { company: "Example GmbH", role: "Engineer" }, {}))
    .toEqual({ cardId: lead.cardId, duplicate: true });

  await expect(AutomationReplica.renew(JSON.stringify(prior), newPacket, legacyData.automation,
    "https://automation.example.test")).rejects.toThrow(/preserve|contract|definition|executor/i);
  await expect(adoptLegacy(adopted.serialize(), newPacket, legacyData.automation,
    "https://automation.example.test")).rejects.toThrow(/legacy|version|adopt/i);

  const deletedDocument = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(newPacket.initial.document));
  const deletedChange = await executeCommand(deletedDocument, { kind: "setAutomationState",
    automationId: automationEntityId("typed-intake"), state: "deleted" }, legacyData.owner);
  if (!deletedChange.ok) throw new Error(deletedChange.error.message);
  const deletedPacket = { ...newPacket, initial: await ownerSnapshot(deletedChange.value.newDoc,
    legacyData.owner, newPacket) };
  const deletedReplica = await AutomationReplica.activate(deletedPacket, legacyData.automation);
  await expect(adoptLegacy(deletedReplica.serialize(), deletedPacket, legacyData.automation,
    "https://automation.example.test")).rejects.toThrow(/untyped|legacy adoption/i);
  await expect(AutomationReplica.renew(deletedReplica.serialize(), deletedPacket, legacyData.automation,
    "https://automation.example.test")).rejects.toThrow();
  expect(deletedReplica.controlForRuntime().state).toBe("deleted");
  Automerge.free(deletedDocument);
  Automerge.free(deletedChange.value.newDoc);
});

it("Given an executor profile whose device key does not match its certificate, When it authors a lead, Then leave document and dedup state unchanged", async () => {
  const data = await typedFixture(undefined, false, 2);
  const wrongProfile = { ...data.automation,
    privateKeys: { ...data.automation.privateKeys, devicePrivateKey: data.owner.privateKeys.devicePrivateKey } };
  const replica = await AutomationReplica.activate(data.packet, wrongProfile);
  const before = replica.serialize();
  const persistedCount = data.persisted.length;
  await expect(replica.createLead("wrong-device-private-key", { company: "Example GmbH", role: "Engineer",
    source: { origin: "website" } }, {})).rejects.toThrow();
  expect(replica.serialize()).toBe(before);
  expect(data.persisted).toHaveLength(persistedCount);
});

it("Given intact expired management history, When inspecting it, Then authorize the current owner and pull without publishing", async () => {
  const data = await typedFixture();
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  const serialized = replica.serialize();
  const captured = JSON.parse(serialized);
  const priorExpiry = data.packet.grant.payload.automation!.expiresAt;
  const remoteObject = await encryptBlindObject(data.packet.blind.scopeId, data.packet.blind.keyEpoch, data.key,
    new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: data.packet.workspaceId, ...data.packet.initial })));
  const remoteId = await blindObjectId(remoteObject);
  const inventory = vi.fn(async (_access: unknown, after: number) => after < 1
    ? { objects: [{ objectId: remoteId, sequence: 1 }], cursor: 1, hasMore: false }
    : { objects: [], cursor: after, hasMore: false });
  const download = vi.fn(async () => remoteObject);
  const upload = vi.fn(async () => { throw new Error("Management inspection must never upload"); });
  const transport = { inventory, download, upload } as unknown as ReplicaTransport;
  const persist = vi.fn<(value: string) => Promise<void>>(async () => {});
  vi.useFakeTimers();
  vi.setSystemTime(priorExpiry + 1);
  try {
    await expect(AutomationReplica.restore(serialized, data.automation, persist, transport)).rejects.toThrow(/expired/i);
    const inspector = await AutomationReplica.inspectForManagement(serialized, data.automation, persist, transport);
    inspector.assertOwner({ personId: data.owner.identity.personId, publicKey: data.owner.identity.publicKey,
      certificates: [data.owner.certificate] }, data.owner.device.deviceId);
    expect(inspector.describe("https://automation.example.test", data.packet.workspaceId, "typed-intake"))
      .toMatchObject({ workspaceId: data.packet.workspaceId, boardId: data.packet.bindings.boardId,
        definitionId: "typed-intake", executorPersonId: data.automation.identity.personId,
        grantId: data.packet.grant.payload.grantId, expiresAt: priorExpiry });
    const writesBeforeRejectedPull = persist.mock.calls.length;
    await expect(inspector.pull(async () => { throw new Error("Identity changed"); })).rejects.toThrow("Identity changed");
    expect(inventory).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(writesBeforeRejectedPull);
    expect(inspector.serialize()).toBe(serialized);

    await inspector.pull(async () => {});
    expect(inventory).toHaveBeenCalled();
    expect(download).toHaveBeenCalledWith(expect.anything(), remoteId);
    expect(upload).not.toHaveBeenCalled();

    const invalid = structuredClone(captured);
    const firstSignatureChar = invalid.grant.signature[0] === "X" ? "Y" : "X";
    invalid.grant.signature = `${firstSignatureChar}${invalid.grant.signature.slice(1)}`;
    await expect(AutomationReplica.inspectForManagement(JSON.stringify(invalid), data.automation, persist, transport))
      .rejects.toThrow(/signature/i);
  } finally { vi.useRealTimers(); }
});

it("Given an untyped v1 replica, When inspecting it for management, Then expose only read-only ports and require adoption", async () => {
  const data = await fixture();
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  const inspector = await AutomationReplica.inspectForManagement(replica.serialize(), data.automation, async () => {});
  expect(inspector.describe("https://automation.example.test", data.packet.workspaceId, "typed-intake"))
    .toMatchObject({ workspaceId: data.packet.workspaceId, boardId: data.packet.bindings.boardId,
      definitionId: null, executorPersonId: data.automation.identity.personId, adoptionRequired: true });
  expect(inspector).toMatchObject({ pull: expect.any(Function), assertOwner: expect.any(Function),
    describe: expect.any(Function), serialize: expect.any(Function) });
  expect(inspector).not.toHaveProperty("createLead");
  expect(inspector).not.toHaveProperty("sync");
  expect(inspector).not.toHaveProperty("moveCard");
  expect(() => inspector.assertOwner({ personId: data.owner.identity.personId, publicKey: data.owner.identity.publicKey,
    certificates: [data.owner.certificate] }, data.owner.device.deviceId)).not.toThrow();
});

it("Given owner device revocation in encrypted Rusty, When a read-only pull observes it, Then deny that device and never upload", async () => {
  const data = await typedFixture();
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  const initialSerialized = replica.serialize();
  const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(data.packet.initial.document));
  const revocation = await createWorkspaceDeviceRevocation(data.owner, data.packet.workspaceId,
    data.owner.identity.personId, data.owner.device.deviceId, Automerge.getHeads(document), [data.owner.certificate]);
  Automerge.free(document);
  const remoteSnapshot = structuredClone(data.packet.initial);
  remoteSnapshot.authorization.authority.deviceRevocations.push({ record: revocation.record, signer: revocation.authority });
  const remoteObject = await encryptBlindObject(data.packet.blind.scopeId, data.packet.blind.keyEpoch, data.key,
    new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: data.packet.workspaceId, ...remoteSnapshot })));
  const remoteId = await blindObjectId(remoteObject);
  const inventory = vi.fn(async (_access: unknown, after: number) => after < 1
    ? { objects: [{ objectId: remoteId, sequence: 1 }], cursor: 1, hasMore: false }
    : { objects: [], cursor: after, hasMore: false });
  const download = vi.fn(async () => remoteObject);
  const upload = vi.fn(async () => { throw new Error("Read-only inspector must not upload"); });
  const transport = { inventory, download, upload } as unknown as ReplicaTransport;
  const persist = vi.fn<(value: string) => Promise<void>>(async () => {});
  const identity = { personId: data.owner.identity.personId, publicKey: data.owner.identity.publicKey,
    certificates: [data.owner.certificate] };
  const inspector = await AutomationReplica.inspectForManagement(initialSerialized, data.automation, persist, transport);
  expect(() => inspector.assertOwner(identity, data.owner.device.deviceId)).not.toThrow();
  await expect(inspector.pull(async () => inspector.assertOwner(identity, data.owner.device.deviceId)))
    .rejects.toThrow(/revoked|owner|authority/i);
  expect(inventory).toHaveBeenCalledTimes(1);
  expect(download).toHaveBeenCalledWith(expect.anything(), remoteId);
  expect(upload).not.toHaveBeenCalled();
  expect(persist).toHaveBeenCalled();

  const refreshed = await AutomationReplica.inspectForManagement(inspector.serialize(), data.automation, persist, transport);
  expect(() => refreshed.assertOwner(identity, data.owner.device.deviceId)).toThrow(/revoked|owner|authority/i);
  expect(inventory).toHaveBeenCalledTimes(1);
  expect(download).toHaveBeenCalledTimes(1);
  expect(upload).not.toHaveBeenCalled();
});

it("Given an admitted ownership transfer, When inspecting old automation history, Then only the certified successor controls it", async () => {
  const data = await typedFixture();
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  const serialized = JSON.parse(replica.serialize());
  const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(serialized.rawDocument));
  const successor = await profileFromIdentitySeedForDevice(crypto.getRandomValues(new Uint8Array(32)), "Workspace successor",
    crypto.getRandomValues(new Uint8Array(32)));
  const transfer = await createWorkspaceOwnershipTransfer(data.owner, data.packet.workspaceId, {
    personId: successor.identity.personId, publicKey: successor.identity.publicKey, certificates: [successor.certificate],
  }, Automerge.getHeads(document), 2);
  Automerge.free(document);
  serialized.authority.ownershipTransfers.push(transfer);
  serialized.authority.currentOwner = { personId: successor.identity.personId, publicKey: successor.identity.publicKey,
    certificates: [successor.certificate] };
  serialized.authority.currentEpoch = 2;
  const historical = JSON.stringify(serialized);
  const inspector = await AutomationReplica.inspectForManagement(historical, data.automation, async () => {});
  expect(() => inspector.assertOwner({ personId: successor.identity.personId, publicKey: successor.identity.publicKey,
    certificates: [successor.certificate] }, successor.device.deviceId)).not.toThrow();
  expect(() => inspector.assertOwner({ personId: data.owner.identity.personId, publicKey: data.owner.identity.publicKey,
    certificates: [data.owner.certificate] }, data.owner.device.deviceId)).toThrow(/owner|authority|revoked/i);
  expect(inspector.describe("https://automation.example.test", data.packet.workspaceId, "typed-intake"))
    .toMatchObject({ definitionId: "typed-intake", executorPersonId: data.automation.identity.personId,
      grantId: data.packet.grant.payload.grantId });
  await expect(AutomationReplica.restore(historical, data.automation, async () => {})).rejects.toThrow(/authority|epoch|owner/i);

  const forged = structuredClone(serialized);
  const firstSignatureChar = forged.authority.ownershipTransfers[0].signature[0] === "X" ? "Y" : "X";
  forged.authority.ownershipTransfers[0].signature = `${firstSignatureChar}${forged.authority.ownershipTransfers[0].signature.slice(1)}`;
  await expect(AutomationReplica.inspectForManagement(JSON.stringify(forged), data.automation, async () => {}))
    .rejects.toThrow(/ownership|transfer|signature|authority/i);
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

it("Given a newly authored and admitted Lead, when its controls and candidates are read with no budget for duplicate admission, then verified results remain available and expired grants still fail", async () => {
  const data = await typedFixture();
  const replica = await AutomationReplica.activate(data.packet, data.automation);
  const created = await replica.createLead("admitted-lead", { company: "Example GmbH", role: "Senior Engineer" }, {});
  const admission = vi.spyOn(WasmStateCore, "evaluateCausalAdmission").mockImplementation(() => { throw new Error("Duplicate admission exhausted CPU budget"); });
  try {
    expect(replica.controlForRuntime().state).toBe("active");
    expect(replica.candidates().find(card => card.cardId === created.cardId)?.columnId).toBe(data.packet.bindings.columns.lead);
    vi.useFakeTimers();
    vi.setSystemTime(data.packet.grant.payload.automation!.expiresAt + 1);
    expect(() => replica.controlForRuntime()).toThrow(/expired/);
  } finally { admission.mockRestore(); vi.useRealTimers(); }
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

async function fixture(subjectPersonId?: string, applied = false) {
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
      ...(applied ? { applied: board.preset!.bindings["status.applied"]! } : {}),
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
  const signer = await receiptSigner();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const blind = {
    origin: "https://rusty.example.test", scopeId: "opaque-scope", servicePublicKey: signer.publicKey, readToken: "read", writeToken: "write",
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

it.each([0, 9])("Given a new confirmed application, signed Applied scope and %s existing vacancies, When forwarded mail is processed, Then create one Applied card and deduplicate delivery", async existing => {
  const id = `receipt-${crypto.randomUUID()}`;
  const stub = (env as WorkerEnv).AUTOMATION.getByName(id);
  const identitySecret = "test-only-identity-secret-at-least-thirty-two-bytes";
  const storageSecret = "test-only-storage-secret-at-least-thirty-two-bytes";
  const identity = await stub.provisionIdentity(id, identitySecret);
  const data = await typedFixture(identity.identity.personId, true);
  let document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(data.packet.initial.document));
  for (let index = 0; index < existing; index++) {
    const added = await executeCommand(document, { kind: "createItem", parentId: data.packet.bindings.columns.lead,
      title: `Old vacancy ${index}`, body: "", values: { [data.packet.bindings.fieldIds.company]: "Example GmbH",
        [data.packet.bindings.fieldIds.role]: `Other role ${index}`, [data.packet.bindings.fieldIds.jobUrl]: `https://jobs.example.test/old-${index}` } }, data.owner);
    if (!added.ok) throw new Error(added.error.message);
    Automerge.free(document); document = added.value.newDoc;
  }
  data.packet.initial = await ownerSnapshot(document, data.owner, data.packet);
  Automerge.free(document);
  const sync = vi.spyOn(AutomationReplica.prototype, "sync").mockResolvedValue();
  const testEnv = { ...env, IDENTITY_STORAGE_SECRET: identitySecret, EVENT_STORAGE_SECRET: storageSecret,
    AI: receiptAi, INTEGRATIONS_JSON: JSON.stringify([{ id, workspaceId: data.packet.workspaceId,
      scope: { version: 1, ...data.packet.bindings, expiresAt: "2099-01-01T00:00:00.000Z" },
      emailAddress: "intake@example.test", allowedForwarders: ["owner@example.test"] }]) } as unknown as WorkerEnv;
  const mime = `From: noreply@example.test\r\nTo: owner@example.test\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <new-application@example.test>\r\nSubject: Application received\r\nContent-Type: text/plain\r\n\r\nWe received your application for Senior Engineer at Example GmbH. https://jobs.example.test/42`;
  const deliver = () => worker.email({ from: "owner@example.test", to: "intake@example.test", rawSize: mime.length,
    raw: new Response(mime).body!, setReject: (reason: string) => { throw new Error(reason); } } as ForwardableEmailMessage, testEnv);
  const eventId = await blindHash(new TextEncoder().encode(`${id}:email:<new-application@example.test>`));
  try {
    await stub.activateReplica(id, identitySecret, storageSecret, data.packet);
    await deliver();
    await runInDurableObject(stub, async (instance, ctx) => {
      Reflect.set(instance, "env", testEnv);
      Reflect.set(instance, "jobPageFetcher", () => async () => new Response('<script type="application/ld+json">{"@type":"JobPosting","title":"Senior Engineer","hiringOrganization":{"name":"Example GmbH"},"description":"Build software"}</script>', { headers: { "content-type": "text/html" } }));
      await instance.alarm();
      expect(instance.getEvent(eventId)).toMatchObject({ status: "applied", result: { action: { columnId: data.packet.bindings.columns.applied } } });
      await ctx.storage.deleteAlarm();
    });
    await deliver();
    const stored = JSON.parse((await stub.loadReplicaState(storageSecret))!);
    const document = Automerge.load<WorkspaceDocumentV2>(decodeBlindBytes(stored.rawDocument));
    const cards = Object.values(document.entities).filter(isItem);
    expect(cards).toHaveLength(existing + 1);
    expect(cards.find(card => card.placement.parentId === data.packet.bindings.columns.applied)).toMatchObject({ placement: { parentId: data.packet.bindings.columns.applied },
      values: { [data.packet.bindings.fieldIds.role]: "Senior Engineer" } });
    Automerge.free(document);
    await runInDurableObject(stub, async (_instance, ctx) => { await ctx.storage.deleteAlarm(); });
  } finally { sync.mockRestore(); }
});

it.each([false, true])("Given an overdue alarm and website=%s intake, when new work arrives, then it rearms a future alarm without losing queued work", async website => {
  const stub = (env as WorkerEnv).AUTOMATION.getByName(`overdue-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance, ctx) => {
    await ctx.storage.setAlarm(Date.now() - 60_000);
    const input = { eventId: "new-work", sourceId: "new-work", bodyHash: "hash", payload: "pending-payload" };
    if (website) await instance.enqueueWebsite({ ...input, nonce: "nonce", challengeExpiresAt: Date.now() + 60_000 });
    else await instance.enqueueEmail(input);
    expect(instance.getEvent(input.eventId)?.status).toBe("pending");
    expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
    await ctx.storage.deleteAlarm();
  });
});

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
      const access = vi.spyOn(WasmStateCore, "decideWorkspaceAccess");
      try {
        const firstNonce = crypto.randomUUID(), secondNonce = crypto.randomUUID();
        const first = await instance.observeOwner(registration, firstNonce, "https://automation.example.test");
        const second = await instance.observeOwner(registration, secondNonce, "https://automation.example.test");
        expect(first?.signed.payload.nonce).toBe(firstNonce);
        expect(second?.signed.payload.nonce).toBe(secondNonce);
        expect(restore).toHaveBeenCalledTimes(1);
        expect(access).toHaveBeenCalledTimes(1);
        const state = JSON.parse((await instance.loadReplicaState(storageSecret))!);
        state.authorizations = [];
        await instance.saveReplicaState(storageSecret, JSON.stringify(state));
        await expect(instance.observeOwner(registration, crypto.randomUUID(), "https://automation.example.test")).rejects.toThrow();
        expect(restore).toHaveBeenCalledTimes(2);
      } finally { restore.mockRestore(); access.mockRestore(); await ctx.storage.deleteAlarm(); }
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

async function signedReceipt(access: Parameters<ReplicaTransport["upload"]>[0], object: Parameters<ReplicaTransport["upload"]>[1], requestId?: string): Promise<BlindReceipt> {
  const signer = await receiptSigner();
  if (access.servicePublicKey !== signer.publicKey) throw new Error("Receipt signer must match the pinned service key");
  const payload = { kind: "blind-storage-receipt" as const, version: 2 as const, serviceId: signer.serviceId,
    scopeId: access.scopeId, keyEpoch: object.keyEpoch, objectId: await blindObjectId(object),
    sequence: 1, policyRevision: access.policyRevision, requestId: requestId ?? "request-1" };
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", signer.pair.privateKey,
    new TextEncoder().encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)));
  return { payload, signerKeyId: signer.serviceId, signature: encodeBlindBytes(signature) };
}

let receiptSignerPromise: ReturnType<typeof createReceiptSigner> | undefined;
function receiptSigner() { return receiptSignerPromise ??= createReceiptSigner(); }
async function createReceiptSigner() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, publicKey: encodeBlindBytes(publicKey), serviceId: await blindHash(publicKey) };
}

describe("AutomationReplica in workerd with the compiled Rust policy", () => {
  it("Given a remote attachment index, when the Worker pulls, writes, and restarts, then opaque locators persist and advance snapshot revision", async () => {
    const { automation, packet, persisted, key } = await fixture();
    const remote: { object?: Awaited<ReturnType<typeof encryptBlindObject>> } = {};
    let sequence = 0;
    const uploadedSnapshots: Array<{ attachments?: AttachmentLocator[]; objectId: string }> = [];
    let loseNextUpload = false;
    const transport: ReplicaTransport = {
      inventory: async (_access, after) => remote.object && after < sequence
        ? { objects: [{ objectId: await blindObjectId(remote.object), sequence }], cursor: sequence, hasMore: false }
        : { objects: [], cursor: after, hasMore: false },
      download: async (_access, objectId) => {
        if (!remote.object || objectId !== await blindObjectId(remote.object)) throw new Error("Remote snapshot missing");
        return remote.object;
      },
      upload: async (access, object, requestId) => {
        const plaintext = await decryptBlindObject(object, packet.blind.scopeId, packet.blind.keyEpoch, key);
        uploadedSnapshots.push({ ...(JSON.parse(new TextDecoder().decode(plaintext)) as { attachments?: AttachmentLocator[] }),
          objectId: await blindObjectId(object) });
        if (loseNextUpload) { loseNextUpload = false; throw new Error("Upload receipt lost"); }
        return signedReceipt(access, object, requestId);
      },
    };
    packet.transport = transport;
    const replica = await AutomationReplica.activate(packet, automation);
    const initialRevision = JSON.parse(replica.serialize()).replication.contentRevision as string;
    const locator: AttachmentLocator = { version: 1, blobId: `sha256:${"A".repeat(43)}`,
      transferId: "attachment-transfer-one", manifestId: "B".repeat(43) };
    remote.object = await encryptBlindObject(packet.blind.scopeId, packet.blind.keyEpoch, key,
      new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: packet.workspaceId,
        ...packet.initial, chat: null, attachments: [locator] })));
    sequence = 1;

    await replica.sync();
    const pulled = JSON.parse(replica.serialize()) as { attachments: AttachmentLocator[]; replication: { contentRevision: string } };
    expect(pulled.attachments).toEqual([locator]);
    expect(pulled.replication.contentRevision).not.toBe(initialRevision);

    loseNextUpload = true;
    await replica.createLead("attachment-index-local-write", { company: "Acme", role: "Engineer" }, {});
    await expect(replica.sync()).rejects.toThrow("Upload receipt lost");
    expect(uploadedSnapshots.at(-1)?.attachments).toEqual([locator]);
    const pendingState = JSON.parse(replica.serialize()) as { replication: { contentRevision: string }; pending: { object: Awaited<ReturnType<typeof encryptBlindObject>> } };
    expect(pendingState.pending.object).toBeDefined();
    const pendingPlaintext = await decryptBlindObject(pendingState.pending.object, packet.blind.scopeId, packet.blind.keyEpoch, key);
    expect((JSON.parse(new TextDecoder().decode(pendingPlaintext)) as { attachments?: AttachmentLocator[] }).attachments).toEqual([locator]);

    const restored = await AutomationReplica.restore(replica.serialize(), automation, async value => { persisted.push(value); }, transport);
    await restored.sync();
    const afterRestart = JSON.parse(restored.serialize()) as { attachments: AttachmentLocator[]; replication: { contentRevision: string } };
    expect(afterRestart.attachments).toEqual([locator]);
    expect(afterRestart.replication.contentRevision).toBe(pendingState.replication.contentRevision);
    expect(uploadedSnapshots.at(-1)?.attachments).toEqual([locator]);
    expect(uploadedSnapshots.at(-1)?.objectId).toBe(uploadedSnapshots.at(-2)?.objectId);
  });

  it("Given a conflicting attachment transfer in a remote snapshot, when the Worker pulls, then it rejects without durable mutation", async () => {
    const { automation, packet, persisted, key } = await fixture();
    const replica = await AutomationReplica.activate(packet, automation);
    const before = replica.serialize();
    const durableWrites = persisted.length;
    const first: AttachmentLocator = { version: 1, blobId: `sha256:${"A".repeat(43)}`,
      transferId: "same-transfer", manifestId: "B".repeat(43) };
    const conflict = { ...first, manifestId: "C".repeat(43) };
    const remoteObject = await encryptBlindObject(packet.blind.scopeId, packet.blind.keyEpoch, key,
      new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: packet.workspaceId,
        ...packet.initial, chat: null, attachments: [first, conflict] })));
    packet.transport = {
      inventory: async (_access, after) => after === 0
        ? { objects: [{ objectId: await blindObjectId(remoteObject), sequence: 1 }], cursor: 1, hasMore: false }
        : { objects: [], cursor: after, hasMore: false },
      download: async () => remoteObject,
      upload: signedReceipt,
    };
    await expect(replica.sync()).rejects.toThrow();
    expect(replica.serialize()).toBe(before);
    expect(persisted).toHaveLength(durableWrites);
  });

  it("Given browser-supplied storage metadata, when the Worker pulls and uploads through its real adapter, then requests identify automation without claiming a browser build", async () => {
    const { automation, packet, key } = await fixture();
    packet.blind.client = "tincanban";
    packet.blind.clientBuild = "f".repeat(40);
    const signer = await receiptSigner();
    packet.blind.servicePublicKey = signer.publicKey;
    const serviceId = signer.serviceId;
    const remote = await encryptBlindObject(packet.blind.scopeId, packet.blind.keyEpoch, key,
      new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId: packet.workspaceId,
        ...packet.initial, chat: null })));
    let remoteObject = remote;
    let remoteSequence = 1;
    const requests: Array<{ method: string; url: string; headers: Headers }> = [];
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      requests.push({ method, url, headers });
      if (url.includes("?after=")) {
        const after = Number(new URL(url).searchParams.get("after"));
        return Response.json(after < remoteSequence
          ? { objects: [{ objectId: await blindObjectId(remoteObject), sequence: remoteSequence }], cursor: remoteSequence, hasMore: false }
          : { objects: [], cursor: after, hasMore: false });
      }
      if (method === "GET") return Response.json(remoteObject);
      const object = JSON.parse(String(init?.body));
      const payload = { kind: "blind-storage-receipt" as const, version: 2 as const, serviceId,
        scopeId: packet.blind.scopeId, keyEpoch: packet.blind.keyEpoch, objectId: await blindObjectId(object),
        sequence: 2, policyRevision: packet.blind.policyRevision, requestId: headers.get("X-Rusty-Request-Id")! };
      const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", signer.pair.privateKey,
        new TextEncoder().encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)));
      remoteObject = object;
      remoteSequence += 1;
      return Response.json({ payload, signerKeyId: serviceId, signature: encodeBlindBytes(signature) });
    });
    try {
      const replica = await AutomationReplica.activate(packet, automation);
      await replica.sync();
      expect(requests.map(request => request.method)).toEqual(["GET", "GET"]);
      await replica.createLead("header-contract-lead", { company: "Acme", role: "Engineer" }, {});
      await replica.sync();
      expect(requests.map(request => request.method)).toEqual(["GET", "GET", "GET", "PUT"]);
      expect(new URL(requests.at(-1)!.url).searchParams.get("writerVersion")).toBe("2");
      for (const request of requests) {
        expect(request.headers.get("X-Rusty-Client")).toBe("automation");
        expect(request.headers.get("X-Rusty-Build")).toBeNull();
      }
      expect(requests.at(-1)?.headers.get("X-Rusty-Request-Id")).toMatch(/^[0-9a-f-]{36}$/i);
      expect(JSON.parse(replica.serialize()).pending).toBeUndefined();
    } finally { network.mockRestore(); }
  });

  it.each([false, true])("Given a legacy pending snapshot and changed document=%s, when retrying after upgrade, then old ciphertext completes before newer content uploads", async changed => {
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
      upload: async (access, object, requestId) => { uploads.push(await blindObjectId(object)); return signedReceipt(access, object, requestId); },
    };
    const restored = await AutomationReplica.restore(JSON.stringify(state), automation, async value => { persisted.push(value); }, transport);
    if (changed) await restored.createLead("changed-legacy-pending", { company: "Acme", role: "Engineer" }, {});
    await restored.sync();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toBe(await blindObjectId(legacyObject));
    expect(JSON.parse(restored.serialize()).pending).toBeUndefined();
    await restored.sync();
    expect(uploads).toHaveLength(changed ? 2 : 1);
    if (changed) expect(uploads[1]).not.toBe(await blindObjectId(legacyObject));
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
      upload: async (access, object, requestId) => { objects.push(object); return signedReceipt(access, object, requestId); },
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
    const remote: { object?: Awaited<ReturnType<typeof encryptBlindObject>>; sequence: number } = { sequence: 0 };
    const transport: ReplicaTransport = {
      inventory: async (_access, after) => remote.object && after < remote.sequence
        ? { objects: [{ objectId: await blindObjectId(remote.object), sequence: remote.sequence }], cursor: remote.sequence, hasMore: false }
        : { objects: [], cursor: after, hasMore: false },
      download: async (_access, objectId) => {
        if (!remote.object || objectId !== await blindObjectId(remote.object)) throw new Error("Remote snapshot missing");
        return remote.object;
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
    remote.object = await encryptBlindObject(packet.blind.scopeId, packet.blind.keyEpoch,
      decodeBlindBytes(packet.blind.contentKey), new TextEncoder().encode(JSON.stringify(snapshot)));
    remote.sequence = 1;
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
      upload: async (access, object, requestId) => {
        const saved = JSON.parse(persisted.at(-1)!) as { pending?: { object: unknown } };
        expect(saved.pending?.object).toEqual(object);
        uploaded.push(await blindObjectId(object));
        uploadAttempt += 1;
        if (uploadAttempt === 1) throw new Error("Response lost after durable save");
        return signedReceipt(access, object, requestId);
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
