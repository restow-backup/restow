import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  ArrowLeft,
  CirclePause,
  Ellipsis,
  Pause,
  Pencil,
  Play,
  SearchX,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { ImportSourcePanel } from "@/features/imports/components/import-source-panel";
import { ApiError } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useSession } from "@/lib/session";
import { NoTenantSelected, SourcesForbidden } from "./components/access-states";
import { ConsentResultAlert } from "./components/consent-result-alert";
import { DeleteSourceDialog } from "./components/delete-source-dialog";
import { ImapConnectionCard } from "./components/imap-connection-card";
import { ImapSourceDialog } from "./components/imap-source-dialog";
import { M365ConnectionCard } from "./components/m365-connection-card";
import { EditM365Dialog } from "./components/m365-source-dialogs";
import { PermissionsCard } from "./components/permissions-card";
import { SourceProblem } from "./components/source-problem";
import { SourceKindIcon, SourceStatusBadge } from "./components/status";
import { sourceDetailTo, sourcesListSearch, sourcesListTo } from "./paths";
import {
  type ConsentSearch,
  VERIFICATION_GRACE_MS,
  describeConsentResult,
  isAwaitingVerification,
  parseConsentSearch,
  sourceErrorKey,
} from "./presenters";
import type { SourceDto } from "./types";
import {
  useIsTestingSource,
  useSourceDetail,
  useTestSource,
  useUpdateSource,
  useVerifySource,
} from "./use-sources";

type DialogName = "edit" | "delete" | null;

/**
 * One source: its connection (admin consent or IMAP login), the permission
 * checklist or connection test, and the operator actions. Entra sends the
 * consenting admin back here with the outcome in the URL.
 */
export function SourceDetailPage() {
  const { t } = useTranslation("sources");
  const { sourceId = "" } = useParams({ strict: false }) as { sourceId?: string };
  const consent = useConsentSearchOnce(sourceId);
  const [waitingForConsent, setWaitingForConsent] = React.useState(false);
  const [pollForVerification, setPollForVerification] = React.useState(false);
  const { query, tenantId, canManage } = useSourceDetail(sourceId, {
    poll: waitingForConsent || pollForVerification,
  });
  const [consentMessage, setConsentMessage] = React.useState(() => describeConsentResult(consent));

  // After a consent the callback verifies; keep looking until its result is
  // in, but never longer than the grace period.
  const source = query.data;
  React.useEffect(() => {
    const awaiting = isAwaitingVerification(source, Date.now());
    setPollForVerification(awaiting);
    if (!awaiting) {
      return;
    }
    const grantedAt = Date.parse(source?.m365?.consentGrantedAt ?? "");
    const remaining = Math.max(0, grantedAt + VERIFICATION_GRACE_MS - Date.now());
    const timer = window.setTimeout(() => setPollForVerification(false), remaining);
    return () => window.clearTimeout(timer);
  }, [source]);

  let body: React.ReactNode;
  if (!tenantId) {
    body = <NoTenantSelected />;
  } else if (!canManage) {
    body = <SourcesForbidden />;
  } else if (!source && query.isPending) {
    body = <DetailSkeleton />;
  } else if (query.isError && !source) {
    body =
      query.error instanceof ApiError && query.error.status === 404 ? (
        <Alert variant="warning">
          <SearchX />
          <AlertTitle>{t("error.title")}</AlertTitle>
          <AlertDescription>{t("error.notFound")}</AlertDescription>
        </Alert>
      ) : (
        <ErrorState
          title={t("error.title")}
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      );
  } else if (source) {
    body = (
      <SourceDetail
        source={source}
        consentAlert={
          consentMessage ? (
            <ConsentResultAlert
              message={consentMessage}
              onDismiss={() => setConsentMessage(null)}
            />
          ) : null
        }
        onWaitingForConsent={setWaitingForConsent}
      />
    );
  }

  return (
    <div className="space-y-6">
      <Link
        to={sourcesListTo()}
        search={sourcesListSearch(source?.kind) as never}
        className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t("actions.backToList")}
      </Link>
      {body}
    </div>
  );
}

