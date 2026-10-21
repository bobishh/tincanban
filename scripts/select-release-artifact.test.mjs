import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReleaseArtifact } from './select-release-artifact.mjs';

const sha = 'a'.repeat(40);
const run = { id: 123, run_attempt: 2, head_sha: sha, head_branch: 'main', event: 'push',
  name: 'Verify', path: '.github/workflows/ci.yml', status: 'completed', conclusion: 'success',
  head_repository: { full_name: 'owner/repo' } };
const job = (component, start, end) => ({ name: component === 'frontend' ? 'verify' : 'Automation (intake, participant and owner lifecycle)',
  run_id: 123, run_attempt: 2, head_sha: sha, status: 'completed', conclusion: 'success',
  started_at: `2026-10-21T13:${start}:00Z`, completed_at: `2026-10-21T13:${end}:00Z` });
const artifact = (component, attempt, minute) => ({ id: 1000 + attempt,
  name: `tincanban-${component}-cohort-${sha}-${attempt}`, expired: false,
  created_at: `2026-10-21T13:${minute}:00Z`, workflow_run: { id: 123, head_sha: sha } });
const input = (component, artifacts, jobs = [job('automation', '00', '10'), job('frontend', '15', '20')]) =>
  ({ component, repository: 'owner/repo', runId: '123', attempt: '2', sha, run, jobs, artifacts });

test('Given only frontend reruns, when deploying the successful run, then use each component actual upload attempt', () => {
  const artifacts = [artifact('automation', 1, '05'), artifact('frontend', 2, '19')];
  assert.equal(selectReleaseArtifact(input('automation', artifacts)).attempt, '1');
  assert.equal(selectReleaseArtifact(input('frontend', artifacts)).attempt, '2');
});

test('Given a rerun producer with missing or expired output, then reject stale artifacts from earlier execution', () => {
  const jobs = [job('automation', '15', '20')];
  const earlier = artifact('automation', 1, '05');
  assert.throws(() => selectReleaseArtifact(input('automation', [earlier], jobs)), /one live artifact/);
  assert.throws(() => selectReleaseArtifact(input('automation', [earlier, { ...artifact('automation', 2, '19'), expired: true }], jobs)), /one live artifact/);
});

test('Given failed or ambiguous producer evidence, then reject deployment', () => {
  const artifacts = [artifact('automation', 1, '05')];
  for (const jobs of [[], [{ ...job('automation', '00', '10'), conclusion: 'failure' }],
    [job('automation', '00', '10'), job('automation', '00', '10')]]) {
    assert.throws(() => selectReleaseArtifact(input('automation', artifacts, jobs)), /successful producer/);
  }
});

test('Given wrong run, SHA, future attempt, or ambiguous upload, then reject artifact selection', () => {
  const selected = artifact('automation', 1, '05');
  for (const artifacts of [
    [{ ...selected, workflow_run: { id: 124, head_sha: sha } }],
    [{ ...selected, workflow_run: { id: 123, head_sha: 'b'.repeat(40) } }],
    [artifact('automation', 3, '05')],
    [selected, { ...selected, id: 2000 }],
  ]) assert.throws(() => selectReleaseArtifact(input('automation', artifacts)), /one live artifact/);
  for (const change of [{ conclusion: 'failure' }, { head_sha: 'b'.repeat(40) }, { run_attempt: 3 },
    { event: 'pull_request' }, { head_repository: { full_name: 'attacker/fork' } }]) {
    assert.throws(() => selectReleaseArtifact({ ...input('automation', [selected]), run: { ...run, ...change } }), /successful Verify/);
  }
});
