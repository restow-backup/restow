import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronDown, ListChecks, ListPlus, ShieldOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EmptyState, ErrorState, PageHeader } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

import "../i18n.js";
import { JOB_KINDS, type JobKind } from "../api.js";
import { useBackupJobs } from "../hooks.js";
import { jobDefinitionTo, jobsListTo, linkProps, newJobTo } from "../paths.js";
import { describeJobSchedule, describeScope } from "../presenters.js";
import { JobsAccessNote, closedProps, useJobsAccess } from "./access-note.js";
import { JobStateBadge } from "./job-cells.js";

/**
 * The tenant's backup jobs on the tenant page (Jobs & schedules): a compact list
 * with the way into each job's page, and "New job" for either kind (it opens the
 * jobs page with the editor on a new job). The maintenance schedules follow below
 * it. In the public demo the button is closed and says why; a role that may only
 * look is told by the page's own sentence.
 */
export function TenantJobsCard() {
  const { t, i18n } = useTranslation("backupjobs");
  const { t: tSchedules } = useTranslation("schedules");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const navigate = useNavigate();
  const access = useJobsAccess();
  const query = useBackupJobs();
  const items = query.data?.items;
  const uncovered = query.data?.uncovered ?? { mail: 0, endpoint: 0 };
  const unscheduled = query.data?.unscheduled ?? { mail: 0, endpoint: 0 };
  // In no job, or in a job that does not run on a schedule: neither is backed up on its own.
  const notices = JOB_KINDS.flatMap((kind) => [
    ...((uncovered[kind] ?? 0) > 0
      ? [{ kind, key: "uncovered", count: uncovered[kind] ?? 0 }]
      : []),
    ...((unscheduled[kind] ?? 0) > 0
      ? [{ kind, key: "unscheduled", count: unscheduled[kind] ?? 0 }]
      : []),
  ]);
  // The tenant page already says why a role that may only look sees closed controls.
  const sentence = access.block === "demo";

  return (
    <section aria-label={t("tenant.title")} className="space-y-4" data-slot="tenant-jobs">
      <PageHeader
        title={t("tenant.title")}
        description={t("tenant.description")}
        icon={ListChecks}
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                disabled={access.closed}
                {...(sentence ? closedProps(access) : { title: access.reason })}
              >
                <ListPlus aria-hidden="true" />
                {t("actions.new")}
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {JOB_KINDS.map((kind) => (
                <DropdownMenuItem
                  key={kind}
                  onSelect={() => {
                    const target = newJobTo(kind);
                    void navigate({ to: target.to as never, search: target.search as never });
                  }}
                >
                  {t(`tenant.new.${kind}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      {sentence ? <JobsAccessNote access={access} /> : null}

      {notices.length > 0 ? (
        <Alert variant="warning" data-slot="tenant-uncovered">
          <ShieldOff aria-hidden="true" />
          <AlertDescription className="space-y-1">
            {notices.map(({ kind, key, count }) => (
              <p key={`${kind}-${key}`}>
                {t(`list.${key}.${kind}`, { count })}{" "}
                <Link
                  {...linkProps(jobsListTo(kind))}
                  className="rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {t("tenant.openList")}
                </Link>
              </p>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}

      {query.isError ? (
        <ErrorState
          title={t("list.loadError")}
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : items === undefined ? (
        <div aria-busy="true" className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title={t("tenant.empty.title")}
          description={t("tenant.empty.description")}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table scrollLabel={t("tenant.table")}>
            <TableHeader>
              <TableRow>
                <TableHead pin={{ ...PIN_FIRST, width: 240 }}>{t("list.columns.name")}</TableHead>
                <TableHead>{t("tenant.columns.kind")}</TableHead>
                <TableHead>{t("list.columns.scope")}</TableHead>
                <TableHead>{t("list.columns.schedule")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((job) => {
                const target = jobDefinitionTo(job.id, job.kind);
                return (
                  <TableRow key={job.id}>
                    <TableCell pin={{ ...PIN_FIRST, width: 240 }}>
                      <div className="min-w-0 space-y-1">
                        <Link
                          to={target.to}
                          search={target.search as never}
                          className="block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          title={job.name}
                        >
                          {job.name}
                        </Link>
                        <JobStateBadge state={job.state} />
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {t(`tenant.kinds.${job.kind}`)}
                    </TableCell>
                    <TableCell>{describeScope(job.scope, job.kind, t, job.copy)}</TableCell>
                    <TableCell>
                      {describeJobSchedule(job.schedule, { t, tSchedules, language })}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        {JOB_KINDS.map((kind: JobKind, index) => (
          <span key={kind}>
            {index > 0 ? " · " : null}
            <Link
              {...linkProps(jobsListTo(kind))}
              className={buttonVariants({ variant: "link", size: "sm", className: "h-auto p-0" })}
            >
              {t(`tenant.openAll.${kind}`)}
            </Link>
          </span>
        ))}
      </p>
    </section>
  );
}
