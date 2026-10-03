import { providerDb } from "../../../../apps/api/src/db.js";
import type { BackgroundService } from "../../../../apps/api/src/extensions.js";
import { applyPendingLicenseKey } from "./service.js";

/**
 * At start of the full build: install a license key that was entered on the Community
 * build before the switch (apps/api/src/lib/pending-license-key.ts), so the edition is in
 * effect at once. It is verified like any key; nothing long-lived is started.
 */
export const pendingLicenseKeyService: BackgroundService = {
  name: "license-pending-key",
  async start() {
    try {
      const outcome = await applyPendingLicenseKey(providerDb);
      if (outcome !== "none") {
        console.log(
          JSON.stringify({
            level: outcome === "installed" ? "info" : "warn",
            component: "license",
            message: `license key entered on the Community build: ${outcome}`,
          }),
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          component: "license",
          message: "the license key entered on the Community build could not be applied",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return null;
  },
};
