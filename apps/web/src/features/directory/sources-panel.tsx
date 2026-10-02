import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  ChevronDown,
  ListFilter,
  RefreshCw,
  Server,
  SlidersHorizontal,
  UserPlus,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { CauseLine, FailureExplanation } from "@/features/failures";
import { ThrottleWaitLine } from "@/features/jobs/components/job-progress";
import { useNow } from "@/features/jobs/use-jobs";
import { sourceDetailTo, sourcesListTo } from "@/features/sources/paths";
import { errorMessageKey } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";

import { AccountsDialog } from "./accounts-dialog";
import { useRequestSync } from "./hooks";
import { HEALTH_VARIANT, describeSourceProblem, sourceHealth, syncResultKey } from "./presenters";
import { RulesSheet } from "./rules-sheet";
import type { DirectoryLastRun, DirectorySource, SyncWarning } from "./types";

interface SourcesPanelProps {
  sources: UseQueryResult<DirectorySource[]>;
  onShowObjects: (sourceId: string) => void;
}

export function SourcesPanel({ sources, onShowObjects }: SourcesPanelProps) {
  const { t } = useTranslation("directory");

  if (sources.isError && !sources.data) {
    return (
      <ErrorState
        title={t("sources.error")}
        error={sources.error}
        onRetry={() => void sources.refetch()}
        retrying={sources.isFetching}
      />
    );
  }
  if (sources.isPending) {
    return (
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
    );
  }
  if (sources.data.length === 0) {
    return (
      <Card className="py-0">
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <p className="font-medium">{t("sources.empty.title")}</p>
          <p className="max-w-md text-sm text-muted-foreground">{t("sources.empty.description")}</p>
          <Link
            to={sourcesListTo()}
            className={buttonVariants({ variant: "outline", size: "sm", className: "mt-2" })}
          >
            {t("sources.empty.action")}
          </Link>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="grid gap-4 *:min-w-0 xl:grid-cols-2">
      {sources.data.map((source) => (
        <SourceCard key={source.id} source={source} onShowObjects={onShowObjects} />
      ))}
    </div>
  );
}

function SourceCard({
  source,
  onShowObjects,
}: {
  source: DirectorySource;
  onShowObjects: (sourceId: string) => void;
}) {
  const { t } = useTranslation("directory");
  const [rulesOpen, setRulesOpen] = React.useState(false);
  const [accountsOpen, setAccountsOpen] = React.useState(false);
  const health = sourceHealth(source);
  const Icon = source.kind === "m365" ? Building2 : Server;

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex min-w-0 items-start gap-3">
          <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="truncate font-semibold leading-tight">{source.name}</h3>
            <p className="text-xs text-muted-foreground">{t(`sources.kind.${source.kind}`)}</p>
          </div>
        </div>
        <Badge variant={HEALTH_VARIANT[health]}>{t(`sources.health.${health}`)}</Badge>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-4">
        <Counts source={source} />

        {source.kind === "m365" ? <M365Details source={source} /> : null}
        {source.kind === "imap" ? (
          <>
            <p className="text-sm text-muted-foreground">{t("sources.manualHint")}</p>
            <ConnectionCause source={source} />
          </>
        ) : null}

        <div className="mt-auto flex flex-wrap gap-2 pt-2">
          {source.kind === "m365" ? (
            <>
              <SyncButtons source={source} />
              <Button variant="outline" size="sm" onClick={() => setRulesOpen(true)}>
                <SlidersHorizontal />
                {t("sources.rules.edit")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={() => setAccountsOpen(true)}
              disabled={source.status === "disabled"}
            >
              <UserPlus />
              {t("sources.addAccounts")}
            </Button>
          )}
          {source.counts.total > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => onShowObjects(source.id)}>
              <ListFilter />
              {t("sources.showObjects")}
            </Button>
          ) : null}
        </div>
      </CardContent>

      {source.kind === "m365" ? (
        <RulesSheet source={source} open={rulesOpen} onOpenChange={setRulesOpen} />
      ) : (
        <AccountsDialog source={source} open={accountsOpen} onOpenChange={setAccountsOpen} />
      )}
    </Card>
  );
}

function Counts({ source }: { source: DirectorySource }) {
  const { t } = useTranslation("directory");
  const { counts } = source;
  return (
    <div className="space-y-0.5 text-sm">
      <p>
        {source.kind === "m365"
          ? t("sources.m365Kinds", { mailbox: counts.mailbox, onedrive: counts.onedrive })
          : t("sources.imapKinds", { count: counts.imap })}
      </p>
      <p className="text-muted-foreground">
        {t("sources.counts", {
          active: counts.active,
          excluded: counts.excluded,
          orphaned: counts.orphaned,
        })}
      </p>
    </div>
  );
}

