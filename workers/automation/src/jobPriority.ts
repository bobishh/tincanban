export type EmployeeProfile = { stack: string; work_profile: string }
export const emptyEmployeeProfile = (): EmployeeProfile => ({ stack: "", work_profile: "" })
const jobCriteria = ["companyRecognition", "companyStability", "stackFit", "workFit"] as const
type JobCriterion = typeof jobCriteria[number]
export type JobAssessment = {
  version: 1
  employee_profile: EmployeeProfile
  scores: Record<JobCriterion, number | null>
}
const jobWeights: Record<JobCriterion, number> = {
  companyRecognition: 0.2, companyStability: 0.2, stackFit: 0.3, workFit: 0.3,
}

export const defaultJobBands = [
  { optionId: "p0", minScore: 8 }, { optionId: "p1", minScore: 6 },
  { optionId: "p2", minScore: 3 }, { optionId: "p3", minScore: 0 },
]
export function priorityOptionForScore(score: number, bands = defaultJobBands): string | null {
  return [...bands].sort((a, b) => b.minScore - a.minScore).find(band => score >= band.minScore)?.optionId ?? null
}

export function evaluateJobAssessment(assessment: JobAssessment | null, profile?: EmployeeProfile): number {
  if (!assessment) return 0
  const current = profile ?? emptyEmployeeProfile()
  const sameProfile = current.stack === assessment.employee_profile.stack && current.work_profile === assessment.employee_profile.work_profile
  const score = jobCriteria.reduce((sum, key) => {
    const eligible = key === "stackFit" ? sameProfile && !!current.stack.trim()
      : key === "workFit" ? sameProfile && !!current.work_profile.trim() : true
    return sum + (eligible ? assessment.scores[key] ?? 0 : 0) * jobWeights[key]
  }, 0)
  return Math.round(score * 10) / 10
}
