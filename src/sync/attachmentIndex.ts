import { isValidBlobId } from "@meta-uber/mesh-blob"
import type { AttachmentLocator } from "./attachmentCodec"

const locatorKeys = ["blobId", "manifestId", "transferId", "version"]
const transferIdPattern = /^[A-Za-z0-9_-]{1,128}$/
const manifestIdPattern = /^[A-Za-z0-9_-]{43}$/
const maximumLocators = 1024

/** Read the private attachment index from a snapshot, accepting omission only for old snapshots. */
export function parseAttachmentLocators(value: unknown): AttachmentLocator[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximumLocators) throw new Error("Invalid attachment locator index")

  const byTransfer = new Map<string, AttachmentLocator>()
  for (const candidate of value) {
    const locator = readLocator(candidate)
    const key = `${locator.blobId}\0${locator.transferId}`
    const previous = byTransfer.get(key)
    if (previous && previous.manifestId !== locator.manifestId) {
      throw new Error("Conflicting attachment locator for one transfer")
    }
    byTransfer.set(key, locator)
  }

  return sortLocators([...byTransfer.values()])
}

function readLocator(value: unknown): AttachmentLocator {
  if (!isRecord(value) || !hasExactKeys(value, locatorKeys) || value.version !== 1 ||
    typeof value.blobId !== "string" || !isValidBlobId(value.blobId) ||
    typeof value.transferId !== "string" || !transferIdPattern.test(value.transferId) ||
    typeof value.manifestId !== "string" || !manifestIdPattern.test(value.manifestId)) {
    throw new Error("Invalid attachment locator")
  }
  return { version: 1, blobId: value.blobId, transferId: value.transferId, manifestId: value.manifestId }
}

/** Union immutable transfers, retaining distinct transfers for the same blob. */
export function mergeAttachmentLocators(...arrays: unknown[]): AttachmentLocator[] {
  const merged = new Map<string, AttachmentLocator>()
  for (const value of arrays) {
    for (const locator of parseAttachmentLocators(value)) {
      const key = `${locator.blobId}\0${locator.transferId}`
      const previous = merged.get(key)
      if (previous && previous.manifestId !== locator.manifestId) {
        throw new Error("Conflicting attachment locator for one transfer")
      }
      merged.set(key, locator)
      if (merged.size > maximumLocators) throw new Error("Attachment locator index exceeds its size limit")
    }
  }
  return sortLocators([...merged.values()])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function sortLocators(locators: AttachmentLocator[]): AttachmentLocator[] {
  return locators.sort((left, right) => compareStrings(left.blobId, right.blobId) ||
    compareStrings(left.transferId, right.transferId) || compareStrings(left.manifestId, right.manifestId))
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
