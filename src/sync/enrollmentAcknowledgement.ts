import { decodePairingFrame, encodePairingFrame } from "@meta-uber/mesh-pairing"
import type { workspaceSet } from "./workspaceSet"
import type { SyncConnection, DuplexStream } from "./transport"

export async function rejectEnrollment(stream: DuplexStream, secret: string) {
  const error = new TextEncoder().encode(JSON.stringify({ error: "Device enrollment was declined or cancelled." }))
  await stream.send(encodePairingFrame("enroll-approved", secret, error))
  await stream.closeSend()
}

export async function awaitEnrollmentDeclineAcknowledgement(connection: SyncConnection, secret: string) {
  const acknowledgement = await connection.acceptStream()
  decodePairingFrame(await acknowledgement.read(), "enroll-ack", secret)
  await acknowledgement.closeSend()
}

export async function acknowledgeEnrollmentDecline(connection: SyncConnection, secret: string) {
  const acknowledgement = await connection.openStream()
  await acknowledgement.send(encodePairingFrame("enroll-ack", secret, new Uint8Array()))
  await acknowledgement.closeSend()
}

export function enrollmentDecline(bytes: Uint8Array) {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : undefined
  } catch { return undefined }
}

type EnrollmentReplica = Pick<ReturnType<typeof workspaceSet>, "serveProofPage">

export async function sendEnrollmentRejection(connection: SyncConnection, secret: string, error: unknown) {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    (async () => {
      const stream = await connection.openStream()
      const reason = error instanceof Error ? error.message : String(error)
      await stream.send(encodePairingFrame("enroll-rejected", secret, new TextEncoder().encode(JSON.stringify({ reason }))))
      await stream.closeSend()
      decodePairingFrame(await stream.read(), "enroll-rejected-ack", secret)
    })(),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Enrollment rejection was not acknowledged")), 12_000) }),
  ]).finally(() => clearTimeout(timer))
}

export function enrollmentRejection(bytes: Uint8Array) {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { reason?: unknown }
    return typeof value.reason === "string" ? value.reason : "the recipient could not validate the workspace"
  } catch { return "the recipient could not validate the workspace" }
}

export async function awaitEnrollmentAcknowledgement(
  connection: SyncConnection,
  ackStream: DuplexStream,
  replica: EnrollmentReplica,
  secret: string,
  ensureCurrent: () => void | Promise<void>,
): Promise<void> {
  let stopped = false
  let activeProofStream: DuplexStream | undefined
  const ensureActive = async () => {
    if (stopped) throw new Error("Enrollment acknowledgement is complete")
    await ensureCurrent()
    if (stopped) throw new Error("Enrollment acknowledgement is complete")
  }

  const serviceProofRequests = async () => {
    for (let requests = 0; requests < 4096 && !stopped; requests++) {
      await ensureActive()
      const incoming = await connection.acceptStream()
      const served = await serveEnrollmentProofRequest(incoming, replica, secret, ensureActive, () => stopped,
        stream => { activeProofStream = stream })
      if (!served) return
    }
    if (!stopped) throw new Error("Enrollment proof reply limit exceeded")
  }

  const readAcknowledgement = async () => {
    await ensureActive()
    const frame = await ackStream.read()
    await ensureActive()
    decodePairingFrame(frame, "enroll-complete", secret)
  }

  const proofRequests = serviceProofRequests()
  try {
    await Promise.race([readAcknowledgement(), proofRequests])
  } finally {
    stopped = true
    if (activeProofStream?.reset) void Promise.resolve(activeProofStream.reset()).catch(() => undefined)
    // acceptStream/read may remain pending after the acknowledgement wins.
    // Keep the detached service loop rejection handled if the connection closes.
    void proofRequests.catch(() => undefined)
  }
}

async function serveEnrollmentProofRequest(incoming: DuplexStream, replica: EnrollmentReplica, secret: string,
  ensureActive: () => Promise<void>, isStopped: () => boolean,
  setActiveStream: (stream: DuplexStream | undefined) => void): Promise<boolean> {
  try {
    await ensureActive()
    const frame = await incoming.read()
    await ensureActive()
    setActiveStream(incoming)
    if (!await replica.serveProofPage(frame, incoming, secret, ensureActive)) {
      throw new Error("Unexpected enrollment stream while awaiting acknowledgement")
    }
    await ensureActive()
    return true
  } catch (error) {
    if (!isStopped()) throw error
    try { await incoming.reset?.() } catch { /* Completion already won. */ }
    return false
  } finally {
    setActiveStream(undefined)
  }
}
