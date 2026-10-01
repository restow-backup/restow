import { RequireRole } from "@/components/require-role";
import { BackupPage } from "@/features/jobs/pages/backup-page";
import { JobDetailPage } from "@/features/jobs/pages/job-detail-page";
import { JobsPage } from "@/features/jobs/pages/jobs-page";

/**
 * The route entries of the feature. These are operator pages: tenant admins
 * and provider admins; end users follow their own restores in the restore
 * feature. The sidebar hides the entries for everyone else, and a direct link
 * shows the standard "not permitted" notice instead of a failing request.
 */
export const OPERATOR_ROLES = ["provider_admin", "tenant_admin"] as const;

export function BackupRoutePage() {
  return (
    <RequireRole roles={OPERATOR_ROLES}>
      <BackupPage />
    </RequireRole>
  );
}

export function JobsRoutePage() {
  return (
    <RequireRole roles={OPERATOR_ROLES}>
      <JobsPage />
    </RequireRole>
  );
}

export function JobDetailRoutePage({ jobId }: { jobId: string }) {
  return (
    <RequireRole roles={OPERATOR_ROLES}>
      {/* Keyed by id so moving from a job to its retry starts from a clean state. */}
      <JobDetailPage key={jobId} jobId={jobId} />
    </RequireRole>
  );
}
