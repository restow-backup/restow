import { RequireRole } from "@/components/require-role";

import { WarningsPage } from "./pages/warnings-page";
import { WARNINGS_ROLES } from "./presenters";

/**
 * Warnings are an operator view: the tenant's administrators and the provider's admins (whose
 * team role decides whether they may acknowledge, see presenters.ts). A direct link for anyone
 * else shows the standard "not permitted" notice instead of a failing request.
 */
export function WarningsRoute({ state }: { state: "open" | "acknowledged" }) {
  return (
    <RequireRole roles={WARNINGS_ROLES}>
      {/* Keyed by the tab, so a new tab starts without a selection. */}
      <WarningsPage key={state} state={state} />
    </RequireRole>
  );
}
