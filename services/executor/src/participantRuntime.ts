import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { ParticipantRequest, ParticipantRuntime } from "./httpApi";

/** One loaded participant at a time; process isolation releases WASM heaps on eviction/restart. */
export class BoundedParticipantRuntime implements ParticipantRuntime {
  private worker?: Worker;
  private integration?: string;
  private sequence = 0;
  private waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private lane: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closing = false;
  private timerCursor?: string;
  private timerTickPending = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly directory: string, private readonly origin: string, private readonly automationOrigin: string,
    private readonly workerPath = process.env.EXECUTOR_WORKER_PATH ? pathToFileURL(process.env.EXECUTOR_WORKER_PATH) : new URL("./participantWorker.mjs", import.meta.url)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.timer = setInterval(() => {
      if (this.timerTickPending || this.closing) return;
      const names = this.integrations();
      if (!names.length) return;
      const next = names[(names.indexOf(this.timerCursor ?? "") + 1) % names.length]!;
      this.timerCursor = next;
      this.timerTickPending = true;
      void this.enqueue(next, { operation: "tick" }, true)
        .catch(error => console.error(JSON.stringify({ event: "executor.tick.failed", integrationId: next, error: error.message })))
        .finally(() => { this.timerTickPending = false; });
    }, 2_000);
    this.timer.unref();
  }

  call(integrationId: string, request: ParticipantRequest): Promise<unknown> {
    return this.enqueue(integrationId, request, false);
  }

  private enqueue(integrationId: string, request: ParticipantRequest, scheduledTick: boolean): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error("Executor is shutting down"));
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(integrationId)) return Promise.reject(new TypeError("Invalid integration ID"));
    if (this.pending >= (scheduledTick ? 32 : 31)) return Promise.reject(Object.assign(new Error("Executor queue is busy; retry the same command"), { status: 429 }));
    this.pending += 1;
    const operation = this.lane.then(async () => {
      await this.select(integrationId);
      const id = ++this.sequence;
      return new Promise((resolve, reject) => {
        this.waiting.set(id, { resolve, reject });
        this.worker!.postMessage({ id, request });
      });
    });
    this.lane = operation.catch(() => {}).finally(() => { this.pending -= 1; });
    return operation;
  }

  async close(): Promise<void> {
    this.closing = true; clearInterval(this.timer);
    await this.lane;
    await this.worker?.terminate();
  }

  private integrations(): string[] {
    return readdirSync(this.directory).filter(name => /^[A-Za-z0-9_-]{1,128}\.sqlite$/.test(name)).map(name => name.slice(0, -7)).sort();
  }

  private async select(integrationId: string): Promise<void> {
    if (this.integration === integrationId && this.worker) return;
    const existing = this.integrations();
    if (!existing.includes(integrationId) && existing.length >= 16) throw Object.assign(new Error("Executor integration capacity reached"), { status: 429 });
    await this.worker?.terminate();
    this.integration = integrationId;
    const worker = new Worker(this.workerPath, { resourceLimits: { maxOldGenerationSizeMb: 512 },
      workerData: { integrationId, databasePath: join(this.directory, `${integrationId}.sqlite`), publicOrigin: this.origin, automationOrigin: this.automationOrigin } });
    this.worker = worker;
    worker.on("message", (message: { id: number; result?: unknown; error?: { message: string; name: string; status?: number } }) => {
      const pending = this.waiting.get(message.id);
      if (!pending) return;
      this.waiting.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { name: message.error.name, status: message.error.status }));
      else pending.resolve(message.result);
    });
    const fail = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined; this.integration = undefined;
      for (const pending of this.waiting.values()) pending.reject(error);
      this.waiting.clear();
    };
    worker.on("error", fail);
    worker.on("exit", code => fail(new Error(`Executor participant stopped (exit ${code}); durable work remains available`)));
  }
}
