import { Link } from "@tanstack/react-router";
import { KeyRound, Loader2 } from "lucide-react";

import { StatusBadge } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/sonner";
import { FailureExplanation } from "@/features/failures";

import type { FileShareDetail } from "../api.js";
import { type ShareFormat, useCancelRun, useRequestVerify, useShareFormat } from "../hooks.js";
import {
  budgetPercent,
  progressRatio,
  readinessView,
  shareErrorKey,
  standingView,
} from "../presenters.js";

export interface OverviewTabProps {
  share: FileShareDetail;
  /** "Back up the empty share once" (4.3), offered when the last backup found it empty. */
  onBackupEmptyOnce: () => void;
  onShowRuns: () => void;
}

/** One fact: a label and its value. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/**
 * How the share stands (docs/FILESHARES.md 12.3): protection and restore check, the run in
 * progress with its phase and totals, the newest failure with what to do, the repository
 * against its budget, and the connection with its last test.
 */
export function OverviewTab({ share, onBackupEmptyOnce, onShowRuns }: OverviewTabProps) {
  const format = useShareFormat();
  const { t } = format;
  const standing = standingView(share.standing);
  const readiness = readinessView(share.readiness.state);
  const failure = share.lastRun?.status === "failed" ? share.lastRun.failure : null;
  const verify = useRequestVerify(share.id);

  return (
    <div className="grid gap-4 lg:grid-cols-2" data-slot="share-overview">
      {share.credentialFailedAt ? (
        <Alert variant="destructive" className="lg:col-span-2" data-slot="credential-warning">
          <KeyRound aria-hidden="true" />
          <AlertTitle>{t("overview.credential.title")}</AlertTitle>
          <AlertDescription>
            {t("overview.credential.description", {
              time: format.dateTime(share.credentialFailedAt) ?? "",
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      {share.activeRun ? <ActiveRun share={share} format={format} onShowRuns={onShowRuns} /> : null}

      {failure ? (
        <div className="space-y-2 lg:col-span-2" data-slot="last-failure">
          <FailureExplanation
            failure={failure}
            subject={{ kind: "job", queue: t("runs.kind.backup"), object: share.name }}
            fileShareId={share.id}
            at={share.lastRun?.finishedAt ?? null}
          />
          {failure.code === "share.empty_source" ? (
            <Button variant="outline" onClick={onBackupEmptyOnce} data-action="backup-empty-once">
              {t("overview.emptyOnce")}
            </Button>
          ) : null}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("overview.protection.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Fact label={t("overview.protection.state")}>
              <StatusBadge tone={standing.tone} icon>
                {t(standing.key)}
              </StatusBadge>
            </Fact>
            <Fact label={t("overview.protection.readiness")}>
              <StatusBadge tone={readiness.tone} icon>
                {t(readiness.key)}
              </StatusBadge>
              {share.readiness.checkedAt ? (
                <span className="block text-xs text-muted-foreground">
                  {t("overview.protection.checkedAt", {
                    time: format.dateTime(share.readiness.checkedAt) ?? "",
                  })}
                </span>
              ) : null}
              {share.restorePoints > 0 && share.retiredAt === null ? (
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto px-0"
                  loading={verify.isPending}
                  onClick={() =>
                    verify.mutate(undefined, {
                      onSuccess: () => toast.success(t("overview.protection.checkQueued")),
                      onError: (error) => toast.error(t(shareErrorKey(error))),
                    })
                  }
                  data-action="check-now"
                >
                  {t("overview.protection.checkNow")}
                </Button>
              ) : null}
            </Fact>
            <Fact label={t("overview.protection.job")}>
              {share.job ? (
                <Link
                  to={`/jobs/definitions/${encodeURIComponent(share.job.id)}` as never}
                  search={{ type: "share" } as never}
                  className="hover:underline"
                >
                  {share.job.name}
                </Link>
              ) : (
                <span className="text-muted-foreground">{t("overview.protection.noJob")}</span>
              )}
            </Fact>
            <Fact label={t("overview.protection.folders")}>
              {share.includes.length > 0
                ? share.includes.join(", ")
                : t("overview.protection.everything")}
            </Fact>
            <Fact label={t("overview.protection.lastSuccess")}>
              {share.lastSuccessAt ? format.dateTime(share.lastSuccessAt) : t("list.never")}
            </Fact>
            <Fact label={t("overview.protection.restorePoints")}>
              {format.integer(share.restorePoints)}
            </Fact>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("overview.repository.title")}</CardTitle>
          <CardDescription>{t("overview.repository.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <RepositoryUse share={share} format={format} />
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">{t("overview.connection.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-3">
            <Fact label={t("overview.connection.location")}>
              <code className="font-mono text-xs">{share.location}</code>
            </Fact>
            <Fact label={t("overview.connection.protocol")}>
              {share.protocol === "smb"
                ? t("overview.connection.smb", {
                    version: share.smbVersion ?? "3.1.1",
                    seal: share.seal ? t("overview.connection.sealed") : "",
                  })
                : t("overview.connection.nfs", { version: share.nfsVersion ?? "4.1" })}
            </Fact>
            <Fact label={t("overview.connection.lastTest")}>
              {share.lastTest
                ? share.lastTest.ok
                  ? t("overview.connection.testOk", {
                      time: format.dateTime(share.lastTest.at) ?? "",
                    })
                  : t("overview.connection.testFailed", {
                      time: format.dateTime(share.lastTest.at) ?? "",
                    })
                : t("overview.connection.notTested")}
            </Fact>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function ActiveRun({
  share,
  format,
  onShowRuns,
}: {
  share: FileShareDetail;
  format: ShareFormat;
  onShowRuns: () => void;
}) {
  const { t } = format;
  const cancel = useCancelRun(share.id);
  const run = share.activeRun;
  if (!run) return null;
  const progress = run.progress;
  const ratio = progressRatio(progress);
  return (
    <Card className="lg:col-span-2" data-slot="active-run">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {run.status === "queued" ? null : (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          )}
          {t(`runs.kind.${run.kind}`)} · {t(`runs.status.${run.status}`)}
        </CardTitle>
        {progress ? (
          <CardDescription>
            {t(`overview.phase.${progress.phase}`, { defaultValue: progress.phase })}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2">
        {ratio !== null ? (
          <Progress value={Math.round(ratio * 100)} aria-label={t("overview.progress")} />
        ) : null}
        {progress ? (
          <p className="text-sm" data-slot="run-progress">
            {t("overview.progressLine", {
              files: format.integer(progress.filesDone),
              totalFiles: format.integer(progress.totalFiles),
              bytes: format.bytes(progress.bytesDone),
              totalBytes: format.bytes(progress.totalBytes),
            })}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{t("overview.waiting")}</p>
        )}
        {progress?.currentPath ? (
          <p
            className="truncate font-mono text-xs text-muted-foreground"
            title={progress.currentPath}
          >
            {progress.currentPath}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onShowRuns}>
            {t("overview.showRuns")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => cancel.mutate(run.id)}
            loading={cancel.isPending}
            data-action="cancel-run"
          >
            {t("runs.cancel")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RepositoryUse({ share, format }: { share: FileShareDetail; format: ShareFormat }) {
  const { t } = format;
  const used = share.quota.usedBytes;
  const percent = budgetPercent(used, share.quota.quotaGib);
  return (
    <div className="space-y-2" data-slot="repository-use">
      <p className="text-sm">
        {used === null
          ? t("overview.repository.notMeasured")
          : share.quota.quotaGib
            ? t("overview.repository.usedOf", {
                used: format.bytes(used),
                budget: format.bytes(share.quota.quotaGib * 1024 ** 3),
              })
            : t("overview.repository.used", { used: format.bytes(used) })}
      </p>
      {percent !== null ? (
        <Progress value={Math.min(100, percent)} aria-label={t("overview.repository.title")} />
      ) : null}
      {share.quota.level !== "ok" ? (
        <Alert variant={share.quota.level === "exceeded" ? "destructive" : "warning"}>
          <AlertDescription>{t(`overview.repository.${share.quota.level}`)}</AlertDescription>
        </Alert>
      ) : null}
      {share.quota.tenantQuotaGib ? (
        <p className="text-xs text-muted-foreground">
          {t("overview.repository.tenant", {
            used: format.bytes(share.quota.tenantUsedBytes),
            budget: format.bytes(share.quota.tenantQuotaGib * 1024 ** 3),
          })}
        </p>
      ) : null}
    </div>
  );
}
