export type AutomationScope = {
  version: 1;
  boardId: string;
  columns: { lead: string; applied?: string; interview: string; rejected: string };
  fieldIds: { company: string; role: string; jobUrl: string; notes?: string; sourceText?: string; roleType?: string; seniority?: string };
  expiresAt: string;
};

export type AutomationIntegration = {
  id: string;
  workspaceId: string;
  scope: AutomationScope;
  emailAddress?: string;
  allowedForwarders: string[];
};

const allowedIntegrationId = /^[A-Za-z0-9_-]{1,128}$/;

export function parseIntegrations(env: { INTEGRATIONS_JSON: string }): AutomationIntegration[] {
  let value: unknown;
  try {
    value = JSON.parse(env.INTEGRATIONS_JSON || "[]") as unknown;
  } catch {
    throw new Error("Integration configuration is invalid");
  }
  if (!Array.isArray(value)) throw new Error("Integration configuration must be a list");
  const ids = new Set<string>();
  const emailAddresses = new Set<string>();
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Invalid integration configuration");
    const input = candidate as Record<string, unknown>;
    const id = requiredString(input.id, "integration.id", 128);
    const workspaceId = requiredString(input.workspaceId, "integration.workspaceId", 128);
    if (!allowedIntegrationId.test(id) || ids.has(id)) throw new Error("Integration IDs must be unique and URL-safe");
    ids.add(id);
    const scope = parseScope(input.scope);
    const allowedForwarders = parseEmailList(input.allowedForwarders, "allowedForwarders");
    const emailAddress = input.emailAddress === undefined ? undefined : normalizeEmail(requiredString(input.emailAddress, "emailAddress", 320));
    if (emailAddress && emailAddresses.has(emailAddress)) throw new Error("Email routing addresses must be unique");
    if (emailAddress) emailAddresses.add(emailAddress);
    return { id, workspaceId, scope, allowedForwarders, ...(emailAddress ? { emailAddress } : {}) };
  });
}

function parseScope(value: unknown): AutomationScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Integration scope is missing");
  const input = value as Record<string, unknown>;
  if (input.version !== 1) throw new Error("Unsupported integration scope version");
  const columns = input.columns as Record<string, unknown> | undefined;
  const fields = input.fieldIds as Record<string, unknown> | undefined;
  if (!columns || typeof columns !== "object" || !fields || typeof fields !== "object") throw new Error("Integration scope bindings are invalid");
  const expiresAt = requiredString(input.expiresAt, "scope.expiresAt", 64);
  if (!Number.isFinite(Date.parse(expiresAt))) throw new Error("Integration scope expiry is invalid");
  const scope: AutomationScope = {
    version: 1,
    boardId: requiredString(input.boardId, "scope.boardId", 128),
    columns: {
      ...(columns.applied === undefined ? {} : { applied: requiredString(columns.applied, "scope.columns.applied", 128) }),
      lead: requiredString(columns.lead, "scope.columns.lead", 128),
      interview: requiredString(columns.interview, "scope.columns.interview", 128),
      rejected: requiredString(columns.rejected, "scope.columns.rejected", 128),
    },
    fieldIds: {
      company: requiredString(fields.company, "scope.fieldIds.company", 128),
      role: requiredString(fields.role, "scope.fieldIds.role", 128),
      jobUrl: requiredString(fields.jobUrl, "scope.fieldIds.jobUrl", 128),
      ...(optionalField(fields.notes, "scope.fieldIds.notes")),
      ...(optionalField(fields.sourceText, "scope.fieldIds.sourceText")),
      ...(optionalField(fields.roleType, "scope.fieldIds.roleType")),
      ...(optionalField(fields.seniority, "scope.fieldIds.seniority")),
    },
    expiresAt,
  };
  const bindings = [scope.boardId, ...Object.values(scope.columns), ...Object.values(scope.fieldIds).filter((value): value is string => !!value)];
  if (new Set(bindings).size !== bindings.length) throw new Error("Integration scope bindings must be distinct");
  return scope;
}

function optionalField(value: unknown, name: string): { [key: string]: string } {
  return value === undefined ? {} : { [name.split(".").at(-1)!]: requiredString(value, name, 128) };
}

export function normalizeEmail(value: string): string {
  const match = value.trim().match(/^(?:[^<>]*<)?([^<>\s]+@[^<>\s]+)>?$/);
  const address = (match?.[1] ?? "").toLocaleLowerCase("en-US");
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) throw new TypeError("Email address is invalid");
  return address;
}

function parseEmailList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${name} must contain at most 20 addresses`);
  return [...new Set(value.map((item) => normalizeEmail(requiredString(item, name, 320))))];
}


export function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be text`);
  const normalized = value.trim();
  if (!normalized || new TextEncoder().encode(normalized).byteLength > maxLength) throw new TypeError(`${name} is invalid`);
  return normalized;
}

