import { PeerStore as SharedPeerStore } from "@meta-uber/mesh-peer-store"

export * from "@meta-uber/mesh-peer-store"

export class PeerStore extends SharedPeerStore {
  constructor(readonly databaseName = "tincanban-peer-catalog-v1", idbFactory?: IDBFactory) {
    super(databaseName, idbFactory)
  }
}

export const peerStore = new PeerStore()
