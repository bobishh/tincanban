import type { ForwardedMail } from "./email.ts";
import { correlateApplicationFromJobPages } from "./applicationMatching.ts";
import type { JobPageFetcher } from "./extraction.ts";
import type { AutomationCandidate } from "./replica";

type Columns = { lead: string; applied?: string; interview: string; rejected: string };
export type ApplicationMovePlan = { kind: "move"; candidate: AutomationCandidate; columnId: string } | { kind: "review"; reason: string };

/** Explain every stop after classification; matching and stale-workflow guards remain authoritative. */
export async function planApplicationMove(mail: ForwardedMail, candidates: AutomationCandidate[], columns: Columns,
  event: "applied" | "interview" | "rejection", fetcher: JobPageFetcher = fetch): Promise<ApplicationMovePlan> {
  const correlation = await correlateApplicationFromJobPages(mail, candidates, fetcher);
  if (correlation.kind !== "matched") return { kind: "review", reason: correlation.reason };
  const candidate = candidates.find(item => item.cardId === correlation.cardId)!;
  const messageTime = mail.date ? Date.parse(mail.date) : Number.NaN;
  const changedTime = candidate.workflow ? Date.parse(candidate.workflow.changedAt) : Number.NaN;
  if (!Number.isFinite(messageTime)) return { kind: "review", reason: "Email has no valid original date" };
  if (!Number.isFinite(changedTime)) return { kind: "review", reason: "Application has no dated workflow to compare with this email" };
  if (messageTime < changedTime) return { kind: "review", reason: "Email is older than the latest application status" };
  const columnId = event === "applied" ? columns.applied : event === "interview" ? columns.interview : columns.rejected;
  if (!columnId) return { kind: "review", reason: "The target status is not authorized for this automation" };
  const canAdvance = candidate.columnId === columns.lead && [columns.applied, columns.interview, columns.rejected].includes(columnId) ||
    candidate.columnId === columns.applied && [columns.interview, columns.rejected].includes(columnId) ||
    candidate.columnId === columns.interview && columnId === columns.rejected;
  return canAdvance ? { kind: "move", candidate, columnId }
    : { kind: "review", reason: "This email would repeat or reverse the current application status" };
}
