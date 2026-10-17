import { profileFromIdentitySeedForDevice } from "../../../vendor/meta-mesh/packages/mesh-identity/src/index";
import { resolveSigningContext } from "../../../src/domain/signingContext";
import { createAutomationOwnerRequest } from "../../../src/domain/automationProtocol";

const integrationId = process.argv[2]!;
const profile = await profileFromIdentitySeedForDevice(crypto.getRandomValues(new Uint8Array(32)), "Owner", crypto.getRandomValues(new Uint8Array(32)));
const origin = "https://automation.example", workspaceId = "workspace";
const context = await resolveSigningContext({ profile, certificates: [profile.certificate], purpose: "automation-owner-request",
  binding: { origin, workspaceId, integrationId, action: "enroll" }, authorityRevision: "fixture-owner-policy",
  current: async () => ({ personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision: "fixture-owner-policy" }) });
const ownerRequest = await createAutomationOwnerRequest(context, { action: "enroll", origin, integrationId, workspaceId, bodyHash: null });
process.stdout.write(JSON.stringify({ ownerId: profile.identity.personId, body: { ownerRequest } }));
