import { Link } from "@tanstack/react-router";
import { ExternalLink, Info, Mail } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CopyButton, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import "@/features/archive/i18n";
import { ARCHIVE_PATH } from "@/features/archive/paths";
import type { SlotProps } from "@/lib/extensions";

import { useJournalScope, useJournalSetup } from "./hooks";
import { STATUS_TONE } from "./presenters";

/**
 * The archive section of a mail job's editor (slot `jobs.archiveSetup`, #32):
 * while the job archives, the tenant's journal address and whether reports
 * arrive, with the way to the full guide on the archive page. Journaling is
 * set up once per tenant (one address, one journal rule); the job only says
 * which mailboxes are expected in the archive. Without the Business edition
 * it says that nothing is captured.
 */
export function JobArchiveSetup({ archive }: SlotProps["jobs.archiveSetup"]) {
  const { t } = useTranslation("archive");
  const { enabled, canManage, licensed } = useJournalScope();
  const setup = useJournalSetup();

  if (!archive) {
    return null;
  }
  if (!licensed) {
    return (
      <Alert data-slot="archive-edition">
        <Info aria-hidden="true" />
        <AlertDescription>{t("journal.job.edition")}</AlertDescription>
      </Alert>
    );
  }
  if (!enabled || !canManage) {
    return null;
  }

  return (
    <div className="space-y-3 rounded-md border p-3" data-slot="job-journal-setup">
      <div className="space-y-0.5">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Mail aria-hidden="true" className="size-4" />
          {t("journal.job.title")}
        </p>
        <p className="text-muted-foreground text-xs">{t("journal.job.description")}</p>
      </div>
      {setup.data ? (
        <>
          <StatusBadge
            tone={STATUS_TONE[setup.data.status]}
            icon
            live={setup.data.status === "receiving"}
          >
            {t(`journal.status.${setup.data.status}`)}
          </StatusBadge>
          {setup.data.address ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="bg-muted/40 min-w-0 flex-1 basis-full select-all break-all rounded-md border px-3 py-2 font-mono text-xs sm:basis-0">
                {setup.data.address}
              </code>
              <CopyButton
                value={setup.data.address}
                label={t("journal.address.copy")}
                variant="outline"
              />
            </div>
          ) : null}
        </>
      ) : setup.isPending ? (
        <Skeleton className="h-9 w-full" aria-busy="true" />
      ) : null}
      <Link
        to={ARCHIVE_PATH}
        className={buttonVariants({ variant: "outline", size: "sm" })}
        data-slot="journal-guide"
      >
        <ExternalLink aria-hidden="true" />
        {t("journal.job.guide")}
      </Link>
    </div>
  );
}
