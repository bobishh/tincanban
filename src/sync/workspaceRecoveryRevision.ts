import { canonicalizeJson } from "../domain/identity"

const READ_TIMEOUT_MS = 5_000
const MAX_ATTEMPTS = 3
class RevisionReadStalled extends Error {
  constructor() { super("Workspace storage did not respond. Retry the private backup.") }
}

/** Own only this read-only transaction: a stalled attempt must not hold backup open forever. */
class ReadonlyRevisionAttempt {
  private transaction?: IDBTransaction
  private request?: IDBRequest<unknown>
  private timer?: ReturnType<typeof setTimeout>
  private settled = false
  private read = false
  private value: unknown
  private resolve!: (value: unknown) => void
  private reject!: (error: unknown) => void
  constructor(private readonly database: IDBDatabase, private readonly workspaceId: string) {}
  run(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.resolve = resolve; this.reject = reject
      try { this.start() } catch (error) { this.fail(error, true) }
    })
  }
  private start() {
    const transaction = this.transaction = this.database.transaction("revisions", "readonly")
    transaction.oncomplete = () => {
      if (!this.read) { this.fail(new Error("Workspace revision read completed without a result")); return }
      if (this.settled) return
      this.settled = true; this.cleanup(); this.resolve(this.value)
    }
    transaction.onabort = () => this.fail(transaction.error ?? new Error("Workspace revision read aborted"))
    transaction.onerror = () => this.fail(transaction.error ?? new Error("Workspace revision read failed"))
    const request = this.request = transaction.objectStore("revisions").get(this.workspaceId) as IDBRequest<unknown>
    request.onsuccess = () => {
      if (this.settled) return
      try { this.value = request.result; this.read = true } catch (error) { this.fail(error, true) }
    }
    request.onerror = () => this.fail(request.error ?? new Error("Workspace revision read failed"))
    this.timer = setTimeout(() => this.fail(new RevisionReadStalled(), true), READ_TIMEOUT_MS)
  }
  private fail(error: unknown, abort = false) {
    if (this.settled) return
    this.settled = true; this.cleanup()
    // Detach first: late request/abort events cannot settle a replacement attempt.
    if (abort) try { this.transaction?.abort() } catch { /* A completed transaction cannot be aborted. */ }
    this.reject(error)
  }
  private cleanup() {
    clearTimeout(this.timer)
    if (this.request) { this.request.onsuccess = null; this.request.onerror = null }
    if (this.transaction) {
      this.transaction.oncomplete = null; this.transaction.onabort = null; this.transaction.onerror = null
    }
  }
}

/** A retry still reads current storage and compares against the original captured revision. */
export async function readWorkspaceRecoveryRevision(database: IDBDatabase, workspaceId: string, ensureCurrent: () => void): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    ensureCurrent()
    try {
      const value = await new ReadonlyRevisionAttempt(database, workspaceId).run()
      ensureCurrent()
      return canonicalizeJson(value ?? null)
    } catch (error) {
      ensureCurrent()
      if (!(error instanceof RevisionReadStalled) || attempt === MAX_ATTEMPTS - 1) throw error
    }
  }
  throw new RevisionReadStalled()
}
