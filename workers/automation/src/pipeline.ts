import type { EmployeeProfile } from "../../../src/domain/jobPriority";
import { classifyApplicationEvent, classifyOpportunity, type ApplicationEventClassification, type DecisionAi, type OpportunityClassification } from "./clef";
import type { ForwardedMail } from "./email";
import { extractJobPage, type JobPageFetcher, type JobPageResult } from "./extraction";
import type { WebsiteSubmission } from "./intake";

export type AutomationEvent =
  | { source: "website"; receivedAt: string; submission: Omit<WebsiteSubmission, "humanCheckToken" | "humanCheckAnswer"> }
  | { source: "email"; receivedAt: string; message: ForwardedMail; rawMime: string };

export type AutomationPipelineResult = {
  status: "review";
  reason: string;
  source: { type: AutomationEvent["source"]; receivedAt: string; messageId?: string | null; jobUrl?: string };
  extraction?: JobPageResult;
  decision?: OpportunityClassification | ApplicationEventClassification;
};

/** Classifies durable intake. It deliberately has no mutation/publisher port until a scoped signer is provisioned. */
export async function runPipeline(event: AutomationEvent, ai: DecisionAi, fetcher: JobPageFetcher = fetch, employeeProfile?: EmployeeProfile, bands?: Array<{ optionId: string; minScore: number }>): Promise<AutomationPipelineResult> {
  if (event.source === "email") return processMail(event, ai);
  return processWebsite(event, ai, fetcher, employeeProfile, bands);
}

async function processWebsite(
  event: Extract<AutomationEvent, { source: "website" }>,
  ai: DecisionAi,
  fetcher: JobPageFetcher,
  employeeProfile?: EmployeeProfile,
  bands?: Array<{ optionId: string; minScore: number }>,
): Promise<AutomationPipelineResult> {
  const submission = event.submission;
  const extraction = submission.jobUrl ? await extractJobPage(submission.jobUrl, {
    company: submission.company,
    role: submission.role,
  }, fetcher) : undefined;
  const state = [
    `Submitted company: ${submission.company || "(not supplied)"}`,
    `Submitted role: ${submission.role || "(not supplied)"}`,
    `Contact: ${submission.contact || "(not supplied)"}`,
    `Message: ${submission.message}`,
    `Job URL: ${submission.jobUrl || "(not supplied)"}`,
    ...(extraction ? [
      `Extracted page title: ${extraction.title}`,
      `Extracted company: ${extraction.company}`,
      `Extracted role: ${extraction.role}`,
      `Extracted description: ${extraction.description}`,
      `Extracted body: ${extraction.body}`,
    ] : []),
  ].join("\n");
  const decision = await classifyOpportunity(ai, state, employeeProfile, bands);
  const source = { type: "website" as const, receivedAt: event.receivedAt, ...(extraction ? { jobUrl: extraction.finalUrl } : {}) };
  if (decision.relevance !== "yes") {
    return {
      status: "review",
      reason: decision.relevance === "no" ? "Clef classified this as unrelated" : "Clef could not establish a job opportunity",
      source,
      ...(extraction ? { extraction } : {}),
      decision,
    };
  }
  const company = submission.company || extraction?.company || "";
  const role = submission.role || extraction?.role || "";
  if (!company.trim() || !role.trim()) {
    return { status: "review", reason: "A company and role are required before a Lead can be proposed", source,
      ...(extraction ? { extraction } : {}), decision };
  }
  return {
    status: "review",
    reason: "Lead needs review until Clef confidence and an approved scope satisfy the write policy",
    source,
    ...(extraction ? { extraction } : {}),
    decision,
  };
}

async function processMail(
  event: Extract<AutomationEvent, { source: "email" }>,
  ai: DecisionAi,
): Promise<AutomationPipelineResult> {
  const mail = event.message;
  const source = { type: "email" as const, receivedAt: event.receivedAt, messageId: mail.messageId };
  if (mail.confirmation) {
    return { status: "review", reason: "Forwarding-address confirmation requires owner attention", source };
  }
  const decision = await classifyApplicationEvent(ai, `${mail.subject}\n\n${mail.text}`);
  return {
    status: "review",
    reason: decision.event === "uncertain"
      ? "Clef did not return a clear interview or rejection decision"
      : "Message needs a unique approved application match and scoped status-move authoring",
    source,
    decision,
  };
}
