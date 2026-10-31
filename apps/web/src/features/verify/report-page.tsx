import { Link } from "@tanstack/react-router";
import {
  Archive,
  ArrowLeft,
  FileSearch,
  History,
  ListChecks,
  ShieldAlert,
  ShieldQuestion,
  ShieldX,
} from "lucide-react";
import type * as React from "react";

import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FailureExplanation } from "@/features/failures";
import { jobDetailTo } from "@/features/jobs/paths";
import type {
  CheckedItem,
  LatestBackup,
  ObjectStatusReason,
  Reason,
  ReportDetail,
  ScrubFinding,
  VerifyDetails,
} from "@/features/verify/api";
import { PackList } from "@/features/verify/components/pack-list";
import { ItemCause, ReasonFindings } from "@/features/verify/components/reason-findings";
import { SnapshotVerificationBadge } from "@/features/verify/components/snapshot-verification-badge";
import { ObjectKindIcon, ReportStateBadge } from "@/features/verify/components/status";
import { VERIFY_ICON, verifyOverviewTo, verifyReportTo } from "@/features/verify/paths";
import {
  objectAddress,
  objectLabel,
  objectName,
  reasonMessage,
} from "@/features/verify/presenters";
import {
  useReport,
  useReportHistory,
  useVerifyFormat,
  type VerifyFormat,
} from "@/features/verify/use-verify";
import { ApiError } from "@/lib/api";

const ITEM_STATUS_BADGE: Record<CheckedItem["status"], NonNullable<BadgeProps["variant"]>> = {
  verified: "success",
  mismatch: "destructive",
  missing: "destructive",
  unreadable: "destructive",
};

const TEST_STATUS_BADGE = {
  confirmed: "success",
  unconfirmed: "warning",
  failed: "destructive",
} as const satisfies Record<string, NonNullable<BadgeProps["variant"]>>;

const CATEGORIES = ["mail", "file", "event", "contact", "site"] as const;

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function checkKindKey(report: Pick<ReportDetail, "origin" | "kind">): string {
  return report.origin === "scrub" ? "checkKind.scrub" : `checkKind.${report.kind}`;
}

// ---------------------------------------------------------------------------
// Verify details
// ---------------------------------------------------------------------------

