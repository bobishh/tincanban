import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const producerNames = { frontend: 'verify', automation: 'Automation (intake, participant and owner lifecycle)' };
const positiveInteger = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));

export function selectReleaseArtifact({ component, repository, runId, attempt, sha, run, jobs, artifacts }) {
  if (!Object.hasOwn(producerNames, component) || !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      !positiveInteger(runId) || !positiveInteger(attempt) || !/^[a-f0-9]{40}$/.test(sha) ||
      String(run.id) !== String(runId) || String(run.run_attempt) !== String(attempt) || run.head_sha !== sha ||
      run.name !== 'Verify' || run.path !== '.github/workflows/ci.yml' || run.head_branch !== 'main' ||
      run.event !== 'push' || run.head_repository?.full_name !== repository ||
      run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Expected exact successful Verify run');

  const producers = jobs.filter(job => job.name === producerNames[component]);
  const job = producers[0];
  const started = Date.parse(job?.started_at), completed = Date.parse(job?.completed_at);
  if (producers.length !== 1 || job.run_id !== Number(runId) || job.head_sha !== sha ||
      job.status !== 'completed' || job.conclusion !== 'success' ||
      !Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    throw new Error(`Expected one successful producer for ${component}`);
  }
  const prefix = `tincanban-${component}-cohort-${sha}-`;
  // Partial reruns inherit completed jobs with the new run_attempt but their original execution times.
  // Bind upload to that successful execution; never fall back to an older producer's surviving artifact.
  const candidates = artifacts.filter(artifact => {
    const uploadedAttempt = artifact.name?.startsWith(prefix) ? artifact.name.slice(prefix.length) : '';
    const created = Date.parse(artifact.created_at);
    return positiveInteger(artifact.id) && positiveInteger(uploadedAttempt) && Number(uploadedAttempt) <= Number(attempt) &&
      artifact.expired === false && artifact.workflow_run?.id === Number(runId) && artifact.workflow_run?.head_sha === sha &&
      Number.isFinite(created) && created >= started && created <= completed;
  });
  if (candidates.length !== 1) throw new Error(`Expected one live artifact from successful ${component} producer execution`);
  const selected = candidates[0];
  return { id: selected.id, name: selected.name, attempt: selected.name.slice(prefix.length) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [component, repository, runId, attempt, sha] = process.argv.slice(2);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !positiveInteger(runId) || !positiveInteger(attempt)) {
    throw new Error('Invalid release artifact selection arguments');
  }
  const api = endpoint => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', endpoint],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }));
  const base = `repos/${repository}/actions/runs/${runId}`;
  const [run] = api(`${base}/attempts/${attempt}`);
  const jobs = api(`${base}/attempts/${attempt}/jobs?per_page=100`).flatMap(page => page.jobs);
  const artifacts = api(`${base}/artifacts?per_page=100`).flatMap(page => page.artifacts);
  const selected = selectReleaseArtifact({ component, repository, runId, attempt, sha, run, jobs, artifacts });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `name=${selected.name}\nattempt=${selected.attempt}\n`);
  console.log(JSON.stringify(selected));
}