/** The consent parameters Entra appended, read once; the URL is cleaned right away. */
function useConsentSearchOnce(sourceId: string): ConsentSearch {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const [consent] = React.useState(() => parseConsentSearch(search));
  const hadParams = React.useRef(Object.keys(consent).length > 0);

  React.useEffect(() => {
    if (hadParams.current) {
      hadParams.current = false;
      void navigate({ to: sourceDetailTo(sourceId), replace: true });
    }
  }, [navigate, sourceId]);

  return consent;
}

function SourceDetail({
  source,
  consentAlert,
  onWaitingForConsent,
}: {
  source: SourceDto;
  consentAlert: React.ReactNode;
  onWaitingForConsent: (waiting: boolean) => void;
}) {
  const { t, i18n } = useTranslation("sources");
  const { t: tc } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const [dialog, setDialog] = React.useState<DialogName>(null);
  const update = useUpdateSource(source.id);
  const verify = useVerifySource(source.id);
  const test = useTestSource();
  const testing = useIsTestingSource(source.id);
  const paused = source.status === "disabled";
  // The import source holds imported mailboxes only: no connection, no pause, nothing to edit.
  const imported = source.kind === "import";

  const togglePause = () => {
    update.mutate(
      { status: paused ? "active" : "disabled" },
      {
        onSuccess: () => toast.success(paused ? t("toasts.resumed") : t("toasts.paused")),
        onError: (error) => toast.error(tc(sourceErrorKey(error))),
      },
    );
  };

  const runVerify = () => {
    verify.mutate(undefined, { onSuccess: () => toast.success(t("toasts.verified")) });
  };

  const runTest = () => {
    test.mutate(source.id, { onSuccess: () => toast.success(t("toasts.tested")) });
  };

  const created = formatRelative(source.createdAt, language);

  return (
    <>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <SourceKindIcon kind={source.kind} className="size-5" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="break-words text-lg font-semibold tracking-tight">{source.name}</h2>
              {imported ? null : <SourceStatusBadge status={source.status} />}
            </div>
            <p className="text-sm text-muted-foreground">
              {t(`kindLong.${source.kind}`)}
              {created ? (
                <span title={formatDateTime(source.createdAt, language) ?? undefined}>
                  {" · "}
                  {t("detail.created", { when: created })}
                </span>
              ) : null}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {imported ? null : (
            <Button variant="outline" size="sm" onClick={togglePause} loading={update.isPending}>
              {update.isPending ? null : paused ? <Play /> : <Pause />}
              {paused ? t("actions.resume") : t("actions.pause")}
            </Button>
          )}
          {imported ? null : (
            <Button variant="outline" size="sm" onClick={() => setDialog("edit")}>
              <Pencil />
              {t("actions.edit")}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={t("actions.moreActions")}
                title={t("actions.moreActions")}
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setDialog("delete")} variant="destructive">
                <Trash2 />
                {t("actions.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {consentAlert}

      {paused ? (
        <Alert variant="info">
          <CirclePause />
          <AlertTitle>{t("detail.paused.title")}</AlertTitle>
          <AlertDescription>{t("detail.paused.description")}</AlertDescription>
        </Alert>
      ) : null}

      <SourceProblem source={source} />

      {imported ? (
        <ImportSourcePanel mailboxes={source.importedMailboxes ?? 0} />
      ) : source.kind === "m365" ? (
        <div className="space-y-4">
          <M365ConnectionCard source={source} onWaitingChange={onWaitingForConsent} />
          <PermissionsCard
            source={source}
            fresh={verify.data?.verification ?? null}
            onVerify={runVerify}
            verifying={verify.isPending}
            verifyError={verify.error}
          />
        </div>
      ) : (
        <ImapConnectionCard
          source={source}
          onEdit={() => setDialog("edit")}
          onTest={runTest}
          testing={testing}
          testError={test.error}
        />
      )}

      {imported ? null : source.kind === "m365" ? (
        <EditM365Dialog
          open={dialog === "edit"}
          onOpenChange={(open) => !open && setDialog(null)}
          source={source}
        />
      ) : (
        <ImapSourceDialog
          open={dialog === "edit"}
          onOpenChange={(open) => !open && setDialog(null)}
          source={source}
        />
      )}
      <DeleteSourceDialog
        open={dialog === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        source={source}
      />
    </>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-40" />
        </div>
      </div>
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