function ItemsTable({ details, format }: { details: VerifyDetails; format: VerifyFormat }) {
  const { t } = format;
  return (
    <Card className="pb-0">
      <CardHeader>
        <CardTitle className="text-base">{t("report.items.title")}</CardTitle>
        <CardDescription>
          {details.scope === "all"
            ? t("report.items.allDescription")
            : t("report.items.sampleDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {details.items.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted-foreground">
            {t(details.scope === "all" ? "report.items.noFailures" : "report.items.empty")}
          </p>
        ) : (
          <Table className="min-w-[44rem]" scrollLabel={t("report.items.title")}>
            <TableHeader>
              <TableRow>
                <TableHead pin={PIN_FIRST} className="pl-6">
                  {t("report.items.columns.item")}
                </TableHead>
                <TableHead>{t("report.items.columns.type")}</TableHead>
                <TableHead className="text-right">{t("report.items.columns.size")}</TableHead>
                <TableHead>{t("report.items.columns.result")}</TableHead>
                <TableHead className="pr-6">{t("report.items.columns.checksum")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {details.items.map((item) => (
                <TableRow key={item.path}>
                  <TableCell pin={PIN_FIRST} className="max-w-md pl-6 align-top">
                    <code className="break-all font-mono text-xs">{item.path}</code>
                    {item.reason ? (
                      <p className="mt-1 break-words text-xs text-muted-foreground">
                        <span className="font-medium">{t("report.items.detail")}</span>{" "}
                        {item.reason}
                      </p>
                    ) : null}
                    {item.failure ? <ItemCause failure={item.failure} item={item.path} /> : null}
                  </TableCell>
                  <TableCell className="align-top">{t(`category.${item.category}`)}</TableCell>
                  <TableCell className="whitespace-nowrap text-right align-top tabular-nums">
                    {format.bytes(item.size)}
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge variant={ITEM_STATUS_BADGE[item.status]}>
                      {t(`report.itemStatus.${item.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="pr-6 align-top text-xs text-muted-foreground">
                    {t(`report.hash.${item.objectHash}`)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {details.itemsOmitted > 0 ? (
          <p className="border-t px-6 py-3 text-xs text-muted-foreground">
            {t("report.items.omitted", { count: details.itemsOmitted })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function VerifyDetailsView({
  details,
  format,
  objectLabel,
}: {
  details: VerifyDetails;
  format: VerifyFormat;
  /** The object the report is about, for the sentences that name it. */
  objectLabel: string;
}) {
  const { t } = format;
  const { counts } = details;
  const failed = counts.mismatch + counts.missing + counts.unreadable;
  return (
    <>
      {details.manifestFailure ? (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">{t("report.manifestFailure.title")}</h2>
          <FailureExplanation
            failure={details.manifestFailure}
            subject={{ kind: "verify", object: objectLabel }}
            hideWhat
            skipTargets={["verify"]}
          />
        </section>
      ) : null}

      <Card>
        <CardContent className="grid gap-6 lg:grid-cols-3">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:col-span-2">
            <Stat label={t("report.stats.checked")} value={format.integer(counts.checked)} />
            <Stat label={t("report.stats.verified")} value={format.integer(counts.verified)} />
            <Stat label={t("report.stats.failed")} value={format.integer(failed)} />
            <Stat label={t("report.stats.bytes")} value={format.bytes(counts.bytesRead)} />
            {details.durationMs !== null ? (
              <Stat label={t("report.stats.duration")} value={format.seconds(details.durationMs)} />
            ) : null}
          </dl>
          <div className="space-y-4 text-sm">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {t("report.snapshot.title")}
              </p>
              {details.snapshot ? (
                <>
                  <p>{t("report.snapshot.sequence", { sequence: details.snapshot.sequence })}</p>
                  <p className="text-muted-foreground">
                    {details.snapshot.completedAt
                      ? t("report.snapshot.completed", {
                          when: format.dateTime(details.snapshot.completedAt),
                        })
                      : t("report.snapshot.completedUnknown")}
                  </p>
                  <p className="text-muted-foreground">
                    {t("report.snapshot.items", { count: details.snapshot.itemCount })}
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">{t("report.snapshot.none")}</p>
              )}
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {t("report.sample.title")}
              </p>
              {details.scope === "all" ? (
                <p>{t("report.sample.all")}</p>
              ) : (
                <ul className="space-y-0.5">
                  {CATEGORIES.filter((category) => counts.eligible[category] > 0).map(
                    (category) => (
                      <li key={category}>
                        {t("report.sample.line", {
                          category: t(`category.${category}`),
                          sampled: format.integer(counts.sampled[category]),
                          eligible: format.integer(counts.eligible[category]),
                        })}
                      </li>
                    ),
                  )}
                </ul>
              )}
              {details.seed !== null ? (
                <p className="text-xs text-muted-foreground">
                  {t("report.sample.seed", { seed: String(details.seed) })}
                </p>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      {details.damagedPacks.length > 0 ? (
        <Alert variant="destructive">
          <ShieldX />
          <AlertTitle>
            {t("report.damagedPacks.title", { count: details.damagedPacks.length })}
          </AlertTitle>
          <AlertDescription>
            {t("report.damagedPacks.description")}
            <ul className="mt-2 space-y-1">
              {details.damagedPacks.map((path) => (
                <li key={path}>
                  <code className="break-all font-mono text-xs">{path}</code>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {details.unreadablePacks && details.unreadablePacks.length > 0 ? (
        <Alert
          variant={
            details.unreadablePacks.some((pack) => pack.persistent) ? "destructive" : "warning"
          }
        >
          <ShieldAlert />
          <AlertTitle>
            {t("report.unreadablePacks.title", { count: details.unreadablePacks.length })}
          </AlertTitle>
          <AlertDescription>
            {t(
              details.unreadablePacks.some((pack) => pack.persistent)
                ? "report.unreadablePacks.persistent"
                : "report.unreadablePacks.description",
            )}
            <ul className="mt-2 space-y-1">
              {details.unreadablePacks.map((pack) => (
                <li key={pack.path}>
                  <code className="break-all font-mono text-xs">{pack.path}</code>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {details.testRestore ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("report.testRestore.title")}</CardTitle>
            <CardDescription>
              {t("report.testRestore.description", { target: details.testRestore.target })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {details.testRestore.items.map((item) => (
                <li key={item.path} className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <code className="break-all font-mono text-xs">{item.path}</code>
                    {item.reason ? (
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium">{t("report.items.detail")}</span>{" "}
                        {item.reason}
                      </p>
                    ) : null}
                    {item.failure ? <ItemCause failure={item.failure} item={item.path} /> : null}
                  </div>
                  <Badge variant={TEST_STATUS_BADGE[item.status]}>
                    {t(`report.testRestore.status.${item.status}`)}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <ItemsTable details={details} format={format} />
    </>
  );
}

function ScrubFindingView({ finding, format }: { finding: ScrubFinding; format: VerifyFormat }) {
  const { t } = format;
  const unreadable = finding.packs.filter((pack) => pack.unreadable);
  const damaged = finding.packs.length - unreadable.length;
  const persistent = unreadable.some((pack) => pack.unreadable?.persistent);
  const descriptions = finding.cleared
    ? [t("report.scrub.cleared")]
    : [
        ...(damaged > 0 ? [t("report.scrub.description")] : []),
        ...(unreadable.length > 0
          ? [t(persistent ? "report.scrub.unreadablePersistent" : "report.scrub.unreadable")]
          : []),
      ];
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{t("report.scrub.title")}</CardTitle>
          {descriptions.map((text) => (
            <CardDescription key={text}>{text}</CardDescription>
          ))}
        </div>
        {finding.scrubJobId ? (
          <Link
            to={jobDetailTo(finding.scrubJobId)}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ListChecks />
            {t("actions.openScrubJob")}
          </Link>
        ) : null}
      </CardHeader>
      <CardContent>
        <PackList packs={finding.packs} format={format} limit={50} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function HistoryCard({
  objectId,
  currentId,
  format,
}: {
  objectId: string;
  currentId: string;
  format: VerifyFormat;
}) {
  const { t } = format;
  const history = useReportHistory(objectId);
  const reports = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("report.history.title")}</CardTitle>
        <CardDescription>{t("report.history.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {history.isError ? (
          <ErrorState
            title={t("report.history.error")}
            error={history.error}
            onRetry={() => void history.refetch()}
            retrying={history.isFetching}
          />
        ) : history.isPending ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <ol className="divide-y">
            {reports.map((report) => {
              const content = (
                <>
                  <ReportStateBadge report={report} />
                  <span className="text-sm">{format.dateTime(report.checkedAt)}</span>
                  <span className="text-xs text-muted-foreground">{t(checkKindKey(report))}</span>
                  {report.counts ? (
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                      {t("table.result.verified", {
                        verified: format.integer(report.counts.verified),
                        checked: format.integer(report.counts.checked),
                      })}
                    </span>
                  ) : null}
                </>
              );
              return (
                <li key={report.id} className="py-2">
                  {report.id === currentId ? (
                    <div
                      className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-2 py-1"
                      aria-current="page"
                    >
                      {content}
                    </div>
                  ) : (
                    <Link
                      to={verifyReportTo(report.id)}
                      className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/60"
                    >
                      {content}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {history.hasNextPage ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => void history.fetchNextPage()}
            loading={history.isFetchingNextPage}
          >
            {t("report.history.loadMore")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * A report rates the backup it checked, nothing newer: when the object was
 * backed up again since, this says so and shows that backup's own state.
 */
/** The reasons that only say how old the backup is. */
const FRESHNESS_REASONS: ReadonlySet<string> = new Set(["snapshot_outdated", "snapshot_stale"]);

/**
 * The findings behind the rating and the reasons set aside. The server moves the backup age of
 * an orphaned object (removed from its source, rated without it) to `setAsideReasons`; a server
 * before 0.4.7 still lists it under `reasons`, so the split is made here as well.
 */
function reportFindings(report: ReportDetail): { findings: Reason[]; setAside: Reason[] } {
  const setAside = [...(report.setAsideReasons ?? [])];
  if (report.object.status !== "orphaned") {
    return { findings: report.reasons, setAside };
  }
  const findings: Reason[] = [];
  for (const reason of report.reasons) {
    (FRESHNESS_REASONS.has(reason.code) ? setAside : findings).push(reason);
  }
  return { findings, setAside };
}

/**
 * The object is gone from its source (backups kept): no newer backup can come, so the age of
 * the kept one is no finding; it is named here, as a note, instead of under the findings.
 */
function RemovedFromSourceNotice({
  setAside,
  format,
}: {
  setAside: readonly Reason[];
  format: VerifyFormat;
}) {
  const { t } = format;
  return (
    <Alert variant="info">
      <Archive aria-hidden="true" />
      <AlertTitle>{t("report.removed.title")}</AlertTitle>
      <AlertDescription>
        <p>{t("report.removed.description")}</p>
        {setAside.map((reason, index) => {
          const message = reasonMessage(reason, format.bytes);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the reasons have no identity beyond their position
            <p key={index} className="text-muted-foreground">
              {t("report.removed.notCounted", { reason: t(message.key, message.values) })}
            </p>
          );
        })}
      </AlertDescription>
    </Alert>
  );
}

/**
 * An active object that no enabled backup job covers: nothing backs it up any more, so the age of
 * its last backup is no finding (the server moved it to the reasons set aside) and is named here
 * as a note instead.
 */
function NoJobNotice({ setAside, format }: { setAside: readonly Reason[]; format: VerifyFormat }) {
  const { t } = format;
  return (
    <Alert variant="info" data-slot="no-job-notice">
      <Archive aria-hidden="true" />
      <AlertTitle>{t("report.noJob.title")}</AlertTitle>
      <AlertDescription>
        <p>{t("report.noJob.description")}</p>
        {setAside.map((reason, index) => {
          const message = reasonMessage(reason, format.bytes);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the reasons have no identity beyond their position
            <p key={index} className="text-muted-foreground">
              {t("report.removed.notCounted", { reason: t(message.key, message.values) })}
            </p>
          );
        })}
      </AlertDescription>
    </Alert>
  );
}

/**
 * The mailbox's account is disabled or unlicensed (it still exists): not backed up for now, its
 * backups kept and resumed once it is enabled or licensed again. Like a removed object, the age
 * of the kept backup is no finding.
 */
function InactiveAccountNotice({
  statusReason,
  setAside,
  format,
}: {
  statusReason: ObjectStatusReason;
  setAside: readonly Reason[];
  format: VerifyFormat;
}) {
  const { t } = format;
  return (
    <Alert variant="info" data-slot="inactive-account-notice">
      <Archive aria-hidden="true" />
      <AlertTitle>{t(`report.inactive.${statusReason}.title`)}</AlertTitle>
      <AlertDescription>
        <p>{t(`report.inactive.${statusReason}.description`)}</p>
        {setAside.map((reason, index) => {
          const message = reasonMessage(reason, format.bytes);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the reasons have no identity beyond their position
            <p key={index} className="text-muted-foreground">
              {t("report.removed.notCounted", { reason: t(message.key, message.values) })}
            </p>
          );
        })}
      </AlertDescription>
    </Alert>
  );
}

function LatestBackupNotice({ latest, format }: { latest: LatestBackup; format: VerifyFormat }) {
  const { t } = format;
  const unverified = latest.verification.state === "unverified";
  const values = {
    sequence: latest.sequence,
    when: format.dateTime(latest.completedAt) ?? t("storage.unknownDate"),
  };
  const Icon = unverified ? ShieldQuestion : History;
  return (
    <Alert variant={unverified ? "warning" : "info"}>
      <Icon aria-hidden="true" />
      <AlertTitle>
        {t(unverified ? "report.latestBackup.unverifiedTitle" : "report.latestBackup.ratedTitle")}
      </AlertTitle>
      <AlertDescription>
        <p>
          {t(unverified ? "report.latestBackup.unverified" : "report.latestBackup.rated", values)}
        </p>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <SnapshotVerificationBadge verification={latest.verification} />
          {latest.verification.reportId ? (
            <Link
              to={verifyReportTo(latest.verification.reportId)}
              className={buttonVariants({ variant: "link", size: "sm" })}
            >
              {t("report.latestBackup.open")}
            </Link>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}

/**
 * "OneDrive · anna@example.com": the kind and whose object it is. The raw
 * external id (a drive or Entra object id for M365) only in the tooltip.
 */
function ObjectLine({ object, t }: { object: ReportDetail["object"]; t: VerifyFormat["t"] }) {
  const kind = t(`kind.${object.kind}`);
  const who = objectAddress(object) ?? objectLabel(object, t);
  return (
    <span
      className="min-w-0 truncate text-sm text-muted-foreground"
      title={t("table.technicalId", { id: object.externalId })}
    >
      {who === kind ? kind : `${kind} · ${who}`}
    </span>
  );
}

function BackLink({ format }: { format: VerifyFormat }) {
  return (
    <Link
      to={verifyOverviewTo()}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      {format.t("actions.back")}
    </Link>
  );
}

/** One readiness report: the rating with every finding, and what exactly was checked. */
export function ReportPage({ reportId }: { reportId: string }) {
  const format = useVerifyFormat();
  const { t } = format;
  const query = useReport(reportId);
  const report = query.data;

  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="space-y-6">
        <BackLink format={format} />
        {notFound ? (
          <Alert variant="warning">
            <FileSearch />
            <AlertTitle>{t("report.notFound.title")}</AlertTitle>
            <AlertDescription>{t("report.notFound.description")}</AlertDescription>
          </Alert>
        ) : (
          <ErrorState
            title={t("error.report")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        )}
      </div>
    );
  }

  if (!report) {
    return (
      <div className="space-y-6" aria-hidden="true">
        <BackLink format={format} />
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const details = report.details;
  const { findings, setAside } = reportFindings(report);
  return (
    <div className="space-y-6">
      <BackLink format={format} />
      <PageHeader
        title={objectLabel(report.object, t)}
        icon={VERIFY_ICON}
        description={t("report.subtitle", {
          kind: t(checkKindKey(report)),
          when: format.dateTime(report.checkedAt),
        })}
      >
        {report.jobId && report.origin === "verify" ? (
          <Link
            to={jobDetailTo(report.jobId)}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ListChecks />
            {t("actions.openJob")}
          </Link>
        ) : null}
      </PageHeader>

      {report.latestBackup ? (
        <LatestBackupNotice latest={report.latestBackup} format={format} />
      ) : null}
      {report.object.status === "orphaned" && report.object.statusReason ? (
        <InactiveAccountNotice
          statusReason={report.object.statusReason}
          setAside={setAside}
          format={format}
        />
      ) : report.object.status === "orphaned" ? (
        <RemovedFromSourceNotice setAside={setAside} format={format} />
      ) : report.object.status === "active" && setAside.length > 0 ? (
        <NoJobNotice setAside={setAside} format={format} />
      ) : null}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center gap-3 space-y-0">
          <ObjectKindIcon kind={report.object.kind} />
          <ObjectLine object={report.object} t={t} />
          <ReportStateBadge report={report} className="ml-auto text-sm" />
        </CardHeader>
        <CardContent>
          <h2 className="mb-2 text-sm font-medium">{t("report.findings.title")}</h2>
          {findings.length > 0 ? (
            <ReasonFindings reasons={findings} objectName={objectName(report.object)} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("report.findings.none")}</p>
          )}
        </CardContent>
      </Card>

      {details.origin === "verify" ? (
        <VerifyDetailsView
          details={details}
          format={format}
          objectLabel={objectName(report.object)}
        />
      ) : details.origin === "scrub" ? (
        <ScrubFindingView finding={details} format={format} />
      ) : (
        <Alert variant="info">
          <FileSearch />
          <AlertTitle>{t("report.unknown.title")}</AlertTitle>
          <AlertDescription>{t("report.unknown.description")}</AlertDescription>
        </Alert>
      )}

      <HistoryCard objectId={report.object.id} currentId={report.id} format={format} />
    </div>
  );
}
