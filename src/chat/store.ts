import {
  DEFAULT_DB_NAME,
  INDEX_MSG_WORKSPACE,
  INDEX_MSG_WORKSPACE_ORDER,
  INDEX_PROF_WORKSPACE,
  MAX_WORKSPACE_PROFILES,
  STORE_MESSAGES,
  STORE_META,
  STORE_PROFILES,
  doesProfileWin,
  prepareMessageBatch,
  prepareProfileBatch,
  validateMessage,
  validateProfile,
  validateWorkspaceId,
  type ChatSnapshot,
  type StoredChatMessage,
  type StoredChatProfile,
  type StoredMessageInternal,
  type WorkspaceMetaInternal,
} from "./storePolicy"
import { appendMessageTransaction, contentRevisionMeta, contentRevisionToken, mergeChatTransaction, persistContentRevision,
  promisifyRequest } from "./storeTransactions"

export {
  MAX_BODY_CODEPOINTS,
  MAX_RECORD_BYTES,
  areMessagesIdentical,
  canonicalJson,
  doesProfileWin,
  messageOrderKey,
  validateMessage,
  validateProfile,
  type ChatSnapshot,
  type StoredChatMessage,
  type StoredChatProfile,
} from "./storePolicy"

export class ChatStore {
  private readonly dbName: string
  private dbInstance: IDBDatabase | null = null

  constructor(dbName: string = DEFAULT_DB_NAME) {
    this.dbName = dbName
  }

  private openDb(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined" || !indexedDB) {
      return Promise.reject(new Error("IndexedDB is not available in this environment"))
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName)

      request.onblocked = () => {
        reject(new Error(`IndexedDB open blocked for database ${this.dbName}`))
      }

