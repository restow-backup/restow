import { Link } from "@tanstack/react-router";
import { ArrowRight, Hourglass, Mail } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useArchiveRetention } from "@/features/archive/hooks";
import { ARCHIVE_PATH } from "@/features/archive/paths";
import { useWordingScope } from "@/features/installation/scope";
import { ExtensionSlot, type TenantSectionProps } from "@/lib/extensions";

/**
 * Archive, as settings: how long archived mail is kept, and what the Business
 * modules add (legal holds, through the slot `tenant.archiveSettings`). The
 * journal address, its rotation and the Exchange Online guide are not settings
 * of the tenant: they belong to the daily Archive page (Mail & SaaS, Archive),
 * where this section points; so does the archive itself, the search and the
 * proof of the hash chain.
 */
export function ArchiveSection({ readOnly }: TenantSectionProps) {
  const { t } = useTranslation("tenantpage");
  return (
    <div className="space-y-6">
      <RetentionCard />
      <ExtensionSlot name="tenant.archiveSettings" props={{ readOnly }} />
      <Card data-slot="archive-capture">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail aria-hidden="true" className="size-4 text-muted-foreground" />
            {t("archive.capture.title")}
          </CardTitle>
          <CardDescription>{t("archive.capture.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            to={ARCHIVE_PATH as never}
            className="inline-flex items-center gap-1 rounded-sm text-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("archive.capture.link")}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function RetentionCard() {
  const { t } = useTranslation("tenantpage");
  const scope = useWordingScope();
  const retention = useArchiveRetention();
  let body: React.ReactNode;
  if (retention.isPending) {
    body = <Skeleton className="h-10 w-2/3" />;
  } else if (retention.isError || !retention.data) {
    body = (
      <ErrorState
        title={t("archive.retention.loadError")}
        error={retention.error}
        onRetry={() => void retention.refetch()}
        retrying={retention.isFetching}
      />
    );
  } else {
    const { mode, years } = retention.data;
    body = (
      <div className="space-y-2 text-sm">
        <p className="font-medium" data-slot="archive-retention-period">
          {years === null
            ? t("archive.retention.unlimited")
            : t("archive.retention.period", { years })}
        </p>
        <p className="text-muted-foreground">
          {years === null ? t("archive.retention.unlimitedHint") : t(`archive.retention.${mode}`)}
        </p>
        <p className="text-muted-foreground">{t("archive.retention.fixed", { scope })}</p>
      </div>
    );
  }
  return (
    <Card data-slot="archive-retention">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Hourglass aria-hidden="true" className="size-4 text-muted-foreground" />
          {t("archive.retention.title")}
        </CardTitle>
        <CardDescription>{t("archive.retention.description")}</CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
