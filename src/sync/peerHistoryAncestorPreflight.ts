import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { HistoryAncestorBudget } from "./historyAncestorBudget"
import { decodeBlindBytes } from "./blindEnvelope"
import { verifyPeerReceivedHistoryBaseline } from "./peerHistoryBaselineReceiver"
import { captureVerifiedHistoryAncestors, type VerifiedHistoryAncestors } from "./verifiedHistoryAncestors"
import type { PeerHistoryObjectReader } from "./workspaceSetHistory"

function predecessor(basis: WasmVerifiedReceivedHistoryBaseline): string | undefined {
  const id = (basis.envelope() as { payload: { previousBaselineId?: unknown } }).payload.previousBaselineId
  if (id === undefined || id === null) return undefined
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error("Verified history predecessor is malformed")
  return id
}
function genesisAnchor(authority: unknown) {
  const genesis = (authority as { genesis?: unknown } | null)?.genesis
  if (!genesis) throw new Error("Peer history requires a signed genesis anchor")
  // Each historical control chain is checked independently, then Native verifies its exact edge to the newer basis.
  return { genesis: structuredClone(genesis), grants: [], grantIssuers: [], revocations: [], controlTransfers: [], successionTransfers: [] }
}

/** Fetch only bounded Native proof/bootstrap paths. No local state changes before whole-workspace admission. */
export async function preflightPeerHistoryAncestors(input: {
  workspaceId: string; candidate: WasmVerifiedReceivedHistoryBaseline; reader: PeerHistoryObjectReader
  trustedScopeAuthority: unknown; ensureCurrent(): void
}): Promise<VerifiedHistoryAncestors> {
  const parents: WasmVerifiedReceivedHistoryBaseline[] = [], visited = new Set<string>()
  let child = input.candidate
  const budget = new HistoryAncestorBudget()
  budget.addBasis(child)
  try {
    for (let depth = 0; depth <= 256; depth++) {
      input.ensureCurrent()
      const id = predecessor(child)
      if (!id) return captureVerifiedHistoryAncestors(input.candidate, parents)
      if (depth === 256 || visited.has(id)) throw new Error("Peer history ancestry exceeds its bound or contains a cycle")
      visited.add(id)
      await input.reader.authorizeHistoryAncestor?.(child)
      const descriptor = await input.reader.readBaseline(input.workspaceId, id)
      input.ensureCurrent()
      if (!descriptor || descriptor.baselineId !== id) throw new Error("Earlier history is incomplete: keep its source device connected")
      const document = await input.reader.readDocument(descriptor, input.workspaceId)
      input.ensureCurrent()
      if (!document) throw new Error("Earlier history document is unavailable")
      budget.add(document.length)
      const parent = await verifyPeerReceivedHistoryBaseline({ signedJson: decodeBlindBytes(descriptor.signedJson),
        baselineDocument: document, trustedScopeAuthority: genesisAnchor(input.trustedScopeAuthority), ensureCurrent: input.ensureCurrent,
        fetch: { ensureCurrent: input.reader.ensureCurrent, read: (objectId, binding) => {
          if (!binding) throw new Error("Peer history predecessor requires an archive binding")
          return input.reader.read(objectId, binding, id)
        } } })
      try {
        budget.addBasis(parent, false)
        child.verifyPreviousBaseline(parent)
        input.ensureCurrent()
      } catch (error) { parent.free(); throw error }
      parents.push(parent)
      child = parent
    }
    throw new Error("Peer history ancestry exceeds its bound")
  } finally { for (const parent of parents) parent.free() }
}
