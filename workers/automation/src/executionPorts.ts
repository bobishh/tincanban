import type { DecisionAi } from "./clef";
import type { PrivateEmailRoute } from "./emailRoutes";
import type { JobPageFetcher } from "./extraction";
import type { ReplicaTransport } from "./replica";
import type { AutomationTelemetryBindings } from "./telemetry";
import type { AutomationEvent, AutomationPipelineResult } from "./pipeline";
import type { AutomationDefinition } from "../../../src/domain/automationContract";
import type { EmployeeProfile } from "../../../src/domain/jobPriority";

export type ExecutionSqlValue = ArrayBuffer | string | number | null;
export interface ExecutionSqlCursor<T> extends Iterable<T> {
  toArray(): T[];
  one(): T;
}
export interface ExecutionSqlPort {
  exec<T extends Record<string, ExecutionSqlValue> = Record<string, ExecutionSqlValue>>(
    query: string, ...bindings: ExecutionSqlValue[]
  ): ExecutionSqlCursor<T>;
}
export interface ExecutionSqlTransactionPort {
  sql: ExecutionSqlPort;
  transactionSync<T>(callback: () => T): T;
}
export interface ExecutionStoragePort extends ExecutionSqlTransactionPort {
  readonly schemaManaged?: boolean;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export interface ExecutionContextPort {
  id: { name?: string };
  storage: ExecutionStoragePort;
  waitUntil(promise: Promise<unknown>): void;
}
export interface ExecutionEnvironment extends AutomationTelemetryBindings {
  AI: DecisionAi;
  INTEGRATIONS_JSON: string;
  EMAIL_ROUTES_JSON?: string;
  IDENTITY_STORAGE_SECRET?: string;
  EVENT_STORAGE_SECRET?: string;
}
export interface ExecutionAdapters {
  replicaTransport?: ReplicaTransport;
  jobPageFetcher?: () => JobPageFetcher;
  resolvePrivateEmailRoute?: (id: string) => Promise<PrivateEmailRoute | undefined>;
  classify?: (event: AutomationEvent, definition: AutomationDefinition | undefined, employeeProfile: EmployeeProfile,
    priorityBands?: Array<{ optionId: string; minScore: number }>) => Promise<AutomationPipelineResult>;
}