/**
 * An IMAP source has no directory sync to explain; when its connection is
 * broken the card names the cause in one line and points to the source.
 */
function ConnectionCause({ source }: { source: DirectorySource }) {
  const { t } = useTranslation("directory");
  const problem = describeSourceProblem(source);
  if (!problem) {
    return null;
  }
  return (
    <div className="space-y-1">
      <CauseLine failure={problem.failure} className="block text-sm" />
      <Link
        to={sourceDetailTo(source.id)}
        className="inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
      >
        {t("sources.openSource")}
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}

function M365Details({ source }: { source: DirectorySource }) {
  const { t } = useTranslation("directory");
  const rules = source.rules;

  if (!source.consentGranted || source.status === "disabled") {
    return (
      <Alert variant="warning">
        <AlertTriangle />
        <AlertDescription className="flex flex-col gap-2">
          <span>
            {source.status === "disabled" ? t("sources.disabledHint") : t("sources.consentHint")}
          </span>
          <Link
            to={sourceDetailTo(source.id)}
            className="inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
          >
            {t("sources.openSource")}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {rules ? (
        <section className="space-y-1 text-sm">
          <h4 className="text-xs font-medium text-muted-foreground">{t("sources.rules.title")}</h4>
          <p>
            {rules.mode === "all"
              ? t("sources.rules.all")
              : rules.mode === "selected"
                ? t("sources.rules.selected")
                : rules.groupName
                  ? t("sources.rules.group", { group: rules.groupName })
                  : t("sources.rules.groupUnnamed", { id: rules.groupId ?? "" })}
          </p>
          {rules.mode === "selected" ? (
            // The shared-mailbox switch and exclusion list play no part in
            // this mode (evaluateProtection never reads them); only the
            // individual decisions (the includes that populate it) apply.
            <p className="text-muted-foreground">
              {t("sources.rules.overrides", { count: source.overrideCount })}
            </p>
          ) : (
            <>
              <p className="text-muted-foreground">
                {rules.includeSharedMailboxes
                  ? t("sources.rules.shared")
                  : t("sources.rules.sharedOff")}
              </p>
              <p className="flex flex-wrap gap-x-3 text-muted-foreground">
                <span>{t("sources.rules.exclusions", { count: rules.exclude.length })}</span>
                <span>{t("sources.rules.overrides", { count: source.overrideCount })}</span>
              </p>
            </>
          )}
        </section>
      ) : null}
      <SyncState source={source} />
    </div>
  );
}

function SyncState({ source }: { source: DirectorySource }) {
  const { t, i18n } = useTranslation("directory");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const sync = source.sync;
  const pending = sync?.pendingJob ?? null;
  // The clock only ticks while there is a Microsoft pause to count down.
  const now = useNow(pending?.status === "active" && pending.throttle !== null);
  if (!sync) {
    return null;
  }
  const lastRun = sync.lastRun;
  const problem = describeSourceProblem(source);
  return (
    <section className="space-y-2 text-sm" aria-live="polite">
      <div className="flex flex-wrap gap-1.5">
        {pending ? (
          <Badge variant="secondary">
            <RefreshCw className="animate-spin" aria-hidden="true" />
            {pending.status === "active" ? t("sync.running") : t("sync.queued")}
          </Badge>
        ) : null}
        {sync.fullSyncPending ? <Badge variant="outline">{t("sync.fullPending")}</Badge> : null}
      </div>
      {pending ? <ThrottleWaitLine run={pending} now={now} className="text-xs" /> : null}

      {lastRun === null ? (
        // A queued or running sync already says so in the badge above; "Not
        // synced yet" next to it would read as a contradiction.
        pending ? null : (
          <p className="text-muted-foreground">{t("sync.never")}</p>
        )
      ) : lastRun.ok ? (
        <SuccessfulRun run={lastRun} lastFullSyncAt={sync.lastFullSyncAt} language={language} />
      ) : problem?.kind === "sync" ? null : (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>
            {t("sync.failedAt", { when: formatRelative(lastRun.finishedAt, language) ?? "" })}
          </AlertTitle>
          {lastRun.error ? (
            <AlertDescription className="break-words">{lastRun.error}</AlertDescription>
          ) : null}
        </Alert>
      )}

      {/* A classified cause explains itself; it replaces the recorded error text. */}
      {problem ? (
        <FailureExplanation
          failure={problem.failure}
          message={problem.message}
          subject={{ kind: problem.kind, name: source.name }}
          sourceId={source.id}
          at={problem.at}
          retrying={pending !== null}
        />
      ) : null}
    </section>
  );
}

function SuccessfulRun({
  run,
  lastFullSyncAt,
  language,
}: {
  run: DirectoryLastRun;
  lastFullSyncAt: string | null;
  language: string;
}) {
  const { t } = useTranslation("directory");
  const counts = run.counts;
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <time
          dateTime={run.finishedAt}
          title={formatDateTime(run.finishedAt, language) ?? undefined}
        >
          {t("sync.lastRun", { when: formatRelative(run.finishedAt, language) ?? "" })}
        </time>
        {run.mode ? <Badge variant="muted">{t(`sync.mode.${run.mode}`)}</Badge> : null}
      </p>
      {counts ? (
        <>
          <p className="text-muted-foreground">
            {t("sync.summary", {
              users: counts.users,
              created: counts.created,
              updated: counts.updated,
              orphaned: counts.orphaned,
            })}
          </p>
          {counts.rescoped > 0 ? (
            <p className="text-muted-foreground">
              {t("sync.rescoped", { count: counts.rescoped })}
            </p>
          ) : null}
          {counts.removedUsers > 0 ? (
            <p className="text-muted-foreground">
              {t("sync.removedUsers", { count: counts.removedUsers })}
            </p>
          ) : null}
        </>
      ) : null}
      {lastFullSyncAt && run.mode === "incremental" ? (
        <p className="text-xs text-muted-foreground">
          {t("sync.lastFull", { when: formatRelative(lastFullSyncAt, language) ?? "" })}
        </p>
      ) : null}
      {run.warningCount > 0 ? <Warnings warnings={run.warnings} total={run.warningCount} /> : null}
    </div>
  );
}

function Warnings({ warnings, total }: { warnings: readonly SyncWarning[]; total: number }) {
  const { t } = useTranslation("directory");
  const [open, setOpen] = React.useState(false);
  const hidden = total - warnings.length;
  return (
    <Alert variant="warning" className="mt-2">
      <AlertTriangle />
      <AlertTitle className="flex items-center justify-between gap-2">
        <span>{t("sync.warnings.title", { count: total })}</span>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {open ? t("sync.warnings.hide") : t("sync.warnings.show")}
        </Button>
      </AlertTitle>
      {open ? (
        <AlertDescription>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {warnings.map((warning, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: warnings have no identity beyond their position
              <li key={index}>
                {warning.kind === "group_unresolved"
                  ? t("sync.warnings.group_unresolved", { status: warning.status })
                  : t(`sync.warnings.${warning.kind}`, {
                      user: warning.user ?? warning.userId,
                      status: warning.status,
                    })}
              </li>
            ))}
          </ul>
          {hidden > 0 ? (
            <p className="mt-2 text-muted-foreground">
              {t("sync.warnings.more", { count: hidden })}
            </p>
          ) : null}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

function SyncButtons({ source }: { source: DirectorySource }) {
  const { t } = useTranslation("directory");
  const { t: tc } = useTranslation();
  const requestSync = useRequestSync();
  const pending = source.sync?.pendingJob !== null && source.sync?.pendingJob !== undefined;
  const blocked = !source.consentGranted || source.status === "disabled";

  const start = async (full: boolean) => {
    try {
      const outcome = await requestSync.mutateAsync({ sourceId: source.id, full });
      toast.success(t(syncResultKey(outcome)));
    } catch (error) {
      toast.error(t("sync.failed"), { description: tc(errorMessageKey(error)) });
    }
  };

  return (
    <div className="flex">
      <Button
        size="sm"
        className="rounded-r-none"
        onClick={() => void start(false)}
        loading={requestSync.isPending}
        disabled={blocked || pending}
      >
        {requestSync.isPending ? null : <RefreshCw />}
        {t("sync.now")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            className="rounded-l-none border-l border-primary-foreground/20 px-2"
            disabled={blocked || requestSync.isPending}
            aria-label={t("sync.menu")}
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuItem
            className="flex-col items-start gap-0.5"
            onSelect={() => void start(true)}
          >
            <span className="font-medium">{t("sync.full")}</span>
            <span className="text-xs text-muted-foreground">{t("sync.fullHint")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
