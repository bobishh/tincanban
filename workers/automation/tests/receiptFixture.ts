import type { DecisionAi } from "../src/clef";

export const receiptAi: DecisionAi = { run: async (_model, input) => {
  const { questions } = input as { questions: Record<string, unknown> };
  const choice = (value: string, labels: string[]) => ({ type: "choice", choice: value, confidence: 1,
    probabilities: Object.fromEntries(labels.map(label => [label, label === value ? 1 : 0])) });
  return { answers: questions.application_event ? {
    application_event: choice("applied", ["new_opportunity", "applied", "interview", "rejected", "offer", "follow_up", "unrelated", "uncertain"]),
  } : {
    job_opportunity: choice("yes", ["yes", "no", "uncertain"]),
    role_type: choice("backend", ["backend", "frontend", "fullstack", "platform_devops", "data_ai", "mobile", "engineering_management", "other_unknown"]),
    seniority: choice("middle", ["intern_junior", "middle", "senior", "staff_principal", "lead_manager", "unknown"]),
    ...Object.fromEntries(["company_recognition", "company_stability", "stack_fit", "work_fit"].map(key =>
      [key, choice("unknown", ["strong", "partial", "weak", "unknown"])])),
  } };
} };
