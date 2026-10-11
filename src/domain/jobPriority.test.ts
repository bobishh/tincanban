import { expect, it } from "vitest"
import { evaluateJobAssessment, readJobAssessment } from "./jobPriority"

const profile = { stack: "Rust, TypeScript, Postgres", work_profile: "Principal backend, distributed systems" }
const assessment = { version: 1 as const, employee_profile: profile, scores: {
  companyRecognition: 10, companyStability: 5, stackFit: 10, workFit: 5,
} }

it("Given a stable known company and matching employee profile, when evaluated, then scores company 40% and fit 60%", () => {
  expect(evaluateJobAssessment(assessment, profile)).toBe(7.5)
})

it("Given missing evidence or profile, when evaluated, then awards no unsupported fit points", () => {
  expect(evaluateJobAssessment(null, profile)).toBe(0)
  expect(evaluateJobAssessment(assessment, { stack: "", work_profile: "" })).toBe(3)
  expect(evaluateJobAssessment({ ...assessment, scores: { ...assessment.scores, companyStability: null } }, profile)).toBe(6.5)
})

it("Given changed employee profile, when reading an older assessment, then drops stale comparison points", () => {
  expect(evaluateJobAssessment(assessment, { ...profile, stack: "Java" })).toBe(3)
})

it("Given persisted intake evidence, when reading, then accepts complete assessments and rejects truncated or invalid data", () => {
  expect(readJobAssessment(JSON.stringify({ decision: { assessment } }))).toEqual(assessment)
  expect(readJobAssessment('{"decision":')).toBeNull()
  expect(readJobAssessment(JSON.stringify({ decision: { assessment: { ...assessment, scores: { ...assessment.scores, stackFit: 100 } } } }))).toBeNull()
})
