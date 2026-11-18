import { Link } from "@tanstack/react-router";
import { Database } from "lucide-react";

import { ErrorState, PageHeader, StatusBadge } from "@/components/kit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import { canAccess, useSession } from "@/lib/session";

import { DatabaseBackupsCard } from "./components/backups.js";
import { DatabaseSizeCard } from "./components/health.js";
import { useDatabase, useDbFormat } from "./hooks.js";
import { connectionTo, DATABASE_ADMIN_ROLES, linkTo } from "./paths.js";
import { ENGINE_LABEL, ratingView, reachabilityView } from "./presenters.js";

/**
 * One database (docs/DATABASES.md 2.3): where it lives, its identity, size and rating, its
 * backups with "Jetzt sichern", "Wiederherstellen", the download and the restore guide (D3); the
 * check reports come with D6.
 */
export function DatabasePage({ databaseId }: { databaseId: string }) {
  const format = useDbFormat();
  const { t } = format;
  const database = useDatabase(databaseId);
  const { role } = useSession();
  const admin = canAccess(role, DATABASE_ADMIN_ROLES);
  if (database.isError) {
    return (
      <ErrorState
        title={t("database.loadError")}
        error={database.error}
        onRetry={() => void database.refetch()}
        retrying={database.isFetching}
      />
    );
  }
  if (database.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  const data = database.data;
  const rating = ratingView(data.rating);
  const reach = reachabilityView(data.reachability);
  return (
    <div className="space-y-6" data-slot="database-page">
      <PageHeader
        icon={Database}
        title={data.name}
        description={`${ENGINE_LABEL[data.engine]} · ${data.connection.address}`}
      />
      <div className="flex flex-wrap gap-2">
        <StatusBadge tone={rating.tone}>{t(rating.key)}</StatusBadge>
        <StatusBadge tone={reach.tone}>{t(reach.key)}</StatusBadge>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("database.facts")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t("list.columns.connection")}</dt>
            <dd>
              <Link {...linkTo(connectionTo(data.connectionId))} className="hover:underline">
                {data.connectionName}
              </Link>
            </dd>
            <dt className="text-muted-foreground">{t("list.columns.mode")}</dt>
            <dd>{t(`modes.${data.mode}`)}</dd>
            <dt className="text-muted-foreground">{t("list.columns.size")}</dt>
            <dd>{format.bytes(data.sizeBytes) ?? t("list.unknown")}</dd>
            <dt className="text-muted-foreground">{t("database.identity")}</dt>
            <dd>
              {data.identityByName ? t("database.identityByName") : t("database.identityKnown")}
            </dd>
            <dt className="text-muted-foreground">{t("database.firstSeen")}</dt>
            <dd>{format.dateTime(data.firstSeenAt)}</dd>
            {data.excluded ? (
              <>
                <dt className="text-muted-foreground">{t("database.selection")}</dt>
                <dd>{data.droppedAt ? t("database.dropped") : t("connection.excluded")}</dd>
              </>
            ) : null}
          </dl>
        </CardContent>
      </Card>
      <DatabaseBackupsCard
        databaseId={data.id}
        databaseName={data.name}
        engine={data.engine}
        connectionId={data.connectionId}
        admin={admin}
        format={format}
      />
      <DatabaseSizeCard databaseId={data.id} format={format} />
    </div>
  );
}
