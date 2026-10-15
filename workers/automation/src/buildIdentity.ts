import supported from "../../../release/readers.json" with { type: "json" };

/** Return only an immutable source revision supplied by the deployment build. */
export function workerBuildSha(value: string | undefined): string | null {
  return value && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : null
}

export type WorkerReleaseBindings = {
  RELEASE_SHA?: string;
  RELEASE_ARTIFACT_SHA256?: string;
  RELEASE_COHORT_ID?: string;
  RELEASE_SDK_SHA?: string;
  CF_VERSION_METADATA?: { id: string };
};

export function workerReleaseIdentity(env: WorkerReleaseBindings) {
  const digest = (value: string | undefined) => value && /^[a-f0-9]{64}$/.test(value) ? value : null;
  return { buildSha: workerBuildSha(env.RELEASE_SHA), artifactSha256: digest(env.RELEASE_ARTIFACT_SHA256),
    cohortId: digest(env.RELEASE_COHORT_ID), sdkSha: workerBuildSha(env.RELEASE_SDK_SHA),
    versionId: env.CF_VERSION_METADATA?.id ?? null,
    readers: supported.automation, writerVersion: supported.writerVersions.automation };
}