      request.onerror = () => {
        reject(request.error || new Error(`Failed to open IndexedDB ${this.dbName}`))
      }

      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          const msgStore = db.createObjectStore(STORE_MESSAGES, { keyPath: ["workspaceId", "id"] })
          msgStore.createIndex(INDEX_MSG_WORKSPACE_ORDER, ["workspaceId", "orderKey"], { unique: false })
          msgStore.createIndex(INDEX_MSG_WORKSPACE, "workspaceId", { unique: false })
        }
        if (!db.objectStoreNames.contains(STORE_PROFILES)) {
          const profStore = db.createObjectStore(STORE_PROFILES, { keyPath: ["workspaceId", "personId"] })
          profStore.createIndex(INDEX_PROF_WORKSPACE, "workspaceId", { unique: false })
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "workspaceId" })
        }
      }

      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => {
          try {
            db.close()
          } catch {
            // Database may already be closed.
          }
          this.dbInstance = null
        }
        db.onclose = () => {
          this.dbInstance = null
        }
        resolve(db)
      }
    })
  }

  private async getDb(): Promise<IDBDatabase> {
    if (this.dbInstance) {
      return this.dbInstance
    }
    const db = await this.openDb()
    this.dbInstance = db
    return db
  }

  /**
   * Run an atomic transaction across stores.
   * Resolves only when transaction fires oncomplete (durability).
   * Rejects immediately on error, quota exceeded, or abort.
   */
  private async runTx<T>(
    storeNames: string[],
    mode: IDBTransactionMode,
    fn: (tx: IDBTransaction) => Promise<T>
  ): Promise<T> {
    const db = await this.getDb()
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction
      try {
        tx = db.transaction(storeNames, mode)
      } catch (err) {
        reject(err)
        return
      }

      let result: T
      let isResultReady = false
      let hasTxFinished = false

      tx.oncomplete = () => {
        hasTxFinished = true
        if (isResultReady) {
          resolve(result)
        } else {
          reject(new Error("Transaction completed before result was produced"))
        }
      }

      tx.onerror = () => {
        hasTxFinished = true
        reject(tx.error || new Error("Transaction error"))
      }

      tx.onabort = () => {
        hasTxFinished = true
        reject(tx.error || new Error("Transaction aborted"))
      }

      fn(tx)
        .then((res) => {
          result = res
          isResultReady = true
          if (hasTxFinished) {
            resolve(result)
          }
        })
        .catch((err) => {
          try {
            tx.abort()
          } catch {
            // Transaction may already be inactive.
          }
          reject(err)
        })
    })
  }

  async load(workspaceId: string): Promise<ChatSnapshot> {
    validateWorkspaceId(workspaceId)

    return this.runTx([STORE_MESSAGES, STORE_PROFILES], "readonly", async (tx) => {
      const msgStore = tx.objectStore(STORE_MESSAGES)
      const profStore = tx.objectStore(STORE_PROFILES)

      const msgIndex = msgStore.index(INDEX_MSG_WORKSPACE_ORDER)
      const profIndex = profStore.index(INDEX_PROF_WORKSPACE)

      const msgsReq = msgIndex.getAll(IDBKeyRange.bound([workspaceId, ""], [workspaceId, "\uffff"]))
      const profsReq = profIndex.getAll(IDBKeyRange.only(workspaceId))

      const [storedMsgs, storedProfs] = await Promise.all([
        promisifyRequest<StoredMessageInternal[]>(msgsReq),
        promisifyRequest<StoredChatProfile[]>(profsReq),
      ])

      const messages: StoredChatMessage[] = (storedMsgs || []).map((m) => ({
        id: m.id,
        workspaceId: m.workspaceId,
        personId: m.personId,
        createdAt: m.createdAt,
        body: m.body,
        record: m.record,
        ...(m.context ? { context: m.context } : {}),
      }))

      const profiles: StoredChatProfile[] = (storedProfs || []).map((p) => ({
        workspaceId: p.workspaceId,
        personId: p.personId,
        name: p.name,
        revision: p.revision,
        record: p.record,
      }))

      return { messages, profiles }
    })
  }

  async loadProfiles(workspaceId: string): Promise<StoredChatProfile[]> {
    validateWorkspaceId(workspaceId)
    return this.runTx([STORE_PROFILES], "readonly", async tx => {
      const profiles = await promisifyRequest<StoredChatProfile[]>(
        tx.objectStore(STORE_PROFILES).index(INDEX_PROF_WORKSPACE).getAll(IDBKeyRange.only(workspaceId)),
      )
      return (profiles ?? []).map(profile => ({
        workspaceId: profile.workspaceId,
        personId: profile.personId,
        name: profile.name,
        revision: profile.revision,
        record: profile.record,
      }))
    })
  }

  async append(message: StoredChatMessage): Promise<boolean> {
    validateMessage(message)
    return this.runTx([STORE_MESSAGES, STORE_PROFILES, STORE_META], "readwrite", (tx) =>
      appendMessageTransaction(tx, message)
    )
  }

  async putProfile(profile: StoredChatProfile): Promise<boolean> {
    validateProfile(profile)

    return this.runTx([STORE_MESSAGES, STORE_PROFILES, STORE_META], "readwrite", async (tx) => {
      const profStore = tx.objectStore(STORE_PROFILES)
      const profIndex = profStore.index(INDEX_PROF_WORKSPACE)
      const metaStore = tx.objectStore(STORE_META)

      const getReq = profStore.get([profile.workspaceId, profile.personId])
      const allReq = profIndex.getAll(IDBKeyRange.only(profile.workspaceId))
      const metaReq = metaStore.get(profile.workspaceId)

      const [existing, allProfiles, storedMeta] = await Promise.all([
        promisifyRequest<StoredChatProfile | undefined>(getReq),
        promisifyRequest<StoredChatProfile[]>(allReq),
        promisifyRequest<WorkspaceMetaInternal | undefined>(metaReq),
      ])
      const { meta, needsWrite } = contentRevisionMeta(profile.workspaceId, storedMeta)

      if (!existing) {
        const count = (allProfiles || []).length
        if (count >= MAX_WORKSPACE_PROFILES) {
          throw new Error(`Profile limit of ${MAX_WORKSPACE_PROFILES} exceeded for workspace`)
        }
        profStore.put(profile)
        persistContentRevision(metaStore, meta, true, needsWrite)
        return true
      }

      if (doesProfileWin(profile, existing)) {
        profStore.put(profile)
        persistContentRevision(metaStore, meta, true, needsWrite)
        return true
      }

      persistContentRevision(metaStore, meta, false, needsWrite)
      return false
    })
  }

  async merge(
    workspaceId: string,
    messages: StoredChatMessage[],
    profiles: StoredChatProfile[]
  ): Promise<{ added: StoredChatMessage[]; changed: boolean; profilesChanged: boolean }> {
    validateWorkspaceId(workspaceId)
    const messageBatch = prepareMessageBatch(workspaceId, messages)
    const profileBatch = prepareProfileBatch(workspaceId, profiles)
    return this.runTx([STORE_MESSAGES, STORE_PROFILES, STORE_META], "readwrite", (tx) =>
      mergeChatTransaction(tx, workspaceId, messageBatch, profileBatch)
    )
  }

  async readCursor(workspaceId: string): Promise<string | null> {
    validateWorkspaceId(workspaceId)

    return this.runTx([STORE_META], "readonly", async (tx) => {
      const metaStore = tx.objectStore(STORE_META)
      const meta = await promisifyRequest<WorkspaceMetaInternal | undefined>(metaStore.get(workspaceId))
      return meta?.cursor ?? null
    })
  }

  async readContentRevision(workspaceId: string): Promise<string> {
    validateWorkspaceId(workspaceId)
    return this.runTx([STORE_META], "readwrite", async (tx) => {
      const metaStore = tx.objectStore(STORE_META)
      const stored = await promisifyRequest<WorkspaceMetaInternal | undefined>(metaStore.get(workspaceId))
      const { meta, needsWrite } = contentRevisionMeta(workspaceId, stored)
      persistContentRevision(metaStore, meta, false, needsWrite)
      return contentRevisionToken(meta)
    })
  }

  async markRead(workspaceId: string, cursor: string): Promise<void> {
    validateWorkspaceId(workspaceId)
    if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 512) {
      throw new Error("Invalid cursor: must be string between 1 and 512 characters")
    }

    return this.runTx([STORE_META], "readwrite", async (tx) => {
      const metaStore = tx.objectStore(STORE_META)
      const meta = await promisifyRequest<WorkspaceMetaInternal | undefined>(metaStore.get(workspaceId))
      const currentMeta: WorkspaceMetaInternal = meta || {
        workspaceId,
        cursor: null,
        pruneCutoff: null,
      }

      // Cursor monotonic: never moves backward
      if (currentMeta.cursor && cursor <= currentMeta.cursor) {
        return
      }

      currentMeta.cursor = cursor
      metaStore.put(currentMeta)
    })
  }
}

export const chatStore = new ChatStore()
