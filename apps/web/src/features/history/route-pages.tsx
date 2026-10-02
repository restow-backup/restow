import { useNavigate, useSearch } from "@tanstack/react-router";

import { RequireRole } from "@/components/require-role";
import { HISTORY_PATH } from "@/features/jobs/paths";

import type { HistoryFilters } from "./api";
import { HistoryPage } from "./pages/history-page";
import { RunDetailPage } from "./pages/run-detail-page";
import { historySearchOf, parseHistorySearch } from "./presenters";

/**
 * History is for the tenant's administrators and the provider's admins; end users follow their
 * own restores in the restore feature. The sidebar hides the entry for everyone else, and a
 * direct link shows the standard "not permitted" notice instead of a failing request.
 */
export const HISTORY_ROLES = ["provider_admin", "tenant_admin"] as const;

/** The list: the tab and the job filter come from the address, and so does the open run. */
export function HistoryRoute() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const { type, job } = parseHistorySearch(raw);
  const navigate = useNavigate();
  const onFilters = (next: HistoryFilters) =>
    void navigate({
      to: HISTORY_PATH as never,
      // A new filter closes the drawer: it belongs to the list it was opened on.
      search: historySearchOf({ type: next.type, job: next.job }) as never,
    });
  return (
    <RequireRole roles={HISTORY_ROLES}>
      <HistoryPage filters={{ type, job }} onFilters={onFilters} />
    </RequireRole>
  );
}

export function RunDetailRoute({ runId }: { runId: string }) {
  return (
    <RequireRole roles={HISTORY_ROLES}>
      {/* Keyed by id so moving from a run to its retry starts from a clean page. */}
      <RunDetailPage key={runId} runId={runId} />
    </RequireRole>
  );
}
