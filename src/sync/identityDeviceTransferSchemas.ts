import { z } from "zod"
import { isMemberProfileData } from "../domain/avatarData"
import type { PersonalRootDocumentV1 } from "../domain/model"

const text = z.string().min(1).max(512)
export const deviceCertificateSchema = z.object({
  payload: z.object({ kind: z.literal("device-certificate"), version: z.literal(1), personId: text,
    deviceId: text, devicePublicKey: text, issuerCertificateHash: text.nullable(), canEnrollDevices: z.boolean() }).strict(),
  signerKeyId: text, signature: text,
}).strict()
export const publicIdentitySchema = z.object({ personId: text, publicKey: text, displayName: text }).strict()
const boundedRecord = <T extends z.ZodType>(schema: T) => z.record(z.string(), schema)
  .refine(value => Object.keys(value).length <= 512, "Device-state map exceeds limit")
const keeperIntegrationSchema = z.object({
  integrationId: text, serviceOrigin: text, servicePersonId: text, serviceDeviceId: text, servicePublicKey: text,
  serviceCertificates: z.array(deviceCertificateSchema).max(32), workspaceIds: z.array(text).max(512),
  scopeReceipts: z.array(z.object({ workspaceId: text, grantEpoch: z.number().int().positive(), activationOperationId: text })).max(512).optional(),
  futureBoards: z.boolean(), futureBoardBaselineIds: z.array(text).max(512).optional(), revision: z.number().int().nonnegative(),
  state: z.enum(["active", "removing", "removed"]), verifiedAt: text,
  pendingRemoval: z.object({ operationId: text, expectedRevision: z.number().int().nonnegative(),
    scopes: z.array(z.object({ workspaceId: text, expectedGrantEpoch: z.number().int().positive() })).max(512) }).passthrough().optional(),
}).passthrough()
export const personalRootTransferSchema = z.object({ kind: z.literal("personal-root"), formatVersion: z.literal(1), rootId: text,
  identity: publicIdentitySchema,
  photo: z.custom<PersonalRootDocumentV1["photo"]>(value => isMemberProfileData(JSON.stringify(value))).optional(),
  displayNamePreset: z.string().min(1).max(256).optional(),
  devices: boundedRecord(z.object({ deviceId: text, publicKey: text, displayName: text, certificateHash: text, addedAt: text }).strict()),
  workspaces: boundedRecord(z.object({ workspaceId: text, documentId: text, grantHash: text, forgotten: z.boolean() }).strict()),
  keeperIntegrations: boundedRecord(keeperIntegrationSchema).optional(),
}).passthrough()
export const deviceWorkspaceTransferSchema = z.object({
  workspaces: z.array(z.object({ id: text, title: text }).strict()).min(1).max(512), activeWorkspaceId: text,
  meshWorkspaces: z.array(z.object({ workspaceId: text, ownerPersonId: text, ownerPublicKey: text }).passthrough()).max(512),
  grants: z.array(z.object({ payload: z.object({ kind: z.literal("workspace-grant"), version: z.literal(1), grantId: text,
    workspaceId: text, personId: text, role: z.enum(["owner", "editor", "visitor"]), accessEpoch: z.number().int().positive().optional() }),
    signerKeyId: text, signature: text }).passthrough()).max(512),
}).strict()
