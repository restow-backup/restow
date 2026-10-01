import { useNavigate, useSearch } from "@tanstack/react-router";
import { Building2, ChevronDown, FileInput, Mail, Plug, Plus, RefreshCw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { IMPORT_PATHS, importTo } from "@/features/imports/paths";
import { NoTenantSelected, SourcesForbidden } from "./components/access-states";
import { ConsentResultAlert } from "./components/consent-result-alert";
import { ImapSourceDialog } from "./components/imap-source-dialog";
import { CreateM365Dialog } from "./components/m365-source-dialogs";
import { SourceCard } from "./components/source-card";
import { sourcesListTo } from "./paths";
import { describeConsentResult, parseConsentSearch } from "./presenters";
import type { SourceKind } from "./types";
import { useSourceList } from "./use-sources";

/**
 * All sources of the active tenant as cards with their status and the next
 * step each one needs. Adding a source opens the matching dialog.
 */
export function SourcesPage() {
  const { t } = useTranslation("sources");
  const { t: tc } = useTranslation();
  const { query, tenantId, tenantName, canManage } = useSourceList();
  const [dialog, setDialog] = React.useState<SourceKind | null>(null);
  const consentMessage = useConsentMessageFromUrl();

  const header = (
    <PageHeader
      title={t("title")}
      description={tenantName ? t("tenantScope", { tenant: tenantName }) : t("subtitle")}
    >
      {tenantId && canManage ? (
        <>
          <Button
            variant="outline"
            size="icon"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            aria-label={tc("actions.refresh")}
            title={tc("actions.refresh")}
          >
            <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
          </Button>
          <AddSourceMenu onSelect={setDialog} />
        </>
      ) : null}
    </PageHeader>
  );

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
  } else if (query.data.length === 0) {
    body = <EmptySources onSelect={setDialog} />;
  } else {
    body = (
      <div className="grid grid-cols-1 gap-4 *:min-w-0 md:grid-cols-2 xl:grid-cols-3">
        {query.data.map((source) => (
          <SourceCard key={source.id} source={source} />
        ))}
      </div>
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
function useConsentMessageFromUrl() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const [message, setMessage] = React.useState(() =>
    describeConsentResult(parseConsentSearch(search)),
  );
  const hadParams = React.useRef(message !== null);

  React.useEffect(() => {
    if (hadParams.current) {
      hadParams.current = false;
      void navigate({ to: sourcesListTo(), replace: true });
    }
  }, [navigate]);

  return { message, dismiss: () => setMessage(null) };
}

function AddSourceMenu({ onSelect }: { onSelect: (kind: SourceKind) => void }) {
  const { t } = useTranslation("sources");
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus />
          {t("actions.add")}
          <ChevronDown className="opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => onSelect("m365")}>
          <Building2 />
          {t("actions.addM365")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onSelect("imap")}>
          <Mail />
          {t("actions.addImap")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void navigate({ to: importTo(IMPORT_PATHS.wizard) })}>
          <FileInput />
          {t("actions.addImport")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EmptySources({ onSelect }: { onSelect: (kind: SourceKind) => void }) {
  const { t } = useTranslation("sources");
  return (
    <Card className="border-dashed py-0">
      <CardContent className="flex flex-col items-center gap-4 px-6 py-12 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Plug aria-hidden="true" className="size-5" />
        </div>
        <div className="max-w-md space-y-1.5">
          <h2 className="text-base font-semibold">{t("list.empty.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("list.empty.description")}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={() => onSelect("m365")}>
            <Building2 />
            {t("actions.addM365")}
          </Button>
          <Button variant="outline" onClick={() => onSelect("imap")}>
            <Mail />
            {t("actions.addImap")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SourceGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
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
