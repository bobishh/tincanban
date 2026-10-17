type WebsiteSubmission = {
  message: string;
  contact?: string;
  company?: string;
  role?: string;
  jobUrl?: string;
};

export default async function homepageToLead(input: any, participant: any) {
  const signal = input.signals.find((candidate: any) => candidate.source === "website");
  if (!signal) throw new TypeError("Homepage reaction requires a website signal");
  const payload = signal.payload as { receivedAt?: unknown; submission?: unknown };
  if (typeof payload.receivedAt !== "string" || payload.receivedAt.length > 64 ||
    !payload.submission || typeof payload.submission !== "object" || Array.isArray(payload.submission)) {
    throw new TypeError("Homepage signal payload is invalid");
  }
  const raw = payload.submission as Record<string, unknown>;
  const submission: WebsiteSubmission = {
    message: requiredText(raw.message, "message"),
    contact: optionalText(raw.contact) ?? "",
    company: optionalText(raw.company) ?? "",
    role: optionalText(raw.role) ?? "",
    ...(raw.jobUrl === undefined ? {} : { jobUrl: optionalText(raw.jobUrl) }),
  };
  const state = [
    `Submitted company: ${submission.company || "(not supplied)"}`,
    `Submitted role: ${submission.role || "(not supplied)"}`,
    `Contact: ${submission.contact || "(not supplied)"}`,
    `Message: ${submission.message}`,
    `Job URL: ${submission.jobUrl || "(not supplied)"}`,
  ].join("\n");
  const decision = await participant.classifyOpportunity(state);
  const classification = {
    status: "review",
    reason: decision.relevance === "yes"
      ? "Lead needs review until Clef confidence and an approved scope satisfy the write policy"
      : decision.relevance === "no" ? "Clef classified this as unrelated" : "Clef could not establish a job opportunity",
    source: { type: "website", receivedAt: payload.receivedAt },
    decision,
  };
  const event = { source: "website", receivedAt: payload.receivedAt, submission };
  return await participant.enqueueItemCommand({ event, classification });
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`Homepage ${name} must be text`);
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError("Homepage submission field must be text");
  return value.trim();
}
