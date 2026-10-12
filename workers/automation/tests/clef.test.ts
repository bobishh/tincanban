import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyOpportunity, classifyApplicationEvent } from '../src/clef.ts';

const roleProbabilities = { backend: 1, frontend: 0, fullstack: 0, platform_devops: 0, data_ai: 0, mobile: 0, engineering_management: 0, other_unknown: 0 };
const seniorityProbabilities = { intern_junior: 0, middle: 0, senior: 1, staff_principal: 0, lead_manager: 0, unknown: 0 };
const unknownAssessments = Object.fromEntries(['company_recognition', 'company_stability', 'stack_fit', 'work_fit'].map(key => [key, {
  type: 'choice', choice: 'unknown', confidence: 1, probabilities: { strong: 0, partial: 0, weak: 0, unknown: 1 },
}]));
const ai = (answers: unknown) => ({ run: async () => ({ model: 'clef-flash', answers: { ...unknownAssessments, ...(answers as object) } }) });

test('Given complete Clef probability maps, when classifying a vacancy, then preserves every distribution', async () => {
  const distributions = {
    job_opportunity: { type: 'choice', choice: 'yes', confidence: 0.8, probabilities: { yes: 0.8, no: 0.1, uncertain: 0.1 } },
    role_type: { type: 'choice', choice: 'backend', confidence: 1, probabilities: roleProbabilities },
    seniority: { type: 'choice', choice: 'senior', confidence: 1, probabilities: seniorityProbabilities },
  };
  const result = await classifyOpportunity(ai(distributions), 'vacancy');
  assert.equal(result.relevance, 'yes');
  assert.deepEqual(result.distributions, distributions);
});

test('Given a valid Clef distribution and a lower independent confidence score, when classifying, then accepts the distribution without equating the two values', async () => {
  const result = await classifyOpportunity(ai({
    job_opportunity: { type: 'choice', choice: 'no', confidence: 0.0944, probabilities: { yes: 0.2303, no: 0.5381, uncertain: 0.2316 } },
    role_type: { type: 'choice', choice: 'backend', confidence: 0.9039, probabilities: { ...roleProbabilities, backend: 0.9672, frontend: 0.0161, other_unknown: 0.0167 } },
    seniority: { type: 'choice', choice: 'staff_principal', confidence: 0.7977, probabilities: { ...seniorityProbabilities, senior: 0.0637, staff_principal: 0.9279, unknown: 0.0084 } },
  }), 'vacancy');
  assert.equal(result.relevance, 'no');
  assert.equal(result.distributions.job_opportunity.confidence, 0.0944);
});

test('Given malformed Clef probabilities, when classifying, then leaves event retryable by throwing', async () => {
  await assert.rejects(classifyOpportunity(ai({
    job_opportunity: { type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: 1, no: 0 } },
    role_type: { type: 'choice', choice: 'backend', confidence: 1, probabilities: roleProbabilities },
    seniority: { type: 'choice', choice: 'senior', confidence: 1, probabilities: seniorityProbabilities },
  }), 'vacancy'));
});

test('Given uncertain application-event distribution, when classifying, then requests review', async () => {
  const result = await classifyApplicationEvent(ai({
    application_event: { type: 'choice', choice: 'interview', confidence: 0.44, probabilities: { new_opportunity: 0, applied: 0, interview: 0.44, rejected: 0.4, offer: 0, follow_up: 0, unrelated: 0, uncertain: 0.16 } },
  }), 'mail');
  assert.equal(result.event, 'uncertain');
});

test('Given a confident rejection, when classifying, then returns a rejection and keeps full probabilities', async () => {
  const probabilities = { new_opportunity: 0, applied: 0, interview: 0.04, rejected: 0.9, offer: 0.01, follow_up: 0.02, unrelated: 0.01, uncertain: 0.02 };
  const result = await classifyApplicationEvent(ai({
    application_event: { type: 'choice', choice: 'rejected', confidence: 0.9, probabilities },
  }), 'We will not be proceeding.');
  assert.equal(result.event, 'rejection');
  assert.deepEqual(result.distributions.application_event.probabilities, probabilities);
});

test('Given employee_profile, when Clef assesses intake, then compares stack and work and returns shared weighted priority', async () => {
  const profile = { stack: 'Rust, TypeScript', work_profile: 'Principal distributed systems engineer' };
  const result = await classifyOpportunity({ run: async (_model, input) => {
    const request = input as { state: { employee_profile: unknown }; questions: Record<string, unknown> };
    assert.deepEqual(request.state.employee_profile, profile);
    assert.ok(request.questions.company_stability);
    return { answers: {
      job_opportunity: { type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: 1, no: 0, uncertain: 0 } },
      role_type: { type: 'choice', choice: 'backend', confidence: 1, probabilities: roleProbabilities },
      seniority: { type: 'choice', choice: 'senior', confidence: 1, probabilities: seniorityProbabilities },
      ...Object.fromEntries(['company_recognition', 'company_stability', 'stack_fit', 'work_fit'].map(key => [key, {
        type: 'choice', choice: 'strong', confidence: 1, probabilities: { strong: 1, partial: 0, weak: 0, unknown: 0 },
      }])),
    } };
  } }, 'A real vacancy', profile);
  assert.equal(result.priority.score, 10);
  assert.equal(result.priority.optionId, 'p0');
  assert.deepEqual(result.assessment.employee_profile, profile);
});

test('Given uncertain fit evidence and no employee profile, when assessing, then uncertainty contributes no points', async () => {
  const uncertain = { type: 'choice', choice: 'strong', confidence: 0.3,
    probabilities: { strong: 0.55, partial: 0.3, weak: 0.1, unknown: 0.05 } };
  const result = await classifyOpportunity(ai({
    job_opportunity: { type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: 1, no: 0, uncertain: 0 } },
    role_type: { type: 'choice', choice: 'backend', confidence: 1, probabilities: roleProbabilities },
    seniority: { type: 'choice', choice: 'senior', confidence: 1, probabilities: seniorityProbabilities },
    company_stability: uncertain,
    stack_fit: { ...uncertain, confidence: 1, probabilities: { strong: 1, partial: 0, weak: 0, unknown: 0 } },
  }), 'vacancy');
  assert.equal(result.assessment.scores.companyStability, null);
  assert.equal(result.priority.score, 0);
});

test('Given a confident receipt confirmation, when classifying, then selects Applied rather than interview or follow-up', async () => {
  const probabilities = { new_opportunity: 0, applied: 0.95, interview: 0.01, rejected: 0, offer: 0, follow_up: 0.02, unrelated: 0, uncertain: 0.02 };
  const result = await classifyApplicationEvent(ai({ application_event: {
    type: 'choice', choice: 'applied', confidence: 0.95, probabilities,
  } }), 'We received your application for Senior Software Engineer at Example GmbH.');
  assert.equal(result.event, 'applied');
});
