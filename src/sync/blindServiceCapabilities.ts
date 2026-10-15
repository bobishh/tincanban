export type BlindServiceCapabilities = { modes: string[]; applicationWrites: boolean; classification: boolean;
  snapshotCheckpoints?: { version: number; observedSequence?: boolean }; scopeManagement?: { version: number }; personManagement?: unknown; encryptedBlobs?: unknown;
  writerPolicy?: unknown; scopeEnrollmentRetry?: unknown; blobCoverage?: unknown; encryptedArchives?: unknown; archiveCoverageBatches?: unknown; archiveCoverageAggregates?: unknown }

function supportedEncryptedBlobs(capabilities: BlindServiceCapabilities): { version: 1; maximumCiphertextBytes: number } | undefined {
  if (!Object.hasOwn(capabilities, "encryptedBlobs")) return undefined
  const value = capabilities.encryptedBlobs
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "version") || !Object.hasOwn(value, "maximumCiphertextBytes")) {
    throw new Error("Rusty encrypted blob protocol upgrade required")
  }
  const version = (value as { version?: unknown }).version
  const maximumCiphertextBytes = (value as { maximumCiphertextBytes?: unknown }).maximumCiphertextBytes
  if (version !== 1 || !Number.isSafeInteger(maximumCiphertextBytes) || (maximumCiphertextBytes as number) < 1 ||
    (maximumCiphertextBytes as number) > 1_048_592) throw new Error("Rusty encrypted blob protocol upgrade required")
  return { version: 1, maximumCiphertextBytes: maximumCiphertextBytes as number }
}

function supportsScopeManagement(capabilities: BlindServiceCapabilities): boolean {
  if (!Object.hasOwn(capabilities, "scopeManagement")) return false
  if (capabilities.scopeManagement?.version !== 1) throw new Error("Rusty management protocol upgrade required")
  return true
}

function supportedSingleVersion(capabilities: BlindServiceCapabilities, name: "scopeEnrollmentRetry" | "personManagement", message: string) {
  const value = capabilities[name]
  if (Object.hasOwn(capabilities, name) && (!value || typeof value !== "object" || Array.isArray(value) ||
      (value as { version?: unknown }).version !== 1 || Object.keys(value).length !== 1)) throw new Error(message)
  return value !== undefined
}

export function supportedManagementFeatures(capabilities: BlindServiceCapabilities): { snapshotCheckpoints?: 1; snapshotWriteFence?: 1; scopeManagement?: 1; personManagement?: 1; scopeEnrollmentRetry?: 1;
  encryptedBlobs?: { version: 1; maximumCiphertextBytes: number }; writerPolicy?: { version: 1; maximumWriterVersion: 2 };
  blobCoverage?: { version: 1; maximumObjects: 33 };
  encryptedArchives?: { version: 1; maximumCiphertextBytes: 262160 }; archiveCoverageBatches?: { version: 1; maximumObjects: 64 };
  archiveCoverageAggregates?: { version: 1; maximumChildren: 8; maximumHeight: 31 } } {
  const scopeManagement = supportsScopeManagement(capabilities)
  const scopeEnrollmentRetry = supportedSingleVersion(capabilities, "scopeEnrollmentRetry", "Rusty scope enrollment retry protocol upgrade required")
  const personManagement = supportedSingleVersion(capabilities, "personManagement", "Rusty person management protocol upgrade required")
  const blobCapability = supportedEncryptedBlobs(capabilities)
  const blobCoverage = supportedBlobCoverage(capabilities)
  const writerPolicy = supportedWriterPolicy(capabilities)
  return { ...(capabilities.snapshotCheckpoints?.version === 1 ? { snapshotCheckpoints: 1 as const,
    ...(capabilities.snapshotCheckpoints.observedSequence === true ? { snapshotWriteFence: 1 as const } : {}) } : {}),
    ...(scopeManagement ? { scopeManagement: 1 as const } : {}),
    ...(scopeEnrollmentRetry ? { scopeEnrollmentRetry: 1 as const } : {}),
    ...(personManagement ? { personManagement: 1 as const } : {}), ...(blobCapability ? { encryptedBlobs: blobCapability } : {}),
    ...(blobCoverage ? { blobCoverage } : {}),
    ...(writerPolicy ? { writerPolicy } : {}), ...supportedArchiveFeatures(capabilities) }
}

function supportedArchiveFeatures(capabilities: BlindServiceCapabilities) {
  const encryptedArchives = supportedEncryptedArchives(capabilities)
  const archiveCoverageBatches = supportedArchiveCoverageBatches(capabilities)
  const archiveCoverageAggregates = supportedArchiveCoverageAggregates(capabilities)
  return { ...(encryptedArchives ? { encryptedArchives } : {}), ...(archiveCoverageBatches ? { archiveCoverageBatches } : {}),
    ...(archiveCoverageAggregates ? { archiveCoverageAggregates } : {}) }
}

function supportedArchiveCapability<T extends Record<string, number>>(capabilities: BlindServiceCapabilities,
  name: "encryptedArchives" | "archiveCoverageBatches" | "archiveCoverageAggregates",
  expected: T): T | undefined {
  if (!Object.hasOwn(capabilities, name)) return undefined
  const value = capabilities[name]
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rusty archive protocol upgrade required")
  const record = value as Record<string, unknown>
  const keys = Object.keys(expected)
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key) || record[key] !== expected[key])) {
    throw new Error("Rusty archive protocol upgrade required")
  }
  return expected
}

function supportedEncryptedArchives(capabilities: BlindServiceCapabilities): { version: 1; maximumCiphertextBytes: 262160 } | undefined {
  return supportedArchiveCapability(capabilities, "encryptedArchives", { version: 1, maximumCiphertextBytes: 262160 })
}

function supportedArchiveCoverageBatches(capabilities: BlindServiceCapabilities): { version: 1; maximumObjects: 64 } | undefined {
  return supportedArchiveCapability(capabilities, "archiveCoverageBatches", { version: 1, maximumObjects: 64 })
}

function supportedArchiveCoverageAggregates(capabilities: BlindServiceCapabilities):
  { version: 1; maximumChildren: 8; maximumHeight: 31 } | undefined {
  return supportedArchiveCapability(capabilities, "archiveCoverageAggregates", { version: 1, maximumChildren: 8, maximumHeight: 31 })
}

function supportedBlobCoverage(capabilities: BlindServiceCapabilities): { version: 1; maximumObjects: 33 } | undefined {
  if (!Object.hasOwn(capabilities, "blobCoverage")) return undefined
  const value = capabilities.blobCoverage
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "version") || !Object.hasOwn(value, "maximumObjects") ||
    (value as { version?: unknown }).version !== 1 || (value as { maximumObjects?: unknown }).maximumObjects !== 33) {
    throw new Error("Rusty blob coverage protocol upgrade required")
  }
  return { version: 1, maximumObjects: 33 }
}

function supportedWriterPolicy(capabilities: BlindServiceCapabilities): { version: 1; maximumWriterVersion: 2 } | undefined {
  if (!Object.hasOwn(capabilities, "writerPolicy")) return undefined
  const value = capabilities.writerPolicy
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "version") || !Object.hasOwn(value, "maximumWriterVersion") ||
    (value as { version?: unknown }).version !== 1 || (value as { maximumWriterVersion?: unknown }).maximumWriterVersion !== 2) {
    throw new Error("Rusty writer policy upgrade required")
  }
  return { version: 1, maximumWriterVersion: 2 }
}
