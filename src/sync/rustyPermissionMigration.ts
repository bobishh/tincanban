const rustyPermissionMigrationCode = "rusty-device-access-update-required"

/** Missing permission evidence is an explicit owner decision, never a certificate-repair trigger. */
export class RustyPermissionMigrationRequiredError extends Error {
  readonly code = rustyPermissionMigrationCode
  constructor() {
    super("Update Rusty device access from a device already approved by this server. After this one-time update, your other approved devices can manage their connections independently.")
    this.name = "RustyPermissionMigrationRequiredError"
  }
}

export function requiresRustyPermissionMigration(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "code" in value && value.code === rustyPermissionMigrationCode)
}
