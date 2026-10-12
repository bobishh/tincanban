import type { WorkerEnv } from "./index";

export type PrivateEmailRoute = { id: string; address: string; mailbox: string };

/** Recipient is a bearer capability: keep it in a Worker secret and the forwarding mailbox only. */
export function privateEmailRoutes(env: Pick<WorkerEnv, "EMAIL_ROUTES_JSON">): PrivateEmailRoute[] {
  const values: unknown = JSON.parse(env.EMAIL_ROUTES_JSON || "[]");
  if (!Array.isArray(values) || values.length > 20) throw new Error("Invalid private email routes");
  const addresses = new Set<string>();
  return values.map(value => {
    if (!value || typeof value !== "object") throw new Error("Invalid private email route");
    const { id, address, mailbox } = value as Record<string, unknown>;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
      typeof address !== "string" || !/^jobs-[a-f0-9]{32,48}@[^\s@<>]+\.[^\s@<>]+$/.test(address) ||
      typeof mailbox !== "string" || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(mailbox) || addresses.has(address)) {
      throw new Error("Invalid private email route");
    }
    addresses.add(address);
    return { id, address, mailbox };
  });
}
