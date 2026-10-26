import { parsePrivateReplicaWire } from "./privateReplicaPreferences"

type IdentityDeviceComponentName = "identityCatalog" | "profileObservations" | "workspaceReferences" |
  "privateConnections" | "ownerCapabilities" | "recoveryEvidence" | "identityAuthority"
export type IdentityDeviceComponent = { schema: string; required: boolean; value: Record<string, unknown> }
export type IdentityDeviceStateInput = {
  kind: "identity-device-state"
  version: 1
  personId: string
  components: Record<string, IdentityDeviceComponent>
}
export type IdentityDeviceState = IdentityDeviceStateInput

const supportedSchemas: Record<IdentityDeviceComponentName, string> = {
  identityCatalog: "identity-catalog@1",
  profileObservations: "profile-observations@3",
  workspaceReferences: "entitled-workspaces@1",
  privateConnections: "private-rusty-connections@5",
  ownerCapabilities: "owner-capabilities@2",
  recoveryEvidence: "identity-recovery-evidence@1",
  identityAuthority: "identity-authority-view@1",
}
const componentNames = Object.keys(supportedSchemas) as IdentityDeviceComponentName[]
const legacySchemas: Partial<Record<IdentityDeviceComponentName, readonly string[]>> = {
  privateConnections: ["private-rusty-connections@3", "private-rusty-connections@4"], ownerCapabilities: ["owner-capabilities@1"], profileObservations: ["profile-observations@1", "profile-observations@2"],
}
const rawPrivateFieldNames = new Set(["privatekey", "privatekeys", "identityprivatekey", "deviceprivatekey", "recoverykey", "identityseed", "deviceseed",
  "privatekeypkcs", "identityprivatekeypkcs", "deviceprivatekeypkcs", "privatekeyjwk", "identityprivatekeyjwk", "deviceprivatekeyjwk"])
const localProgressFieldNames = new Set(["cursor", "lastuploaded", "uploadedrevision", "contentidentity", "replication", "progress"])
const portableCredentialFieldNames = new Set(["readtoken", "writetoken", "contentkey", "historicalcontentkeys", "historicalcontentkeyvariants"])
const maximumManifestBytes = 1024 * 1024

export class IdentityDeviceStateUpgradeRequiredError extends Error {
  readonly code = "identity-device-state-upgrade-required"
  constructor(message: string) { super(message); this.name = "IdentityDeviceStateUpgradeRequiredError" }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value as object) as object | null
  return prototype === Object.prototype || prototype === null
}

function identity(value: unknown): string | undefined { return isRecord(value) && typeof value.personId === "string" ? value.personId : undefined }

function validatePersonId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid device-state identity")
}

function normalizedField(key: string): string { return key.toLowerCase().replace(/[^a-z]/g, "") }

function validatePortableField(name: string, item: unknown, path: string, privateConnections: boolean): void {
  if (rawPrivateFieldNames.has(name)) throw new Error("Device state cannot export private keys or recovery secrets")
  if (privateConnections) {
    if (localProgressFieldNames.has(name) && !allowedZeroProgressField(name, item, path)) {
      throw new Error("Device-local cursor or replication progress cannot be synchronized")
    }
  } else if (localProgressFieldNames.has(name) || portableCredentialFieldNames.has(name)) {
    throw new Error("Device-local progress or private connection credentials cannot appear in this component")
  }
}

function allowedZeroProgressField(name: string, item: unknown, path: string): boolean {
  return path.includes(".config") && ((name === "cursor" && item === 0) || (name === "lastuploaded" && item === ""))
}

function inspectPortableData(value: unknown, path: string, privateConnections = false): void {
  if (Array.isArray(value)) return value.forEach((item, index) => inspectPortableData(item, `${path}[${index}]`, privateConnections))
  if (!isRecord(value)) return
  Object.entries(value).forEach(([key, item]) => {
    validatePortableField(normalizedField(key), item, path, privateConnections)
    inspectPortableData(item, `${path}.${key}`, privateConnections)
  })
}

function validateComponentShape(name: string, component: IdentityDeviceComponent): void {
  if (!isRecord(component) || typeof component.schema !== "string" || typeof component.required !== "boolean" || !isRecord(component.value) ||
    Object.keys(component).some(key => !["schema", "required", "value"].includes(key))) {
    throw new Error(`Invalid identity device-state component: ${name}`)
  }
}

/** Forward optional components as opaque data; required state cannot hide inside an extension. */
export function validateOptionalIdentityComponent(name: string, component: IdentityDeviceComponent): IdentityDeviceComponent & { required: false } {
  validateComponentShape(name, component)
  if (component.required || Object.hasOwn(supportedSchemas, name)) throw new Error("Invalid optional identity component")
  inspectPortableData(component.value, `components.${name}`)
  return { ...structuredClone(component), required: false }
}

function validateKnownComponentValue(name: IdentityDeviceComponentName, value: Record<string, unknown>, personId: string): void {
  if (name === "identityAuthority") {
    validateIdentityAuthorityComponent(value, personId)
    inspectPortableData(value, `components.${name}`)
    return
  }
  if (identity(value) !== personId) throw new Error(`Identity mismatch in device-state component ${name}`)
  if (name === "privateConnections") {
    validatePortableConnectionProgress(value)
    const parsed = parsePrivateReplicaWire(value)
    if (parsed.personId !== personId) throw new Error("Private connection identity mismatch")
    inspectPortableData(value, `components.${name}`, true)
  } else inspectPortableData(value, `components.${name}`)
  validateRequiredList(name, value)
}

