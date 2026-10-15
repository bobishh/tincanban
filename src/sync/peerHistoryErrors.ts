export class PeerHistoryObjectUnavailableError extends Error {
  constructor(message = "Peer history object is unavailable") { super(message); this.name = "PeerHistoryObjectUnavailableError" }
}
