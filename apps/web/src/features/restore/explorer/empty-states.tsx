import { Link } from "@tanstack/react-router";
import { DatabaseBackup } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { directoryTo } from "@/features/directory/search";
import { restoresForTenant } from "@/lib/api";
import { useSession } from "@/lib/session";

/**
 * Whether the viewer can protect accounts (tenant or provider administrator).
 * A tenant user cannot: the protection pages are not theirs, so an empty
 * explorer tells them whom to ask instead of linking where they cannot go.
 */
export function useCanProtect(): boolean {
  const { isProviderAdmin, activeTenant } = useSession();
  return isProviderAdmin || activeTenant?.role === "tenant_admin";
}

/**
 * Whether the viewer sees every account of the tenant (restore operators and
 * administrators) rather than only their own.
 */
export function useSeesAllAccounts(): boolean {
  const { isProviderAdmin, activeTenant } = useSession();
  return isProviderAdmin || restoresForTenant(activeTenant?.role);
}

/**
 * No protected account at all. Admins are pointed at protecting one; a
 * restore operator learns the tenant has none yet; an end user that nothing
 * of theirs is.
 */
export function NoAccountsState({
  canProtect,
  seesAll = canProtect,
}: {
  canProtect: boolean;
  seesAll?: boolean;
}) {
  const { t } = useTranslation("restore");
  return (
    <EmptyState
      icon={DatabaseBackup}
      title={t(seesAll ? "explorer.object.none" : "explorer.object.noneSelf")}
      description={t(
        canProtect
          ? "explorer.object.noneDescription"
          : seesAll
            ? "explorer.object.noneRestoreDescription"
            : "explorer.object.noneSelfDescription",
      )}
      actions={
        canProtect ? (
          <Link to={directoryTo()} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {t("explorer.object.noneAction")}
          </Link>
        ) : undefined
      }
    />
  );
}

/** The chosen account has never been backed up. */
export function NoRestorePointState({ canProtect }: { canProtect: boolean }) {
  const { t } = useTranslation("restore");
  return (
    <EmptyState
      icon={DatabaseBackup}
      title={t("explorer.restorePoint.none")}
      description={t(
        canProtect
          ? "explorer.restorePoint.noneDescription"
          : "explorer.restorePoint.noneSelfDescription",
      )}
      actions={
        // The useful next step is to protect it, not to look at past restore
        // jobs (there is nothing here to restore from yet); only admins can.
        canProtect ? (
          <Link to={directoryTo()} className={buttonVariants({ variant: "outline", size: "sm" })}>
            {t("explorer.object.noneAction")}
          </Link>
        ) : undefined
      }
    />
  );
}
