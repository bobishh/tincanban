import type { WorkerEnv } from "./index";
import { authorizeInternalRequest } from "./executorClient";
import { json, readJson } from "./http";

const maximumBodyBytes = 24 * 1024;
const integrationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const manifestHashPattern = /^[A-Za-z0-9_-]{43}$/;

/** Private page transport and cutover acknowledgement for the standalone executor. */
export async function handleExecutorMigrationApi(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/internal\/executor-migrations\/([A-Za-z0-9_-]{1,128})\/(prepare|page|ack)$/);
  if (!match) return json({ error: "Migration route not found" }, 404);
  if (!authorizeInternalRequest(request, env.EXECUTOR_SERVICE_TOKEN)) return json({ error: "Unauthorized" }, 401);

  const integrationId = match[1]!;
  if (!integrationIdPattern.test(integrationId)) return json({ error: "Invalid integration ID" }, 400);
  const coordinator = env.AUTOMATION.getByName(integrationId);

  try {
    if (match[2] === "prepare") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const input = await readJson(request, maximumBodyBytes);
      exactKeys(input, ["epoch"]);
      const epoch = positiveEpoch(input.epoch);
      const manifest = await coordinator.prepareExecutorMigration(epoch);
      const manifestHash = await coordinator.executorMigrationManifestHash();
      return json({ manifest, manifestHash });
    }

    if (match[2] === "page") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const epoch = positiveEpoch(Number(url.searchParams.get("epoch")));
      const table = url.searchParams.get("table") ?? "";
      if (!/^[a-z_]{1,64}$/.test(table)) throw new TypeError("Migration table is invalid");
      const rawOffset = url.searchParams.get("offset");
      if (!rawOffset || !/^(0|[1-9][0-9]{0,5})$/.test(rawOffset)) throw new TypeError("Migration page offset is invalid");
      const page = await coordinator.readExecutorMigrationPage(epoch, table, Number(rawOffset));
      return json(page);
    }

    if (request.method !== "POST") return methodNotAllowed("POST");
    const input = await readJson(request, maximumBodyBytes);
    exactKeys(input, ["epoch", "manifestHash"]);
    const epoch = positiveEpoch(input.epoch);
    if (typeof input.manifestHash !== "string" || !manifestHashPattern.test(input.manifestHash)) throw new TypeError("Migration manifest hash is invalid");
    await coordinator.acknowledgeExecutorMigration(epoch, input.manifestHash);
    return json({ status: "active", epoch, manifestHash: input.manifestHash });
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) return json({ error: error.message || "Invalid migration request" }, 400);
    if (error instanceof Error && /does not match|already owns|changed|unavailable for this epoch/.test(error.message)) return json({ error: error.message }, 409);
    return json({ error: error instanceof Error ? error.message : "Executor migration failed" }, 503);
  }
}

function positiveEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError("Migration epoch is invalid");
  return value as number;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) throw new TypeError("Migration request contains unsupported fields");
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "Method not allowed" }, 405, new Headers({ allow }));
}
