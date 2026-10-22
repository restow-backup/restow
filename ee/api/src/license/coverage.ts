import type { UpdateCoverageLoader } from "../../../../apps/api/src/features/updates/coverage.js";
import {
  effectiveLicenseOf,
  isKeyedEdition,
  loadInstalledLicense,
  updateEntitlement,
  updateTermsOf,
} from "../../../licensing/src/index.js";

/**
 * The core's update coverage hook (apps/api features/updates/coverage.ts): the
 * releases the installed Business or Service Provider key covers, by the same
 * rule the start check of a release applies (ee/licensing entitlement.ts). No
 * key, or a release already running as Community (RESTOW_RUN_AS_COMMUNITY):
 * nothing restricts which release installs.
 */
export const licenseUpdateCoverage: UpdateCoverageLoader = async (db) => {
  const installed = await loadInstalledLicense(db);
  if (!installed || !isKeyedEdition(installed.edition)) {
    return null;
  }
  if (effectiveLicenseOf(installed).runAsCommunity) {
    return null;
  }
  const terms = updateTermsOf(installed);
  const sample = updateEntitlement(terms, { version: null, releasedAt: null });
  return {
    coveredUntil: sample.coveredUntil,
    series: sample.series,
    covers: (release) => updateEntitlement(terms, release).entitled,
  };
};
