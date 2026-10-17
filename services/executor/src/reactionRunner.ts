import { readFile, lstat } from "node:fs/promises";
import { BoundedParticipantRuntime } from "./participantRuntime";
import type { ReactionRequest } from "./reactionRuntime";

const maxInputBytes = 1_048_576;
const maxOutputBytes = 1_048_576;
const sourcePath = process.env.REACTION_SOURCE_PATH ?? "/reaction/source.ts";

async function main(): Promise<void> {
  const inputBytes = await readStdin(maxInputBytes);
  const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inputBytes)) as ReactionRequest;
  const sourceMetadata = await lstat(sourcePath);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink() || sourceMetadata.mode & 0o222 || sourceMetadata.size > maxInputBytes) {
    throw new TypeError("Reaction source must be a bounded read-only file");
  }
  const source = await readFile(sourcePath, "utf8");
  const operations = request.capabilities?.operations ?? [];
  const needsRusty = operations.includes("item-command");
  const needsCloudflare = operations.some(operation => operation.startsWith("clef."));
  if (needsRusty || needsCloudflare) await configureReactionRuntime();
  const directory = process.env.EXECUTOR_DATA_DIR ?? "/state";
  const origin = required("EXECUTOR_PUBLIC_ORIGIN");
  const automationOrigin = required("AUTOMATION_ORIGIN");
  const runtime = new BoundedParticipantRuntime(directory, origin, automationOrigin);
  try {
    const result = await runtime.call(request.participant.integrationId, {
      operation: "reaction", epoch: request.participant.epoch, body: { ...request, source },
    });
    writeOutput(result);
  } finally {
    await runtime.close();
  }
}

async function configureReactionRuntime(): Promise<void> {
  const path = process.env.REACTION_SECRET_PATH ?? "/run/secrets/reaction.json";
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.mode & 0o222 || metadata.size > maxInputBytes) {
    throw new TypeError("Reaction runtime configuration must be a bounded read-only file");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const expected = ["AUTOMATION_ORIGIN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "EVENT_STORAGE_SECRET",
    "EXECUTOR_PUBLIC_ORIGIN", "IDENTITY_STORAGE_SECRET", "INTEGRATIONS_JSON", "REACTION_RUSTY_ORIGINS"];
  if (Object.keys(value).sort().join("\0") !== expected.join("\0") || Object.values(value).some(item => typeof item !== "string")) {
    throw new TypeError("Reaction runtime configuration has an unsupported shape");
  }
  if (typeof value.CLOUDFLARE_ACCOUNT_ID !== "string" || !/^[a-f0-9]{32}$/.test(value.CLOUDFLARE_ACCOUNT_ID) ||
    typeof value.CLOUDFLARE_API_TOKEN !== "string" || value.CLOUDFLARE_API_TOKEN.length < 20 ||
    typeof value.IDENTITY_STORAGE_SECRET !== "string" || Buffer.byteLength(value.IDENTITY_STORAGE_SECRET, "utf8") < 32 ||
    typeof value.EVENT_STORAGE_SECRET !== "string" || Buffer.byteLength(value.EVENT_STORAGE_SECRET, "utf8") < 32) {
    throw new TypeError("Reaction runtime credentials are invalid");
  }
  const origins = JSON.parse(String(value.REACTION_RUSTY_ORIGINS)) as unknown;
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 16 || origins.some(origin => {
    if (typeof origin !== "string") return true;
    try { const url = new URL(origin); return url.protocol !== "https:" || url.origin !== origin || !!url.username || !!url.password; }
    catch { return true; }
  })) throw new TypeError("Reaction Rusty origins are invalid");
  const proxy = process.env.REACTION_RUSTY_PROXY;
  if (proxy !== "http://reaction-egress-proxy:3128") throw new Error("An enforcing reaction egress proxy is required");
  for (const [key, item] of Object.entries(value)) process.env[key] = item as string;
  process.env.NODE_USE_ENV_PROXY = "1";
  process.env.HTTPS_PROXY = proxy;
  process.env.HTTP_PROXY = proxy;
  process.env.https_proxy = proxy;
  process.env.http_proxy = proxy;
  process.env.NO_PROXY = "";
  process.env.no_proxy = "";
}

async function readStdin(maximum: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += bytes.byteLength;
    if (total > maximum) throw new TypeError("Reaction input exceeds its JSON bound");
    chunks.push(bytes);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function writeOutput(value: unknown): void {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > maxOutputBytes) throw new TypeError("Reaction output exceeds its JSON bound");
  process.stdout.write(`${json}\n`);
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main().catch(error => {
  writeOutput({ version: 1, status: "failed", commands: [], error: error instanceof Error ? error.message.slice(0, 2_000) : "reaction_failed" });
  process.exitCode = 1;
});
