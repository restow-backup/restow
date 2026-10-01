import { type Database, license } from "@restow/db";
import { eq } from "drizzle-orm";
import type { KeyedEdition } from "../../../licensing/src/index.js";

/**
 * Test support for the Postgres suites of ee/: make an edition the one in
 * effect by writing the active `license` row directly, as an installed and
 * verified key would leave it (./service.ts `installLicense` covers the real
 * path with a signed key). Never imported by product code.
 */
export async function installTestLicense(db: Database, edition: KeyedEdition): Promise<void> {
  await db.update(license).set({ active: false }).where(eq(license.active, true));
  await db.insert(license).values({
    edition,
    multiTenant: edition === "service_provider",
    licensee: "Test GmbH",
    installationId: "00000000-0000-4000-8000-000000000000",
    signature: null,
    issuedAt: new Date(),
    active: true,
  });
}

/** Back to the edition without a key (Community outside demo mode). */
export async function removeTestLicense(db: Database): Promise<void> {
  await db.update(license).set({ active: false }).where(eq(license.active, true));
}
