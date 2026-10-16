import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { createExecutorHandler, type ExecutorArtifact, type ExecutorHttpConfig } from "./httpApi";
import { BoundedParticipantRuntime } from "./participantRuntime";

process.umask(0o077);
const origin = checkedOrigin(process.env.EXECUTOR_PUBLIC_ORIGIN, "EXECUTOR_PUBLIC_ORIGIN");
const automationOrigin = checkedOrigin(process.env.AUTOMATION_ORIGIN, "AUTOMATION_ORIGIN");
const artifactPath = process.env.EXECUTOR_ARTIFACT_PATH ?? new URL("./artifact.json", import.meta.url).pathname;
const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as ExecutorArtifact;
const digest = createHash("sha256");
for (const name of ["main.mjs", "participantWorker.mjs"]) digest.update(name + "\0").update(await readFile(join(dirname(artifactPath), name))).update("\0");
if (artifact.component !== "tincanban-executor" || digest.digest("hex") !== artifact.artifactSha256) throw new Error("Executor artifact identity does not match executable bytes");
for (const name of ["EXECUTOR_SERVICE_TOKEN", "EXECUTOR_MIGRATION_SECRET", "CLASSIFICATION_SERVICE_TOKEN", "IDENTITY_STORAGE_SECRET", "EVENT_STORAGE_SECRET"]) {
  if (!process.env[name] || process.env[name]!.length < 32) throw new Error(`${name} must be configured before executor startup`);
}
const producers = JSON.parse(process.env.EXECUTOR_PRODUCERS_JSON ?? "[]") as ExecutorHttpConfig["producers"];
if (!Array.isArray(producers) || !producers.length || producers.length > 16 || producers.some(producer =>
  typeof producer.token !== "string" || producer.token.length < 32 || !Array.isArray(producer.integrationIds) || !producer.integrationIds.length ||
  producer.integrationIds.length > 64 || producer.integrationIds.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id)))) throw new Error("Executor producer scopes must be configured");
const runtime = new BoundedParticipantRuntime(process.env.EXECUTOR_DATA_DIR ?? "/data", origin, automationOrigin);
const handle = createExecutorHandler(runtime, { serviceToken: process.env.EXECUTOR_SERVICE_TOKEN!, producers }, artifact);
const port = Number(process.env.PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid executor port");
const server = createServer(async (incoming, outgoing) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    const method = incoming.method ?? "GET";
    const request = new Request(`${origin}${incoming.url ?? "/"}`, { method, headers,
      ...(["GET", "HEAD"].includes(method) ? {} : { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" as const }) });
    const response = await handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(JSON.stringify({ event: "executor.http.failed", error: error instanceof Error ? error.message : String(error) }));
    if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: "Executor HTTP request failed" }));
  }
});
server.requestTimeout = 180_000; server.headersTimeout = 15_000;
server.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ event: "executor.ready", ...artifact })));
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
  server.close(() => { void runtime.close().then(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 170_000).unref();
});

function checkedOrigin(value: string | undefined, name: string): string {
  const parsed = new URL(value ?? "");
  if (parsed.protocol !== "https:" || parsed.origin !== value) throw new Error(`${name} must be an exact HTTPS origin`);
  return parsed.origin;
}
