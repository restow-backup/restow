import { useNavigate, useSearch } from "@tanstack/react-router";
import { Building2, Mail, Plug, Plus } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { RefreshButton } from "@/components/kit";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { NoTenantSelected, SourcesForbidden } from "./components/access-states";
import { ConsentResultAlert } from "./components/consent-result-alert";
import { ImapSourceDialog } from "./components/imap-source-dialog";
import { SourcesJobsNotice } from "./components/jobs-notice";
import { CreateM365Dialog } from "./components/m365-source-dialogs";
import { SourceCard } from "./components/source-card";
import { sourcesListSearch, sourcesListTo } from "./paths";
import { describeConsentResult, parseConsentSearch } from "./presenters";
import type { SourceKind } from "./types";
import { useSourceList } from "./use-sources";

/** The kinds of connection this page lists (the imports have their own page). */
export type ListedSourceKind = "m365" | "imap";

/**
 * The sources of one kind (`m365` or `imap`) of the active tenant as cards with
 * their status and the next step each one needs, one tab of the Connections
 * section each. Adding a source opens the matching dialog.
 */
export function SourcesPage({ kind }: { kind: ListedSourceKind }) {
  const { t } = useTranslation("sources");
  const { t: tc } = useTranslation();
  const { query, tenantId, tenantName, canManage } = useSourceList();
  const [dialog, setDialog] = React.useState<SourceKind | null>(null);
  const consentMessage = useConsentMessageFromUrl(kind);

  const header = (
    <PageHeader
      title={t(`list.title.${kind}`)}
      description={
        tenantName ? t(`list.description.${kind}`, { tenant: tenantName }) : t("subtitle")
      }
    >
      {tenantId && canManage ? (
        <>
          <RefreshButton
            label={tc("actions.refresh")}
            fetching={query.isFetching}
            onRefresh={() => void query.refetch()}
          />
          <Button onClick={() => setDialog(kind)}>
            <Plus />
            {t(kind === "m365" ? "actions.addM365" : "actions.addImap")}
          </Button>
        </>
      ) : null}
    </PageHeader>
  );

  const sources = (query.data ?? []).filter((source) => source.kind === kind);
  let body: React.ReactNode;
  if (!tenantId) {
    body = <NoTenantSelected />;
  } else if (!canManage) {
    body = <SourcesForbidden />;
  } else if (query.isPending) {
    body = <SourceGridSkeleton />;
  } else if (query.isError) {
    body = (
      <ErrorState
        title={t("error.title")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  } else if (sources.length === 0) {
    body = <EmptySources kind={kind} onSelect={setDialog} />;
  } else {
    body = (
      <>
        {/* Connected is not backed up: the objects need a backup job that runs. */}
        <SourcesJobsNotice />
        <div className="grid grid-cols-1 gap-4 *:min-w-0 lg:grid-cols-2 2xl:grid-cols-3">
          {sources.map((source) => (
            <SourceCard key={source.id} source={source} />
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      {consentMessage.message ? (
        <ConsentResultAlert message={consentMessage.message} onDismiss={consentMessage.dismiss} />
      ) : null}
      {body}
      <CreateM365Dialog
        open={dialog === "m365"}
        onOpenChange={(open) => !open && setDialog(null)}
      />
      <ImapSourceDialog
        open={dialog === "imap"}
        onOpenChange={(open) => !open && setDialog(null)}
      />
    </div>
  );
}

/**
 * A consent outcome Entra sent the admin back with (invalid or unknown links
 * land on the list). Read once, then the URL is cleaned so a reload does not
 * repeat it.
 */
function useConsentMessageFromUrl(kind: ListedSourceKind) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const [message, setMessage] = React.useState(() =>
    describeConsentResult(parseConsentSearch(search)),
  );
  const hadParams = React.useRef(message !== null);

  React.useEffect(() => {
    if (hadParams.current) {
      hadParams.current = false;
      void navigate({
        to: sourcesListTo(),
        search: sourcesListSearch(kind) as never,
        replace: true,
      });
    }
  }, [navigate, kind]);

  return { message, dismiss: () => setMessage(null) };
}

function EmptySources({
  kind,
  onSelect,
}: {
  kind: ListedSourceKind;
  onSelect: (kind: SourceKind) => void;
}) {
  const { t } = useTranslation("sources");
  return (
    <Card className="border-dashed py-0">
      <CardContent className="flex flex-col items-center gap-4 px-6 py-12 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Plug aria-hidden="true" className="size-5" />
        </div>
        <div className="max-w-md space-y-1.5">
          <h3 className="text-base font-semibold">{t(`list.empty.${kind}.title`)}</h3>
          <p className="text-sm text-muted-foreground">{t(`list.empty.${kind}.description`)}</p>
        </div>
        <Button onClick={() => onSelect(kind)}>
          {kind === "m365" ? <Building2 /> : <Mail />}
          {t(kind === "m365" ? "actions.addM365" : "actions.addImap")}
        </Button>
      </CardContent>
    </Card>
  );
}

function SourceGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
      {[0, 1, 2].map((index) => (
        <Card key={index} className="gap-3">
          <CardHeader className="flex flex-row items-start gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
