import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('Given Reflux owns the participant, when packaging reactions, then no standalone executor service or deployment remains', () => {
  for (const path of ['services/executor', '.github/workflows/executor.yml', '.github/workflows/executor-migration.yml']) {
    assert.equal(existsSync(resolve(root, path)), false, `${path} must be retired`);
  }
  const dockerfile = readFileSync(resolve(root, 'services/reaction-runtime/Dockerfile'), 'utf8');
  assert.doesNotMatch(dockerfile, /services\/executor|main\.mjs|EXPOSE/);
  assert.match(dockerfile, /services\/reaction-runtime\/build\.mjs/);
});
