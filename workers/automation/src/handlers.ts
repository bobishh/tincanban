import type { EmployeeProfile } from "../../../src/domain/jobPriority";
import { parseAutomationDefinition, type AutomationDefinition } from "../../../src/domain/automationContract";
import type { DecisionAi } from "./clef";
import { runPipeline, type AutomationEvent, type AutomationPipelineResult } from "./pipeline";
import type { JobPageFetcher } from "./extraction";

const handlers = { "job-intake@1": runPipeline, "job-intake@2": runPipeline };

/** Deployed handlers implement registered types; incoming source names never select arbitrary code. */
export function runRegisteredAutomation(definition: AutomationDefinition, event: AutomationEvent, ai: DecisionAi, employeeProfile?: EmployeeProfile, bands?: Array<{ optionId: string; minScore: number }>, fetcher?: JobPageFetcher): Promise<AutomationPipelineResult> {
  const validated = parseAutomationDefinition(definition);
  if (!validated.parameters.sources.includes(event.source)) throw new Error("Event source is disabled for this automation");
  return handlers[`${validated.type}@${validated.typeVersion}`](event, ai, fetcher, employeeProfile, bands);
}
