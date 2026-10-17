import { DurableObject } from "cloudflare:workers";
import { ExecutionCoordinator } from "./executionCoordinator";
import { privateEmailRoutes } from "./emailRoutes";
import type { JobPageFetcher } from "./extraction";
import type { WorkerEnv } from "./index";
import { configureAutomationTelemetry, flushAutomationTelemetryAfter } from "./telemetry";

export { writeReplicaChunksAtomically } from "./executionCoordinator";
export type { StoredEventStatus, EnqueueSuccess, EnqueueResult } from "./executionCoordinator";

/** Local Cloudflare adapter. Production participant execution belongs to Reflux. */
export class AutomationCoordinator extends DurableObject<WorkerEnv> {
  private readonly instance?: ExecutionCoordinator;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    configureAutomationTelemetry(env);
    if (env.REFLUX_ORIGIN) return;
    this.instance = new ExecutionCoordinator(ctx, env, {
      jobPageFetcher: () => this.jobPageFetcher(),
      resolvePrivateEmailRoute: id => this.resolvePrivateEmailRoute(id),
    });
  }
  enrollOwner(...args: Parameters<ExecutionCoordinator["enrollOwner"]>) { return this.execution.enrollOwner(...args); }
  activateOwner(...args: Parameters<ExecutionCoordinator["activateOwner"]>) { return this.execution.activateOwner(...args); }
  getRegisteredIntegration(...args: Parameters<ExecutionCoordinator["getRegisteredIntegration"]>) { return this.execution.getRegisteredIntegration(...args); }
  observeOwner(...args: Parameters<ExecutionCoordinator["observeOwner"]>) { return this.execution.observeOwner(...args); }
  provisionIdentity(...args: Parameters<ExecutionCoordinator["provisionIdentity"]>) { return this.execution.provisionIdentity(...args); }
  activateReplica(...args: Parameters<ExecutionCoordinator["activateReplica"]>) { return this.execution.activateReplica(...args); }
  saveReplicaState(...args: Parameters<ExecutionCoordinator["saveReplicaState"]>) { return this.execution.saveReplicaState(...args); }
  loadReplicaState(...args: Parameters<ExecutionCoordinator["loadReplicaState"]>) { return this.execution.loadReplicaState(...args); }
  retryEmail(...args: Parameters<ExecutionCoordinator["retryEmail"]>) { return this.execution.retryEmail(...args); }
  bindEmailApplication(...args: Parameters<ExecutionCoordinator["bindEmailApplication"]>) { return this.execution.bindEmailApplication(...args); }
  retryBoundEmailApplication(...args: Parameters<ExecutionCoordinator["retryBoundEmailApplication"]>) { return this.execution.retryBoundEmailApplication(...args); }
  manageInstance(...args: Parameters<ExecutionCoordinator["manageInstance"]>) { return this.execution.manageInstance(...args); }
  applicationReview(...args: Parameters<ExecutionCoordinator["applicationReview"]>) { return this.execution.applicationReview(...args); }
  emailSetup(...args: Parameters<ExecutionCoordinator["emailSetup"]>) { return this.execution.emailSetup(...args); }
  classificationContext(...args: Parameters<ExecutionCoordinator["classificationContext"]>) { return this.execution.classificationContext(...args); }
  getEvent(...args: Parameters<ExecutionCoordinator["getEvent"]>) { return this.execution.getEvent(...args); }
  enqueueWebsite(...args: Parameters<ExecutionCoordinator["enqueueWebsite"]>) { return this.execution.enqueueWebsite(...args); }
  enqueueEmail(...args: Parameters<ExecutionCoordinator["enqueueEmail"]>) { return this.execution.enqueueEmail(...args); }
  alarm(...args: Parameters<ExecutionCoordinator["alarm"]>) {
    if (this.env.REFLUX_ORIGIN) return this.ctx.storage.deleteAlarm();
    const operation = this.execution.alarm(...args);
    flushAutomationTelemetryAfter(this.ctx, operation);
    return operation;
  }

  private get execution(): ExecutionCoordinator {
    if (!this.instance) throw new Error("Automation processing belongs to Reflux");
    return this.instance;
  }

  protected jobPageFetcher(): JobPageFetcher { return fetch; }
  protected async resolvePrivateEmailRoute(id: string): Promise<ReturnType<typeof privateEmailRoutes>[number] | undefined> {
    return privateEmailRoutes(this.env).find(value => value.id === id);
  }
}
