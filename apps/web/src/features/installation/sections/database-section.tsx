import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Info,
  LoaderCircle,
  Search,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { ErrorState } from "@/components/error-state";
import { Field, messageId } from "@/components/forms/field";
import { ConfirmDialog } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ProgressBar } from "@/features/updates/progress-bar";
import { ApiError, errorMessageKey } from "@/lib/api";
import { formatBytes, formatRelative } from "@/lib/format";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import { AccessNote, useInstallationAccess } from "../access";
import {
  DATABASE_BUSY_PROBLEM,
  DATABASE_DIRECTORY_INVALID_PROBLEM,
  DATABASE_UNSUPPORTED_PROBLEM,
  type DatabaseView,
  type DiskStatus,
  failureKey,
  isAwayDuringMove,
  locationText,
  type MoveCheck,
  type MoveProblem,
  type MoveRecord,
  type MoveStep,
  type OldCopy,
  problemKey,
  problemsOf,
  useCheckDatabaseDirectory,
  useDatabase,
  useMoveDatabase,
  useRemoveOldCopy,
} from "./database-api";

/**
 * Installation > Database (docs/DATABASE.md): where PostgreSQL keeps its data, the disks
 * under it and under the local repository (with the low space warning), what the next
 * update needs on disk, moving the database to a directory on another disk through the
 * opt-in updater, and the old copy a move leaves until it is removed. Every provider
 * admin reads; the owner checks, moves and removes (moving and removing ask for a recent
 * sign-in). While a move runs the application is stopped: the page keeps its last view
 * and says so, and reads the result when the application is back.
 */
