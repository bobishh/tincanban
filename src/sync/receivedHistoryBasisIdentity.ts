import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"

/** Cache coordinates come from the opaque Native handle, never a peer-supplied marker. */
export function receivedHistoryBasisIdentity(basis?: WasmVerifiedReceivedHistoryBaseline) {
  if (!basis) return null
  const envelope = basis.envelope() as { payload?: { baselineId?: unknown; genesisHash?: unknown } }
  return { baselineId: envelope.payload?.baselineId ?? null, genesisHash: envelope.payload?.genesisHash ?? null }
}
