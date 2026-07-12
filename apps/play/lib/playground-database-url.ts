/** Exposed for preview logs: `file:./wildwood.db` is relative to the Next process cwd. */
export function playgroundDatabaseUrl(): string {
  return process.env.TURSO_DATABASE_URL || "file:./wildwood.db";
}
