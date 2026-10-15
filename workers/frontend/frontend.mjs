/** Static assets publish only after the release coordinator confirms compatible servers. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = { 'x-frontend-worker': 'tincanban', 'x-frontend-release': env.RELEASE_SHA ?? 'unknown' };
    const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
    const json = (body, status = 200) => Response.json(body, { status, headers: { ...headers, 'cache-control': 'no-store' } });
    let readers = null;
    try { readers = JSON.parse(env.RELEASE_READERS_JSON ?? 'null'); } catch { /* Unset local bindings remain explicitly unknown. */ }
    if (url.pathname === '/health') return json({ status: 'ready', buildSha: env.RELEASE_SHA ?? null,
      artifactSha256: digest(env.RELEASE_ARTIFACT_SHA256), cohortId: digest(env.RELEASE_COHORT_ID),
      sdkSha: env.RELEASE_SDK_SHA ?? null, versionId: env.CF_VERSION_METADATA?.id ?? null,
      readers, writerVersion: Number(env.RELEASE_WRITER_VERSION) || null });
    if (url.pathname === '/release-cohort.json') {
      let cohort;
      try { cohort = JSON.parse(env.RELEASE_COHORT_JSON ?? 'null'); } catch { /* Missing release metadata is not activation evidence. */ }
      if (cohort?.kind !== 'tincanban-release-cohort' || cohort.version !== 1 || !digest(cohort.cohortId)) {
        return json({ status: 'uncoordinated', message: 'Compatible release activation has not been confirmed.' }, 503);
      }
      return json({ ...cohort, frontendVersionId: env.CF_VERSION_METADATA?.id ?? null });
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
    let response = await env.ASSETS.fetch(request);
    if (response.status === 404 && !/\.[^/]+$/.test(url.pathname) && !/^\/(?:assets|mesh)\//.test(url.pathname)) {
      url.pathname = '/';
      response = await env.ASSETS.fetch(new Request(url, request));
    }
    const outputHeaders = new Headers(response.headers);
    for (const [name, value] of Object.entries(headers)) outputHeaders.set(name, value);
    outputHeaders.set('x-content-type-options', 'nosniff');
    outputHeaders.set('referrer-policy', 'strict-origin-when-cross-origin');
    if (outputHeaders.get('content-type')?.includes('text/html') || url.pathname === '/release.json') outputHeaders.set('cache-control', 'private, no-store');
    return new Response(response.body, { status: response.status, headers: outputHeaders });
  },
};
