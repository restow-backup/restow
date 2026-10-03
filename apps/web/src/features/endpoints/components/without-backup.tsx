import { Link } from "@tanstack/react-router";
import { ListChecks, ListPlus, ShieldOff } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { HintTooltip, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { JOB_ROLES } from "@/features/backup-jobs/access";
import { closedProps, useJobsAccess } from "@/features/backup-jobs/components/access-note";
import { jobDefinitionTo, linkProps, newJobTo } from "@/features/backup-jobs/paths";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import type { EndpointSummary } from "../api.js";
import { endpointName, isWithoutBackup } from "../presenters.js";
import { AddToJobDialog, type JobCandidate } from "./add-to-job-dialog.js";

/**
 * A machine in no backup job is not backed up (release 0.2.1). These pieces show that state the
 * same way everywhere (the inventory, the machine's page, its settings) and offer the two ways
 * out to the people who may manage jobs: a new job with the machine in it, or an existing job.
 */

/** Whether a role may manage backup jobs (the job pages' roles). */
export function canManageJobs(role: string | null | undefined): boolean {
  return typeof role === "string" && (JOB_ROLES as readonly string[]).includes(role);
}

/** Whether the viewer may manage backup jobs, in the active tenant. */
export function useCanManageJobs(): boolean {
  return canManageJobs(useSession().role);
}

/** The warning badge of a machine without backup. */
export function WithoutBackupBadge({ className }: { className?: string }) {
  const { t } = useTranslation("endpoints");
  return (
    <HintTooltip content={t("noJob.hint")}>
      <StatusBadge
        tone="warning"
        icon={ShieldOff}
        tabIndex={0}
        className={cn("whitespace-nowrap", className)}
        data-slot="without-backup"
      >
        {t("noJob.badge")}
      </StatusBadge>
    </HintTooltip>
  );
}

/** The job a machine is in, as a link to it; the warning badge when it is in none. */
export function JobCell({ endpoint }: { endpoint: Pick<EndpointSummary, "status" | "job"> }) {
  if (endpoint.job) {
    return (
      <Link
        {...linkProps(jobDefinitionTo(endpoint.job.id, "endpoint"))}
        className="block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
        title={endpoint.job.name}
      >
        {endpoint.job.name}
      </Link>
    );
  }
  return isWithoutBackup(endpoint) ? <WithoutBackupBadge /> : null;
}

/**
 * "Create job" (the job editor with the machines chosen) and "Add to job" (the dialog). Closed
 * the same way as the job pages' controls (public demo, a role that may only look), with the
 * reason as a tooltip.
 */
export function NoJobActions({
  endpoints,
  size = "sm",
  className,
}: {
  endpoints: readonly JobCandidate[];
  size?: "sm" | "default";
  className?: string;
}) {
  const { t } = useTranslation("endpoints");
  const access = useJobsAccess();
  const [adding, setAdding] = React.useState(false);
  const ids = endpoints.map((endpoint) => endpoint.id);
  return (
    <div className={cn("flex flex-wrap gap-2", className)} data-slot="no-job-actions">
      {access.closed ? (
        <Button size={size} disabled {...closedProps(access)}>
          <ListPlus aria-hidden="true" />
          {t("noJob.createJob")}
        </Button>
      ) : (
        <Link {...linkProps(newJobTo("endpoint", ids))} className={buttonVariants({ size })}>
          <ListPlus aria-hidden="true" />
          {t("noJob.createJob")}
        </Link>
      )}
      <Button
        size={size}
        variant="outline"
        onClick={() => setAdding(true)}
        disabled={access.closed}
        {...closedProps(access)}
      >
        <ListChecks aria-hidden="true" />
        {t("noJob.addToJob")}
      </Button>
      {/* Mounted once asked for: the dialog loads the jobs only then. */}
      {adding ? <AddToJobDialog open onOpenChange={setAdding} endpoints={endpoints} /> : null}
    </div>
  );
}

/**
 * The state on the machine's page and in its settings: nothing backs this machine up, and what
 * to do about it. A machine of an earlier release that still runs the schedule it had says so.
 */
export function WithoutBackupNotice({
  endpoint,
  className,
}: {
  endpoint: Pick<EndpointSummary, "id" | "displayName" | "hostname" | "status" | "job"> & {
    config?: { schedule: { kind: string } };
  };
  className?: string;
}) {
  const { t } = useTranslation("endpoints");
  const canManage = useCanManageJobs();
  if (!isWithoutBackup(endpoint)) {
    return null;
  }
  const legacy = endpoint.config !== undefined && endpoint.config.schedule.kind !== "none";
  return (
    <Alert variant="warning" className={className} data-slot="without-backup-notice">
      <ShieldOff aria-hidden="true" />
      <AlertTitle>{t("noJob.title")}</AlertTitle>
      <AlertDescription>
        <p>{t(legacy ? "noJob.descriptionLegacy" : "noJob.description")}</p>
        {canManage ? (
          <NoJobActions
            endpoints={[{ id: endpoint.id, name: endpointName(endpoint) }]}
            className="mt-2"
          />
        ) : (
          <p>{t("noJob.askAdmin")}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** The inventory's notice: how many machines are without backup, with the same two ways out. */
export function WithoutBackupBanner({
  items,
}: {
  items: readonly Pick<EndpointSummary, "id" | "displayName" | "hostname" | "status" | "job">[];
}) {
  const { t } = useTranslation("endpoints");
  const canManage = useCanManageJobs();
  const without = items.filter(isWithoutBackup);
  if (without.length === 0) {
    return null;
  }
  return (
    <Alert variant="warning" data-slot="without-backup-banner">
      <ShieldOff aria-hidden="true" />
      <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span>{t("noJob.banner", { count: without.length })}</span>
        {canManage ? (
          <NoJobActions
            endpoints={without.map((endpoint) => ({
              id: endpoint.id,
              name: endpointName(endpoint),
            }))}
            className="shrink-0"
          />
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
