/**
 * API key scopes (docs/ARCHITECTURE.md, "API"). A key carries an
 * explicit list; nothing implies anything else, so what an operator ticked in
 * the UI is exactly what the key can do.
 */

export const API_SCOPES = [
  "status:read",
  "jobs:read",
  "items:read",
  "users:read",
  "archive:read",
  "restore:write",
  "verify:write",
  "users:write",
  "webhooks:manage",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/**
 * Keep only known scopes, without duplicates, in the canonical order. Stored
 * rows may carry scopes a newer or older release defined; unknown ones grant
 * nothing.
 */
export function normalizeScopes(values: readonly string[]): ApiScope[] {
  const granted = new Set(values);
  return API_SCOPES.filter((scope) => granted.has(scope));
}

/** True when `scopes` grants `required`. */
export function hasScope(scopes: readonly ApiScope[], required: ApiScope): boolean {
  return scopes.includes(required);
}
