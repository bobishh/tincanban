import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRuntimeEnvironment, validateDeploymentPin } from './deploy.mjs';

const automationOrigin = 'https://automation.meta-uber-engineer.dev';
const expectedOrigin = 'https://executor.meta-uber-engineer.dev';
const manifestHashPattern = /^[A-Za-z0-9_-]{43}$/;

/** Transport only: admission, page authentication and cutover authority stay in the participants. */
export async function migrateExecutor({ action, integrationId, epoch, origin, token, manualResolutions, fetcher = fetch, progress = () => {} }) {
  if (!['import', 'activate'].includes(action) || !/^[A-Za-z0-9_-]{1,128}$/.test(integrationId ?? '') ||
      !Number.isSafeInteger(epoch) || epoch < 1 || origin !== expectedOrigin || typeof token !== 'string' || !token) {
    throw new Error('Migration requires an exact action, integration, positive epoch, fixed origin and service credential');
  }
  if (action === 'activate' && (!Array.isArray(manualResolutions) || manualResolutions.length > 100 || manualResolutions.some(value =>
    !value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['eventId', 'reason', 'itemId'].includes(key)) ||
    typeof value.eventId !== 'string' || !value.eventId || value.eventId.length > 128 ||
    typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 1000 ||
    (value.itemId !== undefined && (typeof value.itemId !== 'string' || !value.itemId || value.itemId.length > 256))))) {
    throw new Error('Activation requires an explicit bounded manual-resolution JSON array');
  }
  const executorBase = `${origin}/internal/integrations/${integrationId}`;
  const sourceBase = `${automationOrigin}/internal/executor-migrations/${integrationId}`;
  const request = async (url, method = 'GET', body) => {
    const response = await fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(180_000),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    // Responses can include retained private mail. Error output deliberately reports only the operation and HTTP status.
    if (!response.ok) throw new Error(`Migration ${method} ${new URL(url).pathname} failed (HTTP ${response.status})`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Migration service returned an empty response');
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Migration response exceeds its transport bound'); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Migration service returned invalid JSON'); }
  };
  const initial = await request(`${executorBase}/status`);
  if (action === 'activate') {
    requireImported(initial, epoch);
    await request(`${executorBase}/activate`, 'POST', { epoch, manifestHash: initial.manifestHash, manualResolutions });
    const active = await request(`${executorBase}/status`);
    if (active.status !== 'active' || active.epoch !== epoch || active.manifestHash !== initial.manifestHash) throw new Error('Executor has not confirmed the exact active migration');
    const acknowledged = await request(`${sourceBase}/ack`, 'POST', { epoch, manifestHash: initial.manifestHash });
    if (acknowledged.status !== 'active' || acknowledged.epoch !== epoch || acknowledged.manifestHash !== initial.manifestHash) throw new Error('Intake has not confirmed the exact active migration');
    return { status: 'active', integrationId, epoch, resolvedEvents: manualResolutions.length };
  }
  if (initial.status === 'active') {
    requireImported(initial, epoch);
    return { status: 'active', integrationId, epoch, alreadyActive: true };
  }
  if (!['unconfigured', 'importing'].includes(initial.status) || (initial.status === 'importing' && initial.epoch !== epoch)) throw new Error('Executor inventory conflicts with the requested migration');
  const prepared = await request(`${sourceBase}/prepare`, 'POST', { epoch });
  const { manifest, manifestHash } = prepared;
  if (!manifest || manifest.integrationId !== integrationId || manifest.epoch !== epoch || manifest.origin !== origin ||
      !manifestHashPattern.test(manifestHash ?? '') || !Array.isArray(manifest.tables) || manifest.tables.length > 32 ||
      manifest.tables.some(table => !/^[a-z_]{1,64}$/.test(table.name ?? '') || !Array.isArray(table.pages) || table.pages.length > 100_000 ||
        table.pages.some(page => !Number.isSafeInteger(page.offset) || page.offset < 0 || page.offset > 999999))) throw new Error('Source returned a migration for another target or invalid page inventory');
  if (initial.status === 'importing' && initial.manifestHash !== manifestHash) throw new Error('Executor already holds another migration manifest');
  await request(`${executorBase}/migration-manifest`, 'POST', manifest);
  let pages = 0;
  for (const table of manifest.tables) {
    for (const description of table.pages) {
      const query = new URLSearchParams({ epoch: String(epoch), table: table.name, offset: String(description.offset) });
      const page = await request(`${sourceBase}/page?${query}`);
      if (page.table !== table.name || page.offset !== description.offset || typeof page.nonce !== 'string' || typeof page.ciphertext !== 'string') throw new Error('Source page does not match its requested inventory position');
      await request(`${executorBase}/migration-page`, 'POST', { table: table.name, offset: description.offset, page: { nonce: page.nonce, ciphertext: page.ciphertext } });
      pages += 1;
      progress({ tables: manifest.tables.length, pages });
    }
  }
  const imported = await request(`${executorBase}/status`);
  requireImported(imported, epoch);
  if (imported.status !== 'importing' || imported.manifestHash !== manifestHash) throw new Error('Executor import inventory changed during page transfer');
  return { status: 'importing', integrationId, epoch, tables: manifest.tables.length, pages };
}

function requireImported(value, epoch) {
  if (!['importing', 'active'].includes(value?.status) || value.epoch !== epoch || !manifestHashPattern.test(value.manifestHash ?? '')) {
    throw new Error('Executor requires the exact imported migration before activation');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [action, integrationId, rawEpoch] = process.argv.slice(2);
  if (!/^[1-9][0-9]*$/.test(rawEpoch ?? '')) throw new Error('Migration epoch must be a positive integer');
  const pin = validateDeploymentPin(JSON.parse(readFileSync(new URL('./deployment-config.json', import.meta.url), 'utf8')));
  const environment = parseRuntimeEnvironment(process.env.EXECUTOR_RUNTIME_ENV);
  let manualResolutions;
  if (action === 'activate') {
    try { manualResolutions = JSON.parse(process.env.EXECUTOR_MANUAL_RESOLUTIONS ?? 'null'); }
    catch { throw new Error('Manual resolutions must be valid JSON'); }
  }
  const result = await migrateExecutor({ action, integrationId, epoch: Number(rawEpoch), origin: pin.origin,
    token: environment.EXECUTOR_SERVICE_TOKEN, manualResolutions,
    progress: counts => { if (counts.pages % 100 === 0) console.log(JSON.stringify({ event: 'executor.migration.progress', ...counts })); } });
  console.log(JSON.stringify({ event: 'executor.migration.complete', ...result }));
}
