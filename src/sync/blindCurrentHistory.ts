import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { decodeBlindBytes } from "./blindEnvelope"

/** A repeated identical attestation is an active-tail merge, never a new child baseline or coverage assertion. */
export async function mergeCurrentBlindHistory(input: { previous?: WasmVerifiedReceivedHistoryBaseline; signedJson: string;
  document: Uint8Array; authorization: unknown; ensureCurrent(): Promise<void>;
  onSameBaseline?: () => Promise<void>;
  merge(document: Uint8Array, authorization: unknown, basis: WasmVerifiedReceivedHistoryBaseline): Promise<void> }): Promise<boolean> {
  if (!input.previous) return false
  const signed = decodeBlindBytes(input.signedJson), known = input.previous.originalJson()
  if (signed.length !== known.length || !signed.every((value, index) => value === known[index])) return false
  await input.ensureCurrent()
  await input.onSameBaseline?.()
  await input.ensureCurrent()
  await input.merge(input.document, input.authorization, input.previous)
  await input.ensureCurrent()
  return true
}
