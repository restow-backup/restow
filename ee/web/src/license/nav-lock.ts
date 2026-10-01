import { SETTINGS_PATH } from "@/features/settings/paths";
import type { NavLock } from "@/lib/navigation";

import { type LicensedEdition, editionAllows, readEdition } from "./edition";

/**
 * A menu lock (lib/navigation.ts `NavLock`) for a feature of `minimum` and
 * up: locked while the session's edition is unknown or below it. A locked
 * entry leads to Settings, About, where the license slot names the edition
 * that unlocks it (`?requires=`) and takes the key.
 */
export function editionLock(minimum: LicensedEdition): NavLock {
  return {
    isLocked: (context) => !editionAllows(readEdition(context.extensions), minimum),
    to: SETTINGS_PATH,
    search: { section: "about", requires: minimum },
    hintKey: `license:locked.${minimum}`,
  };
}
