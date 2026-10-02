import { installationSectionPath } from "@/features/installation/paths";
import type { NavLock } from "@/lib/navigation";

import { type LicensedEdition, editionAllows, readEdition } from "./edition";

/** Id of the license section of the installation page (`/installation/license`). */
export const LICENSE_SECTION_ID = "license";

/**
 * A lock (lib/navigation.ts `NavLock`) for a feature of `minimum` and up, on a
 * menu entry or a section of the installation page: locked while the
 * session's edition is unknown or below it. A locked entry leads to
 * Installation, License, which names the edition that unlocks it
 * (`?requires=`) and takes the key.
 */
export function editionLock(minimum: LicensedEdition): NavLock {
  return {
    isLocked: (context) => !editionAllows(readEdition(context.extensions), minimum),
    to: installationSectionPath(LICENSE_SECTION_ID),
    search: { requires: minimum },
    hintKey: `license:locked.${minimum}`,
  };
}
