import { expect, test, vi } from "vitest"
import { blindHash, discoverBlindKeeper } from "./blindClient"
import { encodeBlindBytes } from "./blindEnvelope"

test("Given advertised archive capabilities, when discovered, then accept only the exact v1 contracts", async () => {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))
  const origin = "https://rusty.example"
  const service = { serviceId: await blindHash(raw), publicKey: encodeBlindBytes(raw) }
  const capabilities = {
    encryptedArchives: { version: 1, maximumCiphertextBytes: 262160 },
    archiveCoverageBatches: { version: 1, maximumObjects: 64 },
    archiveCoverageAggregates: { version: 1, maximumChildren: 8, maximumHeight: 31 },
  }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ protocolVersions: [2], publicOrigin: origin, service,
    capabilities: { modes: ["blind"], applicationWrites: false, classification: false, ...capabilities } })))
  try {
    await expect(discoverBlindKeeper(origin)).resolves.toMatchObject(capabilities)
    for (const name of Object.keys(capabilities)) {
      const invalid = name === "encryptedArchives"
        ? [{ version: 2, maximumCiphertextBytes: 262160 }, { version: 1, maximumCiphertextBytes: 262159 }, { version: 1, maximumCiphertextBytes: 262160, extra: true }, null]
        : name === "archiveCoverageBatches"
          ? [{ version: 2, maximumObjects: 64 }, { version: 1, maximumObjects: 63 }, { version: 1, maximumObjects: 64, extra: true }, null]
          : [{ version: 2, maximumChildren: 8, maximumHeight: 31 }, { version: 1, maximumChildren: 7, maximumHeight: 31 },
            { version: 1, maximumChildren: 8, maximumHeight: 30 }, { version: 1, maximumChildren: 8, maximumHeight: 31, extra: true }, null]
      for (const value of invalid) {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({ protocolVersions: [2], publicOrigin: origin, service,
          capabilities: { modes: ["blind"], applicationWrites: false, classification: false, [name]: value } })))
        await expect(discoverBlindKeeper(origin)).rejects.toThrow(/archive protocol upgrade required/i)
      }
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ protocolVersions: [2], publicOrigin: origin, service,
        capabilities: { modes: ["blind"], applicationWrites: false, classification: false } })))
      await expect(discoverBlindKeeper(origin)).resolves.not.toHaveProperty(name)
    }
  } finally { vi.unstubAllGlobals() }
})
