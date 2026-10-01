import { apiFetch } from "@/lib/api";

import type { LicenseState } from "./types";

/**
 * Typed calls against `/api/v1/license` (served by ee/api, provider admins
 * only). The license is installation-wide, so no tenant header is sent.
 */

export const LICENSE_API_PATH = "/license";

export const licenseKeys = {
  state: ["license", "state"] as const,
};

export function fetchLicenseState(): Promise<LicenseState> {
  return apiFetch<LicenseState>(LICENSE_API_PATH, { tenantId: null });
}

export function installLicenseKey(key: string): Promise<LicenseState> {
  return apiFetch<LicenseState>(LICENSE_API_PATH, {
    method: "POST",
    body: { key },
    tenantId: null,
  });
}

export function removeLicenseKey(): Promise<LicenseState> {
  return apiFetch<LicenseState>(LICENSE_API_PATH, { method: "DELETE", tenantId: null });
}