export function DatabaseSection() {
  const { t } = useTranslation("installation");
  const query = useDatabase();
  if (query.isPending) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (query.isError && !query.data) {
    return (
      <ErrorState
        title={t("database.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const away = query.isError && isAwayDuringMove(query.error);
  return <DatabaseContent view={query.data as DatabaseView} away={away} />;
}

export function DatabaseContent({ view, away = false }: { view: DatabaseView; away?: boolean }) {
  const { t } = useTranslation("installation");
  return (
    <div className="space-y-6" data-slot="database">
      <p className="text-sm text-muted-foreground">{t("database.intro")}</p>
      <DisksCard view={view} />
      {view.move ? <MoveCard move={view.move} away={away} /> : null}
      <MoveFormCard view={view} />
      <OldCopiesCard view={view} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Where it is, and how much room there is
// ---------------------------------------------------------------------------

function DiskLine({ disk, label }: { disk: DiskStatus; label: string }) {
  const { t, i18n } = useTranslation("installation");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <div className="space-y-1" data-slot="disk" data-disk={disk.kind} data-low={disk.low}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{label}</span>
        {disk.low ? <Badge variant="warning">{t("database.disks.low")}</Badge> : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {t("database.disks.free", {
          free: formatBytes(disk.freeBytes, language),
          total: formatBytes(disk.totalBytes, language),
        })}
      </p>
      {disk.location ? (
        <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {disk.location}
        </p>
      ) : null}
    </div>
  );
}

function DisksCard({ view }: { view: DatabaseView }) {
  const { t, i18n } = useTranslation("installation");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const low = [view.disks.database, view.disks.repository].filter((disk) => disk?.low);
  const space = view.updateSpace;
  return (
    <Card data-slot="database-location">
      <CardHeader>
        <CardTitle>{t("database.location.title")}</CardTitle>
        <CardDescription>{t("database.location.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {view.location ? (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t("database.location.where")}</dt>
            <dd className="font-mono text-xs [overflow-wrap:anywhere]" data-slot="database-where">
              {view.location.kind === "volume"
                ? t("database.location.volume", { name: locationText(view.location) })
                : locationText(view.location)}
            </dd>
            {view.usage ? (
              <>
                <dt className="text-muted-foreground">{t("database.location.size")}</dt>
                <dd>{formatBytes(view.usage.dataBytes, language)}</dd>
                <dt className="text-muted-foreground">{t("database.location.filesystem")}</dt>
                <dd>{view.usage.filesystem ?? t("database.location.unknown")}</dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t(`database.updater.${view.updater}`)}</p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {view.disks.database ? (
            <DiskLine disk={view.disks.database} label={t("database.disks.database")} />
          ) : null}
          {view.disks.repository ? (
            <DiskLine disk={view.disks.repository} label={t("database.disks.repository")} />
          ) : null}
        </div>
        {low.length > 0 ? (
          <Alert variant="warning" data-slot="disk-low">
            <TriangleAlert />
            <AlertTitle>{t("database.disks.lowTitle")}</AlertTitle>
            <AlertDescription>{t("database.disks.lowBody")}</AlertDescription>
          </Alert>
        ) : null}
        {space ? (
          <div className="space-y-1 text-sm" data-slot="update-space" data-enough={space.enough}>
            <p className="font-medium">{t("database.updateSpace.title")}</p>
            <p className="text-muted-foreground">
              {t(space.enough ? "database.updateSpace.enough" : "database.updateSpace.short", {
                needed: formatBytes(
                  space.stateRequiredBytes + space.databaseRequiredBytes,
                  language,
                ),
                free: formatBytes(space.stateFreeBytes ?? 0, language),
                dump: formatBytes(space.dumpBytes, language),
                images: formatBytes(space.imageBytes, language),
                migrations: formatBytes(space.migrationBytes, language),
              })}
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A move: running or finished
// ---------------------------------------------------------------------------

function StepIcon({ status }: { status: MoveStep["status"] }) {
  switch (status) {
    case "done":
      return <CircleCheck className="size-4 text-foreground" aria-hidden="true" />;
    case "running":
      return <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />;
    case "failed":
      return <CircleX className="size-4 text-destructive-text" aria-hidden="true" />;
    default:
      return <CircleDashed className="size-4 text-muted-foreground" aria-hidden="true" />;
  }
}

const STATUS_VARIANT: Record<MoveRecord["status"], "info" | "outline" | "warning" | "destructive"> =
  {
    running: "info",
    succeeded: "outline",
    rolled_back: "warning",
    needs_attention: "destructive",
  };

function MoveCard({ move, away }: { move: MoveRecord; away: boolean }) {
  const { t, i18n } = useTranslation("installation");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const running = move.status === "running";
  return (
    <Card data-slot="database-move" data-status={move.status}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t("database.move.title")}
          <Badge variant={STATUS_VARIANT[move.status]}>
            {t(`database.move.status.${move.status}`)}
          </Badge>
        </CardTitle>
        <CardDescription>
          {t("database.move.requestedBy", {
            who: move.requestedBy.label,
            when: formatRelative(move.startedAt, language) ?? move.startedAt,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="font-mono text-xs [overflow-wrap:anywhere]">
          {t("database.move.fromTo", { from: locationText(move.from), to: move.dataDir })}
        </p>
        {running ? <ProgressBar value={move.progress} label={t("database.move.progress")} /> : null}
        {running ? (
          <Alert variant="info">
            <Info />
            <AlertDescription>
              {away ? t("database.move.away") : t("database.move.downtime")}
            </AlertDescription>
          </Alert>
        ) : null}
        <ol className="space-y-2 text-sm">
          {move.steps.map((step) => (
            <li
              key={step.id}
              className="flex items-center gap-2"
              data-slot="database-step"
              data-step={step.id}
              data-status={step.status}
            >
              <StepIcon status={step.status} />
              <span className={step.status === "skipped" ? "text-muted-foreground" : undefined}>
                {t(`database.steps.${step.id}`)}
              </span>
              <span className="sr-only">{t(`database.stepStatus.${step.status}`)}</span>
            </li>
          ))}
        </ol>
        {move.status === "succeeded" ? (
          <Alert variant="info" data-slot="database-moved">
            <Info />
            <AlertDescription>
              {t("database.move.succeeded", {
                to: move.dataDir,
                entries: move.verified?.entries ?? 0,
              })}
            </AlertDescription>
          </Alert>
        ) : null}
        {move.failure ? (
          <Alert
            variant={move.status === "needs_attention" ? "destructive" : "warning"}
            data-slot="database-failure"
            data-code={move.failure.code}
          >
            <TriangleAlert />
            <AlertTitle>{t(failureKey(move.failure.code))}</AlertTitle>
            <AlertDescription>
              <p>
                {move.status === "needs_attention"
                  ? t("database.move.needsAttention")
                  : t("database.move.rolledBack")}
              </p>
              {move.failure.detail ? (
                <p className="mt-1 break-words font-mono text-xs">{move.failure.detail}</p>
              ) : null}
              {move.keptCopy ? (
                <p className="mt-2">{t("database.move.keptCopy", { path: move.keptCopy })}</p>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {move.log.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              {t("database.move.log")}
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">
              {move.log.join("\n")}
            </pre>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

function ProblemList({ problems }: { problems: readonly MoveProblem[] }) {
  const { t } = useTranslation("installation");
  return (
    <ul className="space-y-2" data-slot="database-problems">
      {problems.map((problem, index) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: problems carry no id and never reorder
          key={`${problem.code}-${index}`}
          className="space-y-1 rounded-lg border border-border p-3 text-sm"
          data-problem={problem.code}
        >
          <p className="font-medium">{t(problemKey(problem.code))}</p>
          {problem.detail ? (
            <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {problem.detail}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** A refusal of the api that is not a list of failed checks, as a sentence. */
function errorText(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError) {
    switch (error.problem?.type) {
      case DATABASE_BUSY_PROBLEM:
        return t("installation:database.errors.busy");
      case DATABASE_UNSUPPORTED_PROBLEM:
        return t("installation:database.errors.unsupported");
      case DATABASE_DIRECTORY_INVALID_PROBLEM:
        return t("installation:database.problems.path_invalid");
    }
  }
  return t(errorMessageKey(error));
}

function MoveFormCard({ view }: { view: DatabaseView }) {
  const { t, i18n } = useTranslation("installation");
  const { t: tc } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const access = useInstallationAccess();
  const check = useCheckDatabaseDirectory();
  const move = useMoveDatabase();
  const identity = useConfirmIdentity();
  const [dir, setDir] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  const inputId = React.useId();

  const blocked = access.change !== null;
  const unavailable = view.updater !== "ready";
  const running = view.move?.status === "running" || view.removal?.status === "running";
  const checked: MoveCheck | undefined = check.data;
  const checkedThis = checked !== undefined && checked.targetDir === dir.trim().replace(/\/+$/, "");
  const canMove = checkedThis && checked.ok && !running && !view.updateActive;

  const runCheck = () => {
    if (dir.trim() === "") {
      return;
    }
    move.reset();
    check.mutate(dir.trim());
  };

  const startMove = (target: string) => {
    move.mutate(target, {
      onSuccess: () => setConfirming(false),
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          setConfirming(false);
          identity.ask(() => startMove(target));
        }
      },
    });
  };

  const refused = problemsOf(move.error ?? check.error);
  return (
    <Card data-slot="database-move-form">
      <CardHeader>
        <CardTitle>{t("database.form.title")}</CardTitle>
        <CardDescription>{t("database.form.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AccessNote block={access.change} level="owner" />
        {unavailable ? (
          <Alert variant="info" data-slot="database-unavailable">
            <Info />
            <AlertDescription>
              <p>{t(`database.updater.${view.updater}`)}</p>
              <p className="mt-1">{t("database.form.manual")}</p>
            </AlertDescription>
          </Alert>
        ) : view.movable === false ? (
          <Alert variant="warning" data-slot="database-not-movable">
            <TriangleAlert />
            <AlertDescription>{t("database.form.notMovable")}</AlertDescription>
          </Alert>
        ) : null}
        {view.updateActive ? (
          <Alert variant="info">
            <Info />
            <AlertDescription>{t("database.form.updateActive")}</AlertDescription>
          </Alert>
        ) : null}
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            runCheck();
          }}
        >
          <Field
            id={inputId}
            label={t("database.form.directory")}
            hint={t("database.form.directoryHint")}
          >
            <Input
              id={inputId}
              value={dir}
              onChange={(event) => setDir(event.target.value)}
              placeholder="/mnt/volume-1/restow-db"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              aria-describedby={messageId(inputId)}
              disabled={blocked || unavailable || running}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="outline"
              disabled={blocked || unavailable || running || dir.trim() === "" || check.isPending}
            >
              {check.isPending ? <LoaderCircle className="animate-spin" /> : <Search />}
              {t("database.form.check")}
            </Button>
            <Button
              type="button"
              disabled={blocked || unavailable || !canMove || move.isPending}
              onClick={() => setConfirming(true)}
            >
              {t("database.form.move")}
            </Button>
          </div>
        </form>
        {check.isError && refused.length === 0 ? (
          <p className="text-sm text-destructive" role="alert">
            {errorText(check.error, tc)}
          </p>
        ) : null}
        {checkedThis && checked ? (
          checked.ok ? (
            <Alert variant="info" data-slot="database-check-ok">
              <Info />
              <AlertTitle>{t("database.check.ok")}</AlertTitle>
              <AlertDescription>
                {t("database.check.facts", {
                  filesystem: checked.filesystem ?? t("database.location.unknown"),
                  free: formatBytes(checked.freeBytes ?? 0, language),
                  needed: formatBytes(checked.requiredBytes ?? 0, language),
                })}
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-2" data-slot="database-check-failed">
              <p className="text-sm font-medium">{t("database.check.failed")}</p>
              <ProblemList problems={checked.problems} />
            </div>
          )
        ) : null}
        {move.isError && !isRecentSignInRequired(move.error) ? (
          refused.length > 0 ? (
            <ProblemList problems={refused} />
          ) : (
            <p className="text-sm text-destructive" role="alert">
              {errorText(move.error, tc)}
            </p>
          )
        ) : null}
        <ConfirmDialog
          open={confirming}
          onOpenChange={(open) => {
            if (!move.isPending) {
              setConfirming(open);
            }
          }}
          title={t("database.confirm.title")}
          description={t("database.confirm.description", {
            size: formatBytes(checked?.dataBytes ?? view.usage?.dataBytes ?? 0, language),
          })}
          confirmLabel={t("database.confirm.action")}
          confirmationText={checked?.targetDir}
          pending={move.isPending}
          onConfirm={() => {
            if (checked) {
              startMove(checked.targetDir);
            }
          }}
        >
          <ul className="list-disc space-y-1 ps-5 text-sm">
            <li>{t("database.confirm.downtime")}</li>
            <li>{t("database.confirm.jobs")}</li>
            <li>{t("database.confirm.rollback")}</li>
            <li>{t("database.confirm.keep")}</li>
          </ul>
        </ConfirmDialog>
        {identity.dialog}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Old copies
// ---------------------------------------------------------------------------

function OldCopiesCard({ view }: { view: DatabaseView }) {
  const { t, i18n } = useTranslation("installation");
  const { t: tc } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const access = useInstallationAccess();
  const remove = useRemoveOldCopy();
  const identity = useConfirmIdentity();
  const [selected, setSelected] = React.useState<OldCopy | null>(null);
  if (view.oldCopies.length === 0 && !view.removal) {
    return null;
  }
  const busy = view.move?.status === "running" || view.removal?.status === "running";

  const removeCopy = (copy: OldCopy) => {
    remove.mutate(copy.id, {
      onSuccess: () => setSelected(null),
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          setSelected(null);
          identity.ask(() => removeCopy(copy));
        }
      },
    });
  };

  return (
    <Card data-slot="database-old-copies">
      <CardHeader>
        <CardTitle>{t("database.oldCopies.title")}</CardTitle>
        <CardDescription>{t("database.oldCopies.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {view.oldCopies.map((copy) => (
            <li
              key={copy.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"
              data-slot="database-old-copy"
            >
              <div className="min-w-0 space-y-1">
                <p className="font-mono text-xs [overflow-wrap:anywhere]">
                  {copy.location.kind === "volume"
                    ? t("database.location.volume", { name: locationText(copy.location) })
                    : locationText(copy.location)}
                </p>
                <p className="text-muted-foreground">
                  {t("database.oldCopies.movedAt", {
                    when: formatRelative(copy.movedAt, language) ?? copy.movedAt,
                  })}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={access.change !== null || busy || remove.isPending}
                onClick={() => setSelected(copy)}
              >
                {t("database.oldCopies.remove")}
              </Button>
            </li>
          ))}
        </ul>
        {view.removal ? (
          <p
            className="text-sm text-muted-foreground"
            data-slot="database-removal"
            data-status={view.removal.status}
          >
            {t(`database.oldCopies.removal.${view.removal.status}`, {
              location: locationText(view.removal.location),
            })}
            {view.removal.detail ? ` ${view.removal.detail}` : ""}
          </p>
        ) : null}
        {remove.isError && !isRecentSignInRequired(remove.error) ? (
          <p className="text-sm text-destructive" role="alert">
            {errorText(remove.error, tc)}
          </p>
        ) : null}
        <ConfirmDialog
          open={selected !== null}
          onOpenChange={(open) => {
            if (!open && !remove.isPending) {
              setSelected(null);
            }
          }}
          title={t("database.oldCopies.confirmTitle")}
          description={t("database.oldCopies.confirmDescription", {
            location: selected ? locationText(selected.location) : "",
          })}
          confirmLabel={t("database.oldCopies.remove")}
          destructive
          pending={remove.isPending}
          onConfirm={() => {
            if (selected) {
              removeCopy(selected);
            }
          }}
        />
        {identity.dialog}
      </CardContent>
    </Card>
  );
}
