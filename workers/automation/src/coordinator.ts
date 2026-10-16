import { DurableObject } from "cloudflare:workers";
import { ExecutionCoordinator } from "./executionCoordinator";
import { privateEmailRoutes } from "./emailRoutes";
import type { JobPageFetcher } from "./extraction";
import { ExecutorIntakeOutbox, ExecutorMigrationFencedError } from "./executorIntakeOutbox";
import type { MigrationManifest } from "./executorMigration";
import type { ExecutionStoragePort } from "./executionPorts";
import type { WorkerEnv } from "./index";
import { bootstrapFreshExecutor } from "./executorClient";
import { hasExecutorLegacyRows, readCloudflareFreshRoute, reserveCloudflareFreshRoute, validateExecutorFreshBinding, type ExecutorFreshBinding } from "./executorFresh";

export { writeReplicaChunksAtomically } from "./executionCoordinator";
export type { StoredEventStatus, EnqueueSuccess, EnqueueResult } from "./executionCoordinator";

/** Cloudflare adapter serializes legacy operations against the durable migration fence. */
export class AutomationCoordinator extends DurableObject<WorkerEnv> {
  private executionInstance: ExecutionCoordinator | undefined;
  private readonly intakeOutbox: ExecutorIntakeOutbox;
  private adapterQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.intakeOutbox = new ExecutorIntakeOutbox(ctx.storage as ExecutionStoragePort, ctx.id.name ?? "", env);
    if (!env.EXECUTOR_ORIGIN) this.legacyExecution();
  }

  enrollOwner(...args: Parameters<ExecutionCoordinator["enrollOwner"]>) {
    return this.serializeAdapter(async () => {
      if (await this.intakeOutbox.phase()) throw new ExecutorMigrationFencedError();
      if (!this.env.EXECUTOR_ORIGIN) {
        if (await readCloudflareFreshRoute(this.ctx.storage)) throw new ExecutorMigrationFencedError("Fresh executor route requires its configured origin");
        return this.legacyExecution().enrollOwner(...args);
      }
      const [registration] = args;
      const binding: ExecutorFreshBinding = validateExecutorFreshBinding({
        integrationId: registration.integrationId, ownerPersonId: registration.ownerPersonId,
        workspaceId: registration.workspaceId, origin: this.env.EXECUTOR_ORIGIN, epoch: 1,
      }, { integrationId: this.ctx.id.name ?? registration.integrationId, origin: this.env.EXECUTOR_ORIGIN });
      try { await reserveCloudflareFreshRoute(this.ctx.storage, binding); }
      catch (error) {
        if (error instanceof Error && /legacy participant state requires migration/i.test(error.message)) {
          throw new ExecutorMigrationFencedError("Existing participant must complete executor migration before owner enrollment");
        }
        throw error;
      }
      return bootstrapFreshExecutor<Awaited<ReturnType<ExecutionCoordinator["enrollOwner"]>>>(this.env, binding);
    });
  }
  activateOwner(...args: Parameters<ExecutionCoordinator["activateOwner"]>) { return this.serialLegacy(() => this.legacyExecution().activateOwner(...args)); }
  getRegisteredIntegration(...args: Parameters<ExecutionCoordinator["getRegisteredIntegration"]>) { return this.serialLegacy(() => this.legacyExecution().getRegisteredIntegration(...args)); }
  observeOwner(...args: Parameters<ExecutionCoordinator["observeOwner"]>) { return this.serialLegacy(() => this.legacyExecution().observeOwner(...args)); }
  provisionIdentity(...args: Parameters<ExecutionCoordinator["provisionIdentity"]>) { return this.serialLegacy(() => this.legacyExecution().provisionIdentity(...args)); }
  activateReplica(...args: Parameters<ExecutionCoordinator["activateReplica"]>) { return this.serialLegacy(() => this.legacyExecution().activateReplica(...args)); }
  saveReplicaState(...args: Parameters<ExecutionCoordinator["saveReplicaState"]>) { return this.serialLegacy(() => this.legacyExecution().saveReplicaState(...args)); }
  loadReplicaState(...args: Parameters<ExecutionCoordinator["loadReplicaState"]>) { return this.serialLegacy(() => this.legacyExecution().loadReplicaState(...args)); }
  retryEmail(...args: Parameters<ExecutionCoordinator["retryEmail"]>) { return this.serialLegacy(() => this.legacyExecution().retryEmail(...args)); }
  bindEmailApplication(...args: Parameters<ExecutionCoordinator["bindEmailApplication"]>) { return this.serialLegacy(() => this.legacyExecution().bindEmailApplication(...args)); }
  retryBoundEmailApplication(...args: Parameters<ExecutionCoordinator["retryBoundEmailApplication"]>) { return this.serialLegacy(() => this.legacyExecution().retryBoundEmailApplication(...args)); }
  manageInstance(...args: Parameters<ExecutionCoordinator["manageInstance"]>) {
    return this.serialLegacy(() => this.legacyExecution().manageInstance(...args), args[1] === "discover");
  }
  applicationReview(...args: Parameters<ExecutionCoordinator["applicationReview"]>) {
    return this.serialLegacy(() => this.legacyExecution().applicationReview(...args), args[1] === "discover");
  }
  emailSetup(...args: Parameters<ExecutionCoordinator["emailSetup"]>) { return this.serialLegacy(() => this.legacyExecution().emailSetup(...args)); }
  classificationContext(...args: Parameters<ExecutionCoordinator["classificationContext"]>) {
    return this.serialLegacy(() => this.legacyExecution().classificationContext(...args));
  }

  getEvent(...args: Parameters<ExecutionCoordinator["getEvent"]>): Promise<Awaited<ReturnType<ExecutionCoordinator["getEvent"]>>> {
    return this.serializeAdapter(async () => {
      const migration = await this.intakeOutbox.phase();
      if (migration?.phase === "active") throw new ExecutorMigrationFencedError();
      if (migration?.phase === "frozen") {
        const pending = this.intakeOutbox.getEvent(args[0]);
        if (pending) return pending as Awaited<ReturnType<ExecutionCoordinator["getEvent"]>>;
        return this.legacyExecution().getEvent(...args) as Awaited<ReturnType<ExecutionCoordinator["getEvent"]>>;
      }
      if (await readCloudflareFreshRoute(this.ctx.storage)) {
        const pending = this.intakeOutbox.getEvent(args[0]);
        if (pending) return pending as Awaited<ReturnType<ExecutionCoordinator["getEvent"]>>;
        throw new ExecutorMigrationFencedError("Fresh executor route is reserved; retry its private lookup");
      }
      if (this.env.EXECUTOR_ORIGIN) throw new ExecutorMigrationFencedError("Executor route is not reserved; legacy lookup is disabled");
      return this.legacyExecution().getEvent(...args) as Awaited<ReturnType<ExecutionCoordinator["getEvent"]>>;
    });
  }

  enqueueWebsite(...args: Parameters<ExecutionCoordinator["enqueueWebsite"]>) {
    return this.serializeAdapter(async () => {
      const migration = await this.intakeOutbox.phase();
      const freshRoute = await readCloudflareFreshRoute(this.ctx.storage);
      if (migration || freshRoute) return this.intakeOutbox.enqueueWebsite(args[0]);
      if (this.env.EXECUTOR_ORIGIN) throw new ExecutorMigrationFencedError("Executor route is not reserved; legacy intake is disabled");
      return this.legacyExecution().enqueueWebsite(...args);
    });
  }

  enqueueEmail(...args: Parameters<ExecutionCoordinator["enqueueEmail"]>) {
    return this.serializeAdapter(async () => {
      const migration = await this.intakeOutbox.phase();
      const freshRoute = await readCloudflareFreshRoute(this.ctx.storage);
      if (migration || freshRoute) return this.intakeOutbox.enqueueEmail(args[0]);
      if (this.env.EXECUTOR_ORIGIN) throw new ExecutorMigrationFencedError("Executor route is not reserved; legacy intake is disabled");
      return this.legacyExecution().enqueueEmail(...args);
    });
  }

  alarm(...args: Parameters<ExecutionCoordinator["alarm"]>): Promise<Awaited<ReturnType<ExecutionCoordinator["alarm"]>>> {
    return this.serializeAdapter(async () => {
      const migration = await this.intakeOutbox.phase();
      if (migration?.phase === "frozen") return await this.intakeOutbox.alarm() as Awaited<ReturnType<ExecutionCoordinator["alarm"]>>;
      if (migration?.phase === "active" || await readCloudflareFreshRoute(this.ctx.storage)) {
        return await this.intakeOutbox.alarm() as Awaited<ReturnType<ExecutionCoordinator["alarm"]>>;
      }
      if (this.env.EXECUTOR_ORIGIN) { await this.ctx.storage.deleteAlarm(); return undefined as Awaited<ReturnType<ExecutionCoordinator["alarm"]>>; }
      return await this.legacyExecution().alarm(...args) as Awaited<ReturnType<ExecutionCoordinator["alarm"]>>;
    });
  }

  executionRoute(): Promise<{ origin: string; epoch: number } | null> {
    return this.serializeAdapter(async () => {
      const migration = await this.intakeOutbox.phase();
      if (migration) return migration.phase === "active" ? { origin: migration.origin, epoch: migration.epoch } : null;
      return this.intakeOutbox.freshExecutionRoute();
    });
  }

  freshExecutionBinding(): Promise<ExecutorFreshBinding | null> {
    return this.serializeAdapter(async () => await this.intakeOutbox.phase() ? null : readCloudflareFreshRoute(this.ctx.storage));
  }

  prepareExecutorMigration(epoch: number): Promise<MigrationManifest> {
    return this.serializeAdapter(async () => {
      if (await readCloudflareFreshRoute(this.ctx.storage)) throw new ExecutorMigrationFencedError("Fresh executor route already owns this integration");
      return this.legacyExecution().withExclusiveState(() => this.intakeOutbox.prepare(epoch));
    });
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

  private async serialLegacy<T>(action: () => Promise<T>, emptyDiscovery = false): Promise<T> {
    return this.serializeAdapter(async () => {
      if (await this.intakeOutbox.phase() || await readCloudflareFreshRoute(this.ctx.storage)) throw new ExecutorMigrationFencedError();
      if (this.env.EXECUTOR_ORIGIN) {
        if (emptyDiscovery && !hasExecutorLegacyRows(this.ctx.storage)) return null as T;
        throw new ExecutorMigrationFencedError("Executor route is not reserved; legacy authoring is disabled");
      }
      return action();
    });
  }

  private legacyExecution(): ExecutionCoordinator {
    return this.executionInstance ??= new ExecutionCoordinator(this.ctx, this.env, {
      jobPageFetcher: () => this.jobPageFetcher(),
      resolvePrivateEmailRoute: id => this.resolvePrivateEmailRoute(id),
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
