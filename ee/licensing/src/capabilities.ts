/**
 * Capabilities: the single place that decides which Business or Service
 * Provider feature an edition includes. `hasCapability()` is what the ee/
 * modules call (through ./store.ts for the edition in effect) to decide
 * whether their routes answer, a worker task runs, a nav entry is unlocked or
 * a core feature gate opens. Adding an ee/ feature means adding one entry to
 * {@link CAPABILITY_MIN_EDITION}, not touching call sites. The core knows
 * none of these names.
 */

import type { LicenseEdition } from "./editions.js";

/** Capabilities that only exist from a given edition upward. */
export const CAPABILITIES = [
  /** Archive legal holds (Business+): suspend retention/deletion on demand. */
  "archive.legalHold",
  /** SMTP journal receiver for Exchange Online journaling (Business+). */
  "archive.journalReceiver",
  /** Enforced archive retention deletion runs (Business+). */
  "archive.retentionEnforcement",
  /** Cross-tenant provider API keys and `/provider/*` endpoints (Service Provider). */
  "provider.crossTenantApi",
  /** Tenant management beyond the installation's first tenant: creating further tenants (Service Provider). */
  "provider.tenantManagement",
  /** Per-tenant reporting rolled up across every tenant (Service Provider). */
  "provider.tenantReporting",
  /** The provider team: several admins with roles and tenant scopes (Business+). */
  "provider.team",
  /** Microsoft/Entra end-user sign-in, i.e. SSO login (Business+). Graph as a
   *  backup source with admin consent is Community and unaffected by this. */
  "auth.microsoftSso",
  /** Time-triggered summary reports (Business+). Event alerts are in every edition. */
  "reports.scheduled",
  /** The audit log viewer: search, entry details and chain verification
   *  (Business+). Recording every read and restore stays in every edition. */
  "audit.log",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const EDITION_RANK: Readonly<Record<LicenseEdition, number>> = {
  community: 0,
  business: 1,
  service_provider: 2,
};

/** The smallest edition each capability is available from. */
export const CAPABILITY_MIN_EDITION: Readonly<Record<Capability, LicenseEdition>> = {
  "archive.legalHold": "business",
  "archive.journalReceiver": "business",
  "archive.retentionEnforcement": "business",
  "provider.crossTenantApi": "service_provider",
  "provider.tenantManagement": "service_provider",
  "provider.tenantReporting": "service_provider",
  "provider.team": "business",
  "auth.microsoftSso": "business",
  "reports.scheduled": "business",
  "audit.log": "business",
};

/** Whether `edition` includes `capability`. Editions are cumulative: a later
 *  edition includes every capability of the ones below it. */
export function hasCapability(edition: LicenseEdition, capability: Capability): boolean {
  return EDITION_RANK[edition] >= EDITION_RANK[CAPABILITY_MIN_EDITION[capability]];
}

/** The smallest edition offering `capability`, for error messages and nav locks. */
export function minEditionFor(capability: Capability): LicenseEdition {
  return CAPABILITY_MIN_EDITION[capability];
}
