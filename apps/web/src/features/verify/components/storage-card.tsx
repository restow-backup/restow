import { Link } from "@tanstack/react-router";
import { AlertTriangle, HardDrive, Loader2, Wrench } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { jobDetailTo } from "@/features/jobs/paths";
import type { Schedule, ScrubMode, StorageIntegrity } from "@/features/verify/api";
import { PackList } from "@/features/verify/components/pack-list";
import { StorageBadge } from "@/features/verify/components/status";
import { gcMessage, startErrorMessage } from "@/features/verify/presenters";
import { type VerifyFormat, useStartScrub } from "@/features/verify/use-verify";

/** Pack integrity from the scrub: when it last ran, what it found, what it repaired. */
export function StorageCard({
  storage,
  schedule,
  format,
}: {
  storage: StorageIntegrity;
  schedule: Schedule | null;
  format: VerifyFormat;
}) {
  const { t } = format;
  const start = useStartScrub();
  const latest = storage.latest;
  const gc = latest ? gcMessage(latest.gc, format.bytes) : null;

  const run = (mode: ScrubMode) => {
    start.mutate(mode, {
      onSuccess: () => toast.success(t(`toast.scrubStarted.${mode}`)),
      onError: (error) => {
        const message = startErrorMessage(error);
        toast.error(t("toast.scrubFailed"), { description: t(message.key, message.values) });
      },
    });
  };
  const busy = storage.running !== null || start.isPending;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="size-4 text-muted-foreground" aria-hidden="true" />
            {t("storage.title")}
            <StorageBadge state={storage.state} />
          </CardTitle>
          <CardDescription>{t("storage.description")}</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => run("sample")}
            disabled={busy}
            loading={start.isPending && start.variables === "sample"}
          >
            {t("actions.scrubSample")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => run("full")}
            disabled={busy}
            loading={start.isPending && start.variables === "full"}
          >
            {t("actions.scrubFull")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {storage.running ? (
          <p className="flex items-center gap-2 text-muted-foreground" aria-live="polite">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {t(`storage.running.${storage.running.status}`, {
              mode: t(`storage.mode.${storage.running.mode}`),
            })}
          </p>
        ) : null}

        {latest ? (
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">{t("storage.lastCheck")}</dt>
              <dd title={format.dateTime(latest.completedAt) ?? undefined}>
                {t("storage.lastCheckValue", {
                  when: format.relative(latest.completedAt) ?? t("storage.unknownDate"),
                  mode: t(`storage.mode.${latest.mode}`),
                })}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("storage.lastFull")}</dt>
              <dd title={format.dateTime(storage.lastFullAt) ?? undefined}>
                {format.relative(storage.lastFullAt) ?? t("storage.noFull")}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs text-muted-foreground">{t("storage.coverage")}</dt>
              <dd>
                {t("storage.packs", {
                  checked: format.integer(latest.packsChecked),
                  total: format.integer(latest.packsTotal),
                  bytes: format.bytes(latest.bytesChecked),
                })}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-muted-foreground">{t("storage.never")}</p>
        )}

        {latest && latest.corrupt.length > 0 ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>{t("storage.corruptTitle", { count: latest.corrupt.length })}</AlertTitle>
            <AlertDescription>
              <p>{t("storage.corrupt")}</p>
              <p>{t("storage.corruptHeal")}</p>
              <PackList packs={latest.corrupt} format={format} />
            </AlertDescription>
          </Alert>
        ) : null}

        {latest && latest.retired > 0 ? (
          <p className="text-muted-foreground">{t("storage.retired", { count: latest.retired })}</p>
        ) : null}

        {latest && latest.repaired.length > 0 ? (
          <Alert variant="warning">
            <Wrench />
            <AlertTitle>{t("storage.repairedTitle", { count: latest.repaired.length })}</AlertTitle>
            <AlertDescription>
              {t("storage.repaired")}
              <PackList packs={latest.repaired} format={format} />
            </AlertDescription>
          </Alert>
        ) : null}

        {gc ? <p className="text-muted-foreground">{t(gc.key, gc.values)}</p> : null}

        <p className="text-xs text-muted-foreground">
          {schedule
            ? schedule.nextRunAt
              ? t("storage.schedule.next", { when: format.relative(schedule.nextRunAt) })
              : t("storage.schedule.enabled")
            : t("storage.schedule.none")}
        </p>

        {storage.lastFailure ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>{t("storage.failed")}</AlertTitle>
            <AlertDescription className="space-y-1">
              {storage.lastFailure.message ? (
                <p className="break-words font-mono text-xs">{storage.lastFailure.message}</p>
              ) : null}
              <Link
                to={jobDetailTo(storage.lastFailure.jobId)}
                className="text-xs font-medium underline underline-offset-4"
              >
                {t("actions.openJob")}
              </Link>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
