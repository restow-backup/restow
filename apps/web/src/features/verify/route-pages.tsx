import { RequireRole } from "@/components/require-role";
import { ReportPage } from "@/features/verify/report-page";
import { VerifyPage } from "@/features/verify/verify-page";

/**
 * Readiness is an operator view: tenant admins and provider admins. The
 * sidebar hides it for everyone else, and a direct link shows the standard
 * "not permitted" notice instead of a failing request.
 */
export const VERIFY_ROLES = ["provider_admin", "tenant_admin"] as const;

export function VerifyRoutePage() {
  return (
    <RequireRole roles={VERIFY_ROLES}>
      <VerifyPage />
    </RequireRole>
  );
}

export function VerifyReportRoutePage({ reportId }: { reportId: string }) {
  return (
    <RequireRole roles={VERIFY_ROLES}>
      {/* Keyed by id so moving between reports starts from a clean state. */}
      <ReportPage key={reportId} reportId={reportId} />
    </RequireRole>
  );
}