function validateRequiredList(name: IdentityDeviceComponentName, value: Record<string, unknown>): void {
  const field = ({ profileObservations: "observations", workspaceReferences: "workspaces", ownerCapabilities: "capabilities",
    recoveryEvidence: "envelopes" } as Partial<Record<IdentityDeviceComponentName, string>>)[name]
  if (field && !Array.isArray(value[field])) throw new Error(`Invalid ${name} component`)
}

const privateWireVersions: Record<string, number> = { "private-rusty-connections@3": 3, "private-rusty-connections@4": 4 }
function validateComponent(name: string, component: IdentityDeviceComponent, personId: string): IdentityDeviceComponent {
  validateComponentShape(name, component)
  const expected = Object.hasOwn(supportedSchemas, name) ? supportedSchemas[name as IdentityDeviceComponentName] : undefined
  if (!expected) {
    if (component.required) throw new IdentityDeviceStateUpgradeRequiredError(`Required component ${component.schema} is not supported`)
    return validateOptionalIdentityComponent(name, component)
  }
  const legacy = legacySchemas[name as IdentityDeviceComponentName]?.includes(component.schema) === true
  if (component.schema !== expected && !legacy) {
    throw new IdentityDeviceStateUpgradeRequiredError(`Unsupported schema for required component ${name}`)
  }
  if (name === "ownerCapabilities" && legacy && containsPersonCapability(component.value)) {
    throw new IdentityDeviceStateUpgradeRequiredError("Person management capabilities require owner-capabilities@2")
  }
  const privateWireVersion = privateWireVersions[component.schema] ?? 5
  if (name === "privateConnections" && component.value.version !== privateWireVersion) {
    throw new IdentityDeviceStateUpgradeRequiredError("Private connection wire version does not match its schema")
  }
  if (component.required !== true) throw new Error(`Required identity device-state component ${name} cannot be optional`)
  validateKnownComponentValue(name as IdentityDeviceComponentName, component.value, personId)
  return structuredClone(component)
}

function containsPersonCapability(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.capabilities)) return false
  return value.capabilities.some(item => {
    if (!isRecord(item)) return false
    const binding = isRecord(item.binding) ? item.binding : undefined
    const capability = isRecord(item.capability) ? item.capability : undefined
    const payload = capability && isRecord(capability.payload) ? capability.payload : undefined
    return binding?.resourceKind === "person" || payload?.kind === "rusty-person-management-capability"
  })
}

function validatePortableConnectionProgress(value: Record<string, unknown>): void {
  const entries = value.entries
  if (!Array.isArray(entries)) return
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.operations)) continue
    for (const operation of entry.operations) {
      if (!isRecord(operation) || operation.config === null || !isRecord(operation.config)) continue
      if (operation.config.cursor !== 0 || operation.config.lastUploaded !== "") {
        throw new Error("Device-local cursor or upload acknowledgment cannot be synchronized")
      }
    }
  }
}

function validateState(value: unknown, expectedPersonId: string): IdentityDeviceState {
  validatePersonId(expectedPersonId)
  if (isRecord(value) && value.kind === "identity-device-state" && value.version !== 1) {
    throw new IdentityDeviceStateUpgradeRequiredError("Unsupported identity device-state manifest version")
  }
  if (!isRecord(value) || value.kind !== "identity-device-state" || value.personId !== expectedPersonId ||
    !isRecord(value.components) || Object.keys(value).some(key => !["kind", "version", "personId", "components"].includes(key))) {
    throw new Error("Invalid identity device-state manifest or identity mismatch")
  }
  const components = value.components
  for (const name of componentNames) {
    if (!(name in components)) throw new IdentityDeviceStateUpgradeRequiredError(`Required component ${name} is missing`)
  }
  const checkedEntries = Object.entries(components).map(([name, component]) =>
    [name, validateComponent(name, component as IdentityDeviceComponent, expectedPersonId)] as const)
  const checked = Object.fromEntries(checkedEntries) as Record<string, IdentityDeviceComponent>
  return { kind: "identity-device-state", version: 1, personId: expectedPersonId, components: checked }
}

export function encodeIdentityDeviceState(value: IdentityDeviceStateInput): Uint8Array {
  const checked = validateState(value, value.personId)
  const text = JSON.stringify(checked)
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength > maximumManifestBytes) throw new Error("Identity device-state manifest exceeds size limit")
  return bytes
}

export function decodeIdentityDeviceState(input: Uint8Array | unknown, expectedPersonId: string): IdentityDeviceState {
  let value = input
  if (input instanceof Uint8Array) {
    if (input.byteLength > maximumManifestBytes) throw new Error("Identity device-state manifest exceeds size limit")
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)) }
    catch { throw new Error("Invalid identity device-state encoding") }
  } else {
    const text = JSON.stringify(input)
    if (text === undefined) throw new Error("Invalid identity device-state encoding")
    if (new TextEncoder().encode(text).byteLength > maximumManifestBytes) {
      throw new Error("Identity device-state manifest exceeds size limit")
    }
  }
  return validateState(value, expectedPersonId)
}

export const identityDeviceStateSchemas = Object.freeze({ ...supportedSchemas })

function validateIdentityAuthorityComponent(value: Record<string, unknown>, personId: string): void {
    const view = value.authorityView
    if (Object.keys(value).length !== 2 || value.personId !== personId || !isRecord(view) || view.personId !== personId ||
        view.kind !== "mesh-identity-authority-view" || view.version !== 1 || typeof view.identityPublicKey !== "string" ||
        !Array.isArray(view.certificates) || !Array.isArray(view.revocations) || !isRecord(view.revocationHead) ||
        !Number.isSafeInteger(view.revocationHead.revision) || typeof view.revocationHead.recordHash !== "string" ||
        typeof view.viewDigest !== "string") {
      throw new Error("Invalid or mismatched Identity authority view component")
    }
}
