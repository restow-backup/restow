import { Link } from "@tanstack/react-router";
import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useTargetList } from "@/features/storage/use-storage";
import { activeTenantPageTo } from "@/lib/tenant-paths";

import { type ArchiveProtection, archiveProtectionOf } from "./presenters.js";

const ICON = {
  filesystem: ShieldAlert,
  s3_locked: ShieldCheck,
  s3_unlocked: ShieldAlert,
  s3_unknown: ShieldQuestion,
  unknown: ShieldQuestion,
} as const satisfies Record<ArchiveProtection, unknown>;

/**
 * How well the storage the archive writes to protects archived mail
 * (README, Known Issues): on a filesystem only the application does; on S3
 * with Object Lock the item records are locked but not the packs with the
 * message content. Said on the archive page itself, so nobody reads more
 * into "archive" than the storage gives.
 */
export function ArchiveProtectionNotice() {
  const { query } = useTargetList();
  if (query.isPending) {
    return null;
  }
  const protection = archiveProtectionOf(query.isError ? undefined : query.data);
  return <ArchiveProtectionView protection={protection} />;
}

/** The notice for a known protection state (split out for tests without a query client). */
export function ArchiveProtectionView({ protection }: { protection: ArchiveProtection }) {
  const { t } = useTranslation("archive");
  const Icon = ICON[protection];
  return (
    <Alert
      variant={protection === "s3_locked" ? "info" : "warning"}
      data-archive-protection={protection}
    >
      <Icon aria-hidden="true" />
      <AlertTitle>
        {t("protection.title")}: {t(`protection.${protection}.title`)}
      </AlertTitle>
      <AlertDescription>
        <p>{t(`protection.${protection}.description`)}</p>
        <Link
          to={activeTenantPageTo("storage")}
          className="font-medium text-primary underline underline-offset-4 hover:no-underline"
        >
          {t("protection.storageLink")}
        </Link>
      </AlertDescription>
    </Alert>
  );
}
