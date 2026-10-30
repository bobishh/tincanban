import type { KeeperDiscovery } from "./keeperDiscovery"

type PairingResponse = { pairingId: string; transcriptHash: string; expiresAt: number; comparisonCode: string }

function validResponse(result: PairingResponse, transcriptHash: string) {
  if (result.transcriptHash !== transcriptHash || !Number.isSafeInteger(result.expiresAt)
    || typeof result.comparisonCode !== "string") {
    throw new Error("Keeper returned a pairing response that does not match this request.")
  }
}

function challengeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function validChallenge(challenge: Record<string, unknown> | undefined, pairingId: string,
  discovery: KeeperDiscovery, expiresAt: number, transcriptHash: string) {
  return Boolean(challenge && challenge.kind === "keeper-pairing-challenge"
    && challenge.pairingId === pairingId && typeof challenge.integrationId === "string" && challenge.integrationId
    && challenge.transcriptHash === transcriptHash && challenge.servicePersonId === discovery.personId
    && challenge.serviceOrigin === discovery.origin && challenge.expiresAt === expiresAt
    && typeof challenge.nonce === "string")
}

export function validateKeeperPairingChallenge(result: PairingResponse, discovery: KeeperDiscovery,
  envelope: Record<string, unknown>, transcriptHash: string) {
  validResponse(result, transcriptHash)
  const challenge = challengeRecord(envelope.payload)
  if (!result.pairingId || !challenge || !validChallenge(challenge, result.pairingId, discovery, result.expiresAt, transcriptHash)) {
    throw new Error("Keeper challenge is not bound to this pairing, identity and origin.")
  }
  let operatorUrl: URL
  try { operatorUrl = new URL(String(envelope.operatorUrl)) } catch (error) {
    throw new Error("Keeper returned an invalid operator URL.", { cause: error })
  }
  if (operatorUrl.origin !== discovery.origin || operatorUrl.pathname !== "/admin/") {
    throw new Error("Keeper returned an unsafe operator URL.")
  }
  return { pairingId: result.pairingId, integrationId: challenge.integrationId as string,
    operatorUrl: operatorUrl.toString(), challengeNonce: challenge.nonce as string }
}
