import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"

/** Shared bounded accounting before fetching the next predecessor; no whole-chain allocation first. */
export class HistoryAncestorBudget {
  private bytes = 0
  constructor(private readonly maximum = 512 * 1024 * 1024) {}

  add(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.maximum - this.bytes) {
      throw new Error("Verified history ancestry exceeds its retention bound")
    }
    this.bytes += bytes
  }

  addBasis(basis: WasmVerifiedReceivedHistoryBaseline, includeDocument = true): void {
    if (includeDocument) this.add(basis.document().length)
    this.add(basis.originalJson().length)
    this.add(basis.controlJson().length)
    const proofs = basis.plaintextObjects() as Map<string, Uint8Array>
    for (const proof of proofs.values()) this.add(proof.length)
  }
}
