module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  if (owner !== 'bobishh' || !['tincanban', 'gonzo-yuppie', 'cultiwars'].includes(repo)) {
    throw new Error('Artifact cleanup is not configured for this repository');
  }
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const artifacts = await github.paginate(github.rest.actions.listArtifactsForRepo, { owner, repo, per_page: 100 });
  const active = [];
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    active.push(...await github.paginate(github.rest.actions.listWorkflowRunsForRepo, { owner, repo, status, per_page: 100 }));
  }
  const protectedRuns = new Set(active.map(run => run.id));
  const protectedShas = new Set(active.map(run => run.head_sha));
  const deploymentPending = active.some(run => ['.github/workflows/deploy-frontend.yml',
    '.github/workflows/deploy-automation.yml', '.github/workflows/recover-release.yml'].includes(run.path));
  const releaseNames = /^(?:tincanban-(?:frontend|automation)-cohort-|(?:frontend|automation)-deployment-)/;
  const diagnostics = /^(?:unit-coverage|tincanban-tlc-|core-failure-|browser-.*-failure$|archives-.*-failure$|policy-packaging-failure$|automation-worker-failure$|cohort-(?:result|staged)-|executor-(?:checked|deployment)-)/;
  if (repo === 'tincanban') {
    // Keep the active release even if activation succeeded but its final CI check failed.
    for (const [component, origin] of [['frontend', 'https://match.meta-uber-engineer.dev'], ['automation', 'https://automation.meta-uber-engineer.dev']]) {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.ok) throw new Error(`Cannot establish active release at ${origin}: ${response.status}`);
      const health = await response.json();
      if (health.status !== 'ready' || !/^[a-f0-9]{40}$/.test(health.buildSha)) throw new Error('Invalid active release identity');
      protectedShas.add(health.buildSha);
      if (!artifacts.some(artifact => artifact.name.startsWith(`tincanban-${component}-cohort-`) && artifact.workflow_run?.head_sha === health.buildSha)) {
        throw new Error('Active release artifacts are unavailable; inspect recovery evidence before pruning');
      }
    }
    // Preserve current + one prior successful deployment per component, including recovery deployments.
    const deployments = [];
    for (const workflow_id of ['deploy-frontend.yml', 'deploy-automation.yml', 'recover-release.yml']) {
      const { data } = await github.rest.actions.listWorkflowRuns({ owner, repo, workflow_id, branch: 'main', status: 'success', per_page: 100 });
      deployments.push(...data.workflow_runs);
    }
    for (const component of ['frontend', 'automation']) {
      const selected = deployments.filter(run => artifacts.some(artifact => artifact.workflow_run?.id === run.id && artifact.name.startsWith(`${component}-deployment-`)))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const versions = new Set();
      for (const run of selected) {
        let sourceSha = run.head_sha;
        if (run.path === '.github/workflows/recover-release.yml') {
          const artifact = artifacts.find(value => value.workflow_run?.id === run.id && value.name.startsWith(`${component}-deployment-`));
          const { execFileSync } = require('node:child_process');
          const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
          const { join } = require('node:path');
          const directory = mkdtempSync(join(require('node:os').tmpdir(), 'rollback-artifact-'));
          try {
            const archive = join(directory, 'deployment.zip');
            writeFileSync(archive, execFileSync('gh', ['api', `repos/${owner}/${repo}/actions/artifacts/${artifact.id}/zip`], { maxBuffer: 512 * 1024 * 1024 }));
            const manifest = JSON.parse(execFileSync('unzip', ['-p', archive, '*/artifact.json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
            if (manifest.component !== component || !/^[a-f0-9]{40}$/.test(manifest.sourceSha)) throw new Error('Invalid rollback source artifact');
            sourceSha = manifest.sourceSha;
          } finally { rmSync(directory, { recursive: true, force: true }); }
        }
        versions.add(sourceSha);
        if (versions.size > 2) break;
        protectedShas.add(sourceSha);
        protectedRuns.add(run.id);
      }
    }
    // A successful Verify may be waiting for its separate deployment workflows to start.
    const { data } = await github.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: 'ci.yml', branch: 'main', status: 'success', per_page: 1 });
    for (const run of data.workflow_runs) protectedShas.add(run.head_sha);
  }
  const runStates = new Map();
  const deleted = [];
  let kept = 0;
  const dryRun = context.eventName === 'workflow_dispatch' && String(context.payload.inputs?.dry_run) === 'true';
  for (const artifact of artifacts) {
    const runId = artifact.workflow_run?.id;
    const age = now - Date.parse(artifact.created_at);
    const sha = artifact.workflow_run?.head_sha;
    const isRelease = repo === 'tincanban' && releaseNames.test(artifact.name);
    const isDiagnostic = repo === 'tincanban' ? diagnostics.test(artifact.name)
      : repo === 'cultiwars' && ['playwright-report', 'quality-reports'].includes(artifact.name);
    const isTransfer = repo === 'gonzo-yuppie' && artifact.name.startsWith('verified-blog-');
    const isBuildRecord = artifact.name.endsWith('.dockerbuild');
    if (artifact.expired || !runId || protectedRuns.has(runId) || (protectedShas.has(sha) || deploymentPending) && isRelease ||
        !(isRelease || isDiagnostic || isTransfer || isBuildRecord) || !Number.isFinite(age) || age < 0 ||
        isRelease && age < 60 * 60 * 1000) { kept++; continue; }
    if (!runStates.has(runId)) {
      const { data } = await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
      runStates.set(runId, data);
    }
    const run = runStates.get(runId);
    if (run.status !== 'completed' || protectedShas.has(sha) && isTransfer ||
        (isDiagnostic || isBuildRecord || isTransfer && run.conclusion !== 'success') && age < day) { kept++; continue; }
    core.info(`${dryRun ? 'Would delete' : 'Delete'} ${artifact.id} ${artifact.name} (${artifact.size_in_bytes} bytes)`);
    if (!dryRun) await github.rest.actions.deleteArtifact({ owner, repo, artifact_id: artifact.id });
    deleted.push(artifact);
  }
  const bytes = deleted.reduce((sum, artifact) => sum + artifact.size_in_bytes, 0);
  await core.summary.addHeading(dryRun ? 'Artifact cleanup preview' : 'Artifact cleanup')
    .addRaw(`${deleted.length} artifacts, ${(bytes / 1024 / 1024).toFixed(1)} MiB ${dryRun ? 'eligible' : 'removed'}; ${kept} preserved.\n`)
    .addRaw('Active runs, deployed sealed releases and retained rollback sources are preserved. Caches are untouched.\n').write();
};
