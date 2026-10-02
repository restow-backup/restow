import { type WordingScope, wordingScope } from "@/features/installation/presenters";
import { hasFeature, useSession } from "@/lib/session";

/**
 * The scope the installation pages speak of: "all tenants" where the
 * installation manages tenants, "your organisation" where it has the one
 * (clarity rule 4). The same switch the menu makes for its Organisation
 * section (`lib/navigation.ts` `navGroupLabelKey`).
 */
export function useWordingScope(): WordingScope {
  const session = useSession();
  return wordingScope(hasFeature(session, "tenants.additional"));
}
