import type { GossipStateMachine } from "@meta-uber/mesh-replication"
import type { MeshStream, MeshConnection, IrohConnection } from "@meta-uber/mesh-transport"

export type DuplexStream = MeshStream

export type SyncConnection = MeshConnection

export type SyncAcceptor = {
  accept: () => Promise<IrohConnection | undefined>
  close: () => Promise<void>
}

export type SyncNode = {
  endpointId: string
  createGossipEngine: () => GossipStateMachine
  dial: (remoteEndpoint: string) => Promise<IrohConnection>
  dialRelay?: (remoteEndpoint: string) => Promise<IrohConnection>
  accept: () => Promise<SyncAcceptor>
  close: (reason?: string) => Promise<void>
}

export type SyncTransport = {
  start: (secret?: Uint8Array) => Promise<SyncNode>
}
