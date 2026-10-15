import { test } from "node:test";
import assert from "node:assert/strict";
import { workerReleaseIdentity } from "../src/buildIdentity.ts";

test("Given immutable upload bindings, when reporting health, then distinguish artifact, provider version and source", () => {
  const value = workerReleaseIdentity({ RELEASE_SHA: "a".repeat(40), RELEASE_ARTIFACT_SHA256: "b".repeat(64),
    RELEASE_COHORT_ID: "c".repeat(64), RELEASE_SDK_SHA: "d".repeat(40), CF_VERSION_METADATA: { id: "version-uuid" } });
  assert.equal(value.artifactSha256, "b".repeat(64));
  assert.equal(value.versionId, "version-uuid");
  assert.equal(value.buildSha, "a".repeat(40));
  assert.equal(workerReleaseIdentity({ RELEASE_SHA: "a".repeat(40) }).artifactSha256, null);
});
