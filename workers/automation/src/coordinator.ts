import { DurableObject } from "cloudflare:workers";
import { ExecutionCoordinator } from "./executionCoordinator";
import { privateEmailRoutes } from "./emailRoutes";
import type { JobPageFetcher } from "./extraction";
import { ExecutorIntakeOutbox, ExecutorMigrationFencedError } from "./executorIntakeOutbox";
import type { MigrationManifest } from "./executorMigration";
import type { ExecutionStoragePort } from "./executionPorts";
import type { WorkerEnv } from "./index";

export { writeReplicaChunksAtomically } from "./executionCoordinator";
export type { StoredEventStatus, EnqueueSuccess, EnqueueResult } from "./executionCoordinator";

/** Cloudflare adapter serializes legacy operations against the durable migration fence. */
export class AutomationCoordinator extends DurableObject<WorkerEnv> {
  private readonly execution: ExecutionCoordinator;
  private readonly intakeOutbox: ExecutorIntakeOutbox;
  private adapterQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.execution = new ExecutionCoordinator(ctx, env, {
      jobPageFetcher: () => this.jobPageFetcher(),
      resolvePrivateEmailRoute: id => this.resolvePrivateEmailRoute(id),
    });
    this.intakeOutbox = new ExecutorIntakeOutbox(ctx.storage as ExecutionStoragePort, ctx.id.name ?? "", env);
  }

  enrollOwner(...args: Parameters<ExecutionCoordinator["enrollOwner"]>) { return this.serialLegacy(() => this.execution.enrollOwner(...args)); }
  activateOwner(...args: Parameters<ExecutionCoordinator["activateOwner"]>) { return this.serialLegacy(() => this.execution.activateOwner(...args)); }
  getRegisteredIntegration(...args: Parameters<ExecutionCoordinator["getRegisteredIntegration"]>) { return this.serialLegacy(() => this.execution.getRegisteredIntegration(...args)); }
  observeOwner(...args: Parameters<ExecutionCoordinator["observeOwner"]>) { return this.serialLegacy(() => this.execution.observeOwner(...args)); }
  provisionIdentity(...args: Parameters<ExecutionCoordinator["provisionIdentity"]>) { return this.serialLegacy(() => this.execution.provisionIdentity(...args)); }
  activateReplica(...args: Parameters<ExecutionCoordinator["activateReplica"]>) { return this.serialLegacy(() => this.execution.activateReplica(...args)); }
  saveReplicaState(...args: Parameters<ExecutionCoordinator["saveReplicaState"]>) { return this.serialLegacy(() => this.execution.saveReplicaState(...args)); }
  loadReplicaState(...args: Parameters<ExecutionCoordinator["loadReplicaState"]>) { return this.serialLegacy(() => this.execution.loadReplicaState(...args)); }
  retryEmail(...args: Parameters<ExecutionCoordinator["retryEmail"]>) { return this.serialLegacy(() => this.execution.retryEmail(...args)); }
  bindEmailApplication(...args: Parameters<ExecutionCoordinator["bindEmailApplication"]>) { return this.serialLegacy(() => this.execution.bindEmailApplication(...args)); }
  retryBoundEmailApplication(...args: Parameters<ExecutionCoordinator["retryBoundEmailApplication"]>) { return this.serialLegacy(() => this.execution.retryBoundEmailApplication(...args)); }
  manageInstance(...args: Parameters<ExecutionCoordinator["manageInstance"]>) { return this.serialLegacy(() => this.execution.manageInstance(...args)); }
  applicationReview(...args: Parameters<ExecutionCoordinator["applicationReview"]>) { return this.serialLegacy(() => this.execution.applicationReview(...args)); }
  emailSetup(...args: Parameters<ExecutionCoordinator["emailSetup"]>) { return this.serialLegacy(() => this.execution.emailSetup(...args)); }
  classificationContext(...args: Parameters<ExecutionCoordinator["classificationContext"]>) {
    return this.serialLegacy(() => this.execution.classificationContext(...args));
  }

  getEvent(...args: Parameters<ExecutionCoordinator["getEvent"]>): Promise<Awaited<ReturnType<ExecutionCoordinator["getEvent"]>>> {
    return this.serializeAdapter(async () => {
      const migration = await this.intakeOutbox.phase();
      if (migration?.phase === "active") throw new ExecutorMigrationFencedError();
      if (migration?.phase === "frozen") {
        const pending = this.intakeOutbox.getEvent(args[0]);
        if (pending) return pending as Awaited<ReturnType<ExecutionCoordinator["getEvent"]>>;
        return this.execution.getEvent(...args) as Awaited<ReturnType<ExecutionCoordinator["getEvent"]>>;
      }
      return this.execution.getEvent(...args) as Awaited<ReturnType<ExecutionCoordinator["getEvent"]>>;
    });
  }

  enqueueWebsite(...args: Parameters<ExecutionCoordinator["enqueueWebsite"]>) {
    return this.serializeAdapter(async () => {
      const migration = await this.intakeOutbox.phase();
      return migration ? this.intakeOutbox.enqueueWebsite(args[0]) : this.execution.enqueueWebsite(...args);
    });
  }

  enqueueEmail(...args: Parameters<ExecutionCoordinator["enqueueEmail"]>) {
    return this.serializeAdapter(async () => {
      const migration = await this.intakeOutbox.phase();
      return migration ? this.intakeOutbox.enqueueEmail(args[0]) : this.execution.enqueueEmail(...args);
    });
  }

  alarm(...args: Parameters<ExecutionCoordinator["alarm"]>): Promise<Awaited<ReturnType<ExecutionCoordinator["alarm"]>>> {
    return this.serializeAdapter(async () => {
      const migration = await this.intakeOutbox.phase();
      if (!migration) return await this.execution.alarm(...args) as Awaited<ReturnType<ExecutionCoordinator["alarm"]>>;
      return await this.execution.withExclusiveState(() => this.intakeOutbox.alarm()) as Awaited<ReturnType<ExecutionCoordinator["alarm"]>>;
    });
  }

  executionRoute(): Promise<{ origin: string; epoch: number } | null> {
    return this.serializeAdapter(() => this.intakeOutbox.executionRoute());
  }

  prepareExecutorMigration(epoch: number): Promise<MigrationManifest> {
    return this.serializeAdapter(() => this.execution.withExclusiveState(() => this.intakeOutbox.prepare(epoch)));
  }

  executorMigrationManifestHash(): Promise<string> {
    return this.serializeAdapter(() => this.intakeOutbox.manifestHash());
  }

  readExecutorMigrationPage(epoch: number, table: string, offset: number): Promise<{ table: string; offset: number; nonce: string; ciphertext: string }> {
    return this.serializeAdapter(() => this.intakeOutbox.page(epoch, table, offset));
  }

  acknowledgeExecutorMigration(epoch: number, manifestHash: string): Promise<void> {
    return this.serializeAdapter(() => this.intakeOutbox.acknowledge(epoch, manifestHash));
  }

  private async serialLegacy<T>(action: () => Promise<T>): Promise<T> {
    return this.serializeAdapter(async () => {
      if (await this.intakeOutbox.phase()) throw new ExecutorMigrationFencedError();
      return action();
    });
  }

  private serializeAdapter<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.adapterQueue.then(action, action);
    this.adapterQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  protected jobPageFetcher(): JobPageFetcher { return fetch; }
  protected async resolvePrivateEmailRoute(id: string): Promise<ReturnType<typeof privateEmailRoutes>[number] | undefined> {
    return privateEmailRoutes(this.env).find(value => value.id === id);
  }
}
