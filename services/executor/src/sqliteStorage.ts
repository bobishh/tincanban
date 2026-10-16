import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ExecutionSqlCursor, ExecutionSqlValue, ExecutionStoragePort } from "../../../workers/automation/src/executionPorts";

/** Private participant journal. SQL and outbox transitions are shared with the existing executor. */
export class SqliteExecutionStorage implements ExecutionStoragePort {
  private readonly database: DatabaseSync;
  private transactionDepth = 0;
  readonly sql = { exec: <T extends Record<string, ExecutionSqlValue> = Record<string, ExecutionSqlValue>>(
    query: string, ...bindings: ExecutionSqlValue[]
  ): ExecutionSqlCursor<T> => {
    const parameters = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value) as SQLInputValue[];
    // Schema initialization contains multiple statements and no parameters/rows.
    if (!parameters.length && query.trim().replace(/;$/, "").includes(";")) {
      this.database.exec(query);
      return cursor<T>([]);
    }
    const statement = this.database.prepare(query);
    if (!statement.columns().length) {
      statement.run(...parameters);
      return cursor<T>([]);
    }
    const rows = statement.all(...parameters).map(row => Object.fromEntries(Object.entries(row).map(([name, value]) => {
      if (value instanceof Uint8Array) return [name, Uint8Array.from(value).buffer];
      if (typeof value === "bigint") throw new Error("Executor journal integer exceeds its supported numeric representation");
      return [name, value];
    })) as T);
    return cursor(rows);
  } };

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    this.database.exec(`CREATE TABLE IF NOT EXISTS executor_schedule (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), alarm_at INTEGER
    ); INSERT OR IGNORE INTO executor_schedule(singleton, alarm_at) VALUES (1, NULL);`);
  }

  transactionSync<T>(callback: () => T): T {
    const name = `executor_${this.transactionDepth++}`;
    this.database.exec(`SAVEPOINT ${name}`);
    try {
      const result = callback();
      if (result && typeof result === "object" && "then" in result) throw new TypeError("Journal transactions must be synchronous");
      this.database.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      this.database.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
      throw error;
    } finally { this.transactionDepth -= 1; }
  }

  async getAlarm(): Promise<number | null> {
    return this.sql.exec<{ alarm_at: number | null }>("SELECT alarm_at FROM executor_schedule WHERE singleton = 1").one().alarm_at;
  }

  async setAlarm(time: number): Promise<void> {
    if (!Number.isSafeInteger(time) || time < 0) throw new TypeError("Invalid executor alarm time");
    this.sql.exec("UPDATE executor_schedule SET alarm_at = ? WHERE singleton = 1", time);
  }

  async deleteAlarm(): Promise<void> {
    this.sql.exec("UPDATE executor_schedule SET alarm_at = NULL WHERE singleton = 1");
  }

  close(): void { this.database.close(); }
}

function cursor<T>(rows: T[]): ExecutionSqlCursor<T> {
  return {
    toArray: () => [...rows],
    one() {
      if (rows.length !== 1) throw new Error(`Expected one journal row, received ${rows.length}`);
      return rows[0]!;
    },
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  };
}
