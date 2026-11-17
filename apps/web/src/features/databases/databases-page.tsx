import { Link } from "@tanstack/react-router";
import { Building2, Database, DatabaseZap, Plus, Server } from "lucide-react";
import * as React from "react";

import {
  EmptyState,
  ErrorState,
  NativeSelect,
  PageHeader,
  RefreshButton,
  StatusBadge,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { canAccess, useSession } from "@/lib/session";

import type { DbConnection, DbDatabase, DbRating, DbSuggestion } from "./api.js";
import {
  AddConnectionDialog,
  type AddConnectionPrefill,
} from "./components/add-connection-dialog.js";
import {
  type DbFormat,
  useConnections,
  useDatabases,
  useDbFormat,
  useSuggestions,
} from "./hooks.js";
import { connectionTo, DATABASE_ADMIN_ROLES, databaseTo, linkTo } from "./paths.js";
import {
  codeKey,
  connectionStateView,
  ENGINE_LABEL,
  ratingView,
  reachabilityView,
} from "./presenters.js";

export interface DatabasesPageProps {
  /** The add dialog is open (`?add=1`). */
  adding: boolean;
  onAddChange: (open: boolean) => void;
}

const ALL = "all";

/**
 * Databases (docs/DATABASES.md 2.3): every database of the tenant with engine, connection, mode,
 * size, last backup and check, reachability and rating, red first; the connections; and what the
 * agents' inventories found and no connection covers yet. "Add database" opens the dialog that
 * tests before it saves. Administrators add and change, restore operators read.
 */
export function DatabasesPage({ adding, onAddChange }: DatabasesPageProps) {
  const format = useDbFormat();
  const { t } = format;
  const { activeTenant, role } = useSession();
  const admin = canAccess(role, DATABASE_ADMIN_ROLES);
  const databases = useDatabases();
  const connections = useConnections();
  const suggestions = useSuggestions(admin);
  const [prefill, setPrefill] = React.useState<AddConnectionPrefill | null>(null);
  const [engine, setEngine] = React.useState(ALL);
  const [connection, setConnection] = React.useState(ALL);
  const [rating, setRating] = React.useState(ALL);

  const openAdd = (from: AddConnectionPrefill | null) => {
    setPrefill(from);
    onAddChange(true);
  };

  const header = (
    <PageHeader
      icon={Database}
      title={t("list.title")}
      description={t("list.description")}
      actions={
        activeTenant ? (
          <>
            <RefreshButton
              label={t("list.refresh")}
              fetching={databases.isFetching || connections.isFetching}
              onRefresh={() => {
                void databases.refetch();
                void connections.refetch();
                if (admin) void suggestions.refetch();
              }}
            />
            {admin ? (
              <Button onClick={() => openAdd(null)} data-action="add-database">
                <Plus aria-hidden="true" />
                {t("list.add")}
              </Button>
            ) : null}
          </>
        ) : null
      }
    />
  );

  if (activeTenant === null) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={Building2}
          title={t("list.noTenant.title")}
          description={t("list.noTenant.description")}
        />
      </div>
    );
  }

  const all = databases.data?.databases ?? [];
  const shown = all.filter(
    (database) =>
      (engine === ALL || database.engine === engine) &&
      (connection === ALL || database.connectionId === connection) &&
      (rating === ALL || database.rating === rating),
  );
  const engines = [...new Set(all.map((database) => database.engine))];
  const ratings = [...new Set(all.map((database) => database.rating))];

  return (
    <div className="space-y-6" data-slot="databases-page">
      {header}
      {admin && suggestions.data && suggestions.data.suggestions.length > 0 ? (
        <Suggestions
          suggestions={suggestions.data.suggestions}
          format={format}
          onUse={(from) => openAdd(from)}
        />
      ) : null}
      {databases.isError ? (
        <ErrorState
          title={t("list.loadError")}
          error={databases.error}
          onRetry={() => void databases.refetch()}
          retrying={databases.isFetching}
        />
      ) : databases.isPending ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : all.length === 0 && (connections.data?.connections.length ?? 0) === 0 ? (
        <EmptyState
          icon={DatabaseZap}
          title={t("list.empty.title")}
          description={t("list.empty.description")}
          actions={
            admin ? (
              <Button onClick={() => openAdd(null)}>
                <Plus aria-hidden="true" />
                {t("list.add")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap gap-3" data-slot="database-filters">
            <NativeSelect
              aria-label={t("list.filters.engine")}
              value={engine}
              onChange={(event) => setEngine(event.target.value)}
            >
              <option value={ALL}>{t("list.filters.allEngines")}</option>
              {engines.map((value) => (
                <option key={value} value={value}>
                  {ENGINE_LABEL[value]}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={t("list.filters.connection")}
              value={connection}
              onChange={(event) => setConnection(event.target.value)}
            >
              <option value={ALL}>{t("list.filters.allConnections")}</option>
              {(connections.data?.connections ?? []).map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label={t("list.filters.rating")}
              value={rating}
              onChange={(event) => setRating(event.target.value)}
            >
              <option value={ALL}>{t("list.filters.allRatings")}</option>
              {ratings.map((value: DbRating) => (
                <option key={value} value={value}>
                  {t(ratingView(value).key)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Card className="py-0">
            <CardContent className="p-0">
              <DatabasesTable databases={shown} format={format} />
            </CardContent>
          </Card>
          <ConnectionsCard connections={connections.data?.connections ?? []} format={format} />
        </>
      )}
      {admin ? (
        <AddConnectionDialog open={adding} onOpenChange={onAddChange} prefill={prefill} />
      ) : null}
    </div>
  );
}

function DatabasesTable({
  databases,
  format,
}: {
  databases: readonly DbDatabase[];
  format: DbFormat;
}) {
  const { t } = format;
  if (databases.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">{t("list.noneMatch")}</p>;
  }
  return (
    <Table scrollLabel={t("list.title")}>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">{t("list.columns.database")}</TableHead>
          <TableHead>{t("list.columns.engine")}</TableHead>
          <TableHead className="hidden md:table-cell">{t("list.columns.connection")}</TableHead>
          <TableHead className="hidden lg:table-cell">{t("list.columns.mode")}</TableHead>
          <TableHead className="hidden lg:table-cell">{t("list.columns.size")}</TableHead>
          <TableHead className="hidden xl:table-cell">{t("list.columns.lastBackup")}</TableHead>
          <TableHead className="hidden xl:table-cell">{t("list.columns.lastCheck")}</TableHead>
          <TableHead>{t("list.columns.reachability")}</TableHead>
          <TableHead className="pr-4">{t("list.columns.rating")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {databases.map((database) => {
          const rating = ratingView(database.rating);
          const reach = reachabilityView(database.reachable);
          return (
            <TableRow key={database.id} data-database={database.id}>
              <TableCell className="pl-4 font-medium">
                <Link {...linkTo(databaseTo(database.id))} className="hover:underline">
                  {database.name}
                </Link>
              </TableCell>
              <TableCell>{ENGINE_LABEL[database.engine]}</TableCell>
              <TableCell className="hidden md:table-cell">
                <Link {...linkTo(connectionTo(database.connectionId))} className="hover:underline">
                  {database.connectionName}
                </Link>
              </TableCell>
              <TableCell className="hidden lg:table-cell">{t(`modes.${database.mode}`)}</TableCell>
              <TableCell className="hidden lg:table-cell">
                {format.bytes(database.sizeBytes) ?? t("list.unknown")}
              </TableCell>
              <TableCell className="hidden xl:table-cell">
                {format.dateTime(database.lastBackupAt) ?? t("list.never")}
              </TableCell>
              <TableCell className="hidden xl:table-cell">
                {format.dateTime(database.lastCheckAt) ?? t("list.never")}
              </TableCell>
              <TableCell>
                <StatusBadge tone={reach.tone}>{t(reach.key)}</StatusBadge>
              </TableCell>
              <TableCell className="pr-4">
                <StatusBadge tone={rating.tone}>{t(rating.key)}</StatusBadge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ConnectionsCard({
  connections,
  format,
}: {
  connections: readonly DbConnection[];
  format: DbFormat;
}) {
  const { t } = format;
  if (connections.length === 0) {
    return null;
  }
  return (
    <Card data-slot="database-connections">
      <CardHeader>
        <CardTitle>{t("list.connections.title")}</CardTitle>
        <CardDescription>{t("list.connections.description")}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table scrollLabel={t("list.connections.title")}>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">{t("list.connections.name")}</TableHead>
              <TableHead>{t("list.columns.engine")}</TableHead>
              <TableHead className="hidden md:table-cell">
                {t("list.connections.executor")}
              </TableHead>
              <TableHead className="pr-4">{t("list.connections.state")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.map((connection) => {
              const state = connectionStateView(connection.state);
              const notice = connection.notices[0];
              return (
                <TableRow key={connection.id} data-connection={connection.id}>
                  <TableCell className="pl-4">
                    <Link
                      {...linkTo(connectionTo(connection.id))}
                      className="font-medium hover:underline"
                    >
                      {connection.name}
                    </Link>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {connection.address}
                    </span>
                  </TableCell>
                  <TableCell>{ENGINE_LABEL[connection.engine]}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    {connection.executor.kind === "server"
                      ? t("executor.server")
                      : (connection.executor.hostname ?? t("executor.missing"))}
                  </TableCell>
                  <TableCell className="pr-4">
                    <div className="flex flex-col gap-1">
                      <StatusBadge tone={state.tone}>{t(state.key)}</StatusBadge>
                      {notice ? (
                        <span className="text-xs text-muted-foreground">{t(codeKey(notice))}</span>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Suggestions({
  suggestions,
  format,
  onUse,
}: {
  suggestions: readonly DbSuggestion[];
  format: DbFormat;
  onUse: (prefill: AddConnectionPrefill) => void;
}) {
  const { t } = format;
  return (
    <Card data-slot="database-suggestions">
      <CardHeader>
        <CardTitle>{t("suggestions.title")}</CardTitle>
        <CardDescription>{t("suggestions.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {suggestions.map((suggestion) => (
            <li
              key={`${suggestion.endpointId}-${suggestion.name}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              data-suggestion={suggestion.name}
            >
              <span className="flex items-center gap-2 text-sm">
                <Server className="size-4 text-muted-foreground" aria-hidden="true" />
                {t("suggestions.found", {
                  engine: ENGINE_LABEL[suggestion.engine],
                  name: suggestion.name,
                  hostname: suggestion.hostname,
                })}
              </span>
              {suggestion.prefill ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => suggestion.prefill && onUse(suggestion.prefill)}
                >
                  {t("suggestions.protect")}
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">{t("suggestions.noPort")}</span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
