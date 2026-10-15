type RequestTable = "application_review_requests" | "automation_instance_requests";

/** A bounded durable nonce ledger. Callers recheck live authority before reading any saved outcome. */
export class FreshRequestLedger {
  constructor(private readonly storage: DurableObjectStorage, private readonly table: RequestTable) {}

  initialize(): void {
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (
      nonce TEXT PRIMARY KEY, request_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, encrypted_response TEXT
    )`);
  }

  read(nonce: string, requestHash: string): string | null {
    const row = this.storage.sql.exec<{ request_hash: string; encrypted_response: string | null }>(
      `SELECT request_hash, encrypted_response FROM ${this.table} WHERE nonce = ?`, nonce,
    ).toArray()[0];
    if (row && row.request_hash !== requestHash) throw new Error("Authenticated request nonce was already used for different content");
    return row?.encrypted_response ?? null;
  }

  claim(nonce: string, requestHash: string, expiresAt: number): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`DELETE FROM ${this.table} WHERE expires_at <= ?`, Date.now());
      const existing = this.storage.sql.exec<{ request_hash: string }>(`SELECT request_hash FROM ${this.table} WHERE nonce = ?`, nonce).toArray()[0];
      if (existing) {
        if (existing.request_hash !== requestHash) throw new Error("Authenticated request nonce was already used for different content");
        return;
      }
      const count = this.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${this.table}`).one().count;
      if (count >= 128) throw new Error("Too many active authenticated requests; retry shortly");
      this.storage.sql.exec(`INSERT INTO ${this.table} (nonce, request_hash, expires_at) VALUES (?, ?, ?)`, nonce, requestHash, expiresAt);
    });
  }

  complete(nonce: string, requestHash: string, encrypted: string): void {
    this.storage.sql.exec(`UPDATE ${this.table} SET encrypted_response = ? WHERE nonce = ? AND request_hash = ?`, encrypted, nonce, requestHash);
  }
}
