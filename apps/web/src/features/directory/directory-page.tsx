import { Link, type LinkProps, useNavigate, useSearch } from "@tanstack/react-router";
import { Building, RefreshCw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/page-header";
import { RequireRole } from "@/components/require-role";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BackupAllButton } from "@/features/jobs/components/actions";
import { activeTenantPageTo } from "@/lib/tenant-paths";

import { DIRECTORY_ROLES } from "./access";
import { useDirectorySources, useDirectoryTenant, useRefreshAfterSync } from "./hooks";
import { ObjectsPanel } from "./objects-panel";
import { sourceHealth } from "./presenters";
import {
  type DirectorySearch,
  type DirectoryTab,
  directoryTo,
  nextSearch,
  parseDirectorySearch,
} from "./search";
import { SourcesPanel } from "./sources-panel";

/**
 * Protected objects: every mailbox, OneDrive and IMAP account of the tenant
 * with its protection status, last backup and verified recoverability, and
 * per source the rules, the directory sync and the IMAP account list.
 * Filters, sort, page and tab live in the URL.
 */
export function DirectoryPage() {
  return (
    <RequireRole roles={DIRECTORY_ROLES}>
      <TooltipProvider delayDuration={200}>
        <DirectoryContent />
      </TooltipProvider>
    </RequireRole>
  );
}

function useDirectorySearch() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = React.useMemo(() => parseDirectorySearch(raw), [raw]);
  const navigate = useNavigate();
  const update = React.useCallback(
    (change: Partial<DirectorySearch>) => {
      void navigate({
        to: directoryTo(),
        search: nextSearch(search, change) as never,
        // Typing in the search box should not flood the history.
        replace: "q" in change,
      });
    },
    [navigate, search],
  );
  return { search, update };
}

function DirectoryContent() {
  const { t } = useTranslation("directory");
  const { t: tc } = useTranslation();
  const { tenantId, tenantName } = useDirectoryTenant();
  const { search, update } = useDirectorySearch();
  const sources = useDirectorySources();
  useRefreshAfterSync(sources.data);

  if (!tenantId) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("title")} description={t("subtitle")} />
        <Alert variant="info">
          <Building />
          <AlertTitle>{t("noTenant.title")}</AlertTitle>
          <AlertDescription>{t("noTenant.description")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const tab: DirectoryTab = search.tab ?? "objects";
  const attention = (sources.data ?? []).some((source) => {
    const health = sourceHealth(source);
    return health === "error" || health === "consent_outstanding";
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={tenantName ? t("tenantScope", { tenant: tenantName }) : t("subtitle")}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => void sources.refetch()}
          disabled={sources.isFetching}
        >
          <RefreshCw className={sources.isFetching ? "animate-spin" : undefined} />
          {tc("actions.refresh")}
        </Button>
        {/* Backing up lives here since the final menu (0.1.0): all at once,
            or per object with live state on the backup page. */}
        <Link
          to={activeTenantPageTo("protection", "backup")}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {t("backup.perObject")}
        </Link>
        <BackupAllButton label={t("backup.now")} />
      </PageHeader>

      <Tabs
        value={tab}
        onValueChange={(value) => update({ tab: value === "sources" ? "sources" : undefined })}
      >
        <TabsList>
          <TabsTrigger value="objects">{t("tabs.objects")}</TabsTrigger>
          <TabsTrigger value="sources" className="gap-2">
            {t("tabs.sources")}
            {attention ? (
              <span className="size-2 rounded-full bg-destructive" aria-hidden="true" />
            ) : null}
            {attention ? <span className="sr-only">{t("tabs.attention")}</span> : null}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="objects" className="mt-2">
          <ObjectsPanel
            search={search}
            onSearchChange={update}
            sources={sources.data ?? []}
            onShowSources={() => update({ tab: "sources" })}
          />
        </TabsContent>
        <TabsContent value="sources" className="mt-2">
          <SourcesPanel
            sources={sources}
            onShowObjects={(sourceId) =>
              update({
                tab: undefined,
                source: sourceId,
                q: undefined,
                kind: undefined,
                status: undefined,
              })
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
