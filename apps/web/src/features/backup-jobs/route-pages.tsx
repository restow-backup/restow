import { useNavigate, useParams, useSearch } from "@tanstack/react-router";

import { RequireRole } from "@/components/require-role";

import type { JobKind } from "./api.js";
import { JobDetailPage } from "./pages/job-detail-page.js";
import { JobsPage } from "./pages/jobs-page.js";
import {
  JOBS_PATH,
  type JobTab,
  jobDefinitionPath,
  jobDefinitionTo,
  newJobTo,
  parseJobDetailSearch,
  parseJobsSearch,
} from "./paths.js";

/**
 * Jobs are for the tenant's administrators and the provider's admins; end users
 * follow their own restores in the restore feature. The sidebar hides the entries
 * for everyone else, and a direct link shows the standard "not permitted" notice
 * instead of a failing request.
 */
export const JOB_ROLES = ["provider_admin", "tenant_admin"] as const;

/** The jobs of the kind the address names; the editor follows `new` and `select` in the address. */
export function JobsRoute() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const { type, create, select } = parseJobsSearch(raw);
  const navigate = useNavigate();
  if (type === null) {
    // The route's guard leads such an address to History before this renders.
    return null;
  }
  const to = (search: Record<string, unknown>, replace = false) =>
    void navigate({ to: JOBS_PATH as never, search: search as never, replace });
  return (
    <RequireRole roles={JOB_ROLES}>
      {/* Keyed by kind so the two lists never share an open editor. */}
      <JobsPage
        key={type}
        kind={type}
        creating={create}
        select={select}
        onCreate={() => to(newJobTo(type).search)}
        onCreateClosed={() => to({ type }, true)}
        onOpenJob={(job) => {
          const target = jobDefinitionTo(job.id, job.kind);
          void navigate({ to: target.to as never, search: target.search as never });
        }}
      />
    </RequireRole>
  );
}

/** One job: the id comes from the path, the kind and the tab from the search. */
export function JobDetailRoute() {
  const { jobId } = useParams({ strict: false }) as { jobId?: string };
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const { type, tab } = parseJobDetailSearch(raw);
  const navigate = useNavigate();
  if (!jobId) {
    return null;
  }
  const go = (kind: JobKind | null, next: JobTab) =>
    void navigate({
      to: jobDefinitionPath(jobId) as never,
      search: {
        ...(kind ? { type: kind } : {}),
        // The overview is the default and stays out of the address.
        ...(next === "overview" ? {} : { tab: next }),
      } as never,
      replace: true,
    });
  return (
    <RequireRole roles={JOB_ROLES}>
      {/* Keyed by id so moving to another job starts from a clean state. */}
      <JobDetailPage
        key={jobId}
        jobId={jobId}
        type={type}
        tab={tab}
        onTabChange={(next) => go(type, next)}
        onKindKnown={(kind) => go(kind, tab)}
        onDeleted={(kind) => {
          void navigate({ to: JOBS_PATH as never, search: { type: kind } as never });
        }}
      />
    </RequireRole>
  );
}
