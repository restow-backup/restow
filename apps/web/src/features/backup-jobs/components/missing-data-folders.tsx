import { Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";

import { missingReportedFolders, uncoveredDataFolders } from "../folders.js";
import { jobDefinitionTo, linkProps } from "../paths.js";

/** Where Docker keeps named volumes; adding it also narrows the default exclusion of /var/lib/docker. */
const DOCKER_VOLUMES = "/var/lib/docker/volumes";

export interface MachineFolderReport {
  name: string;
  /** What the machine's agent found; null: it does not report folders (before 0.4.0). */
  folders: readonly string[] | null;
}

export interface MissingDataFoldersNoticeProps {
  /** The folders a job backs up, or a restore point contains. */
  paths: readonly string[];
  /** The job's exclusions: a folder they take out is not backed up either. */
  excludes?: readonly string[];
  /**
   * What the agents of the job's machines found (#59). When at least one machine reports, the
   * notice names the folders that are really there, with their machines; otherwise it falls back
   * to the folders where Linux applications usually keep their data.
   */
  reports?: readonly MachineFolderReport[];
  /** Adds the missing folders to the job; without it the notice only says what is missing. */
  onAdd?: (folders: string[]) => void;
  /** `job`: the folders being edited; `restorePoint`: what a backup of a machine contains. */
  context?: "job" | "restorePoint";
  disabled?: boolean;
}

/**
 * Says which folders where applications keep their data a machine job leaves out (#59). With the
 * agents' reports: the folders that exist on the machines with files in them, each with the
 * machines that have it, to add one by one or all at once. Without: /opt, /var/lib (databases),
 * /usr/local, /var/backups and the like. Nothing when all of them are covered.
 */
export function MissingDataFoldersNotice({
  paths,
  excludes = [],
  reports = [],
  onAdd,
  context = "job",
  disabled = false,
}: MissingDataFoldersNoticeProps) {
  const { t } = useTranslation("backupjobs");
  const reported = context === "job" && reports.some((report) => report.folders !== null);
  if (reported) {
    const missing = missingReportedFolders(reports, paths, excludes);
    if (missing.length === 0) {
      return null;
    }
    const folders = missing.map((entry) => entry.folder);
    return (
      <Alert variant="warning" data-slot="missing-data-folders" data-source="agents">
        <TriangleAlert />
        <AlertTitle>{t("missingFolders.reported.title")}</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{t("missingFolders.reported.description")}</p>
          <ul className="space-y-1.5">
            {missing.map((entry) => (
              <li key={entry.folder} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <code className="font-mono text-xs">{entry.folder}</code>
                <span className="min-w-0 text-muted-foreground">
                  {t("missingFolders.reported.on", { machines: entry.machines.join(", ") })}
                </span>
                {onAdd && missing.length > 1 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    disabled={disabled}
                    aria-label={t("missingFolders.reported.addOneLabel", { folder: entry.folder })}
                    onClick={() => onAdd([entry.folder])}
                  >
                    {t("missingFolders.reported.addOne")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {folders.includes(DOCKER_VOLUMES) ? <p>{t("missingFolders.docker")}</p> : null}
          {reports.length > 1 ? <p>{t("missingFolders.reported.skip")}</p> : null}
          {onAdd ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onAdd(folders)}
            >
              {t("missingFolders.add", { count: folders.length })}
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }
  const missing = uncoveredDataFolders(paths);
  if (missing.length === 0) {
    return null;
  }
  return (
    <Alert variant="warning" data-slot="missing-data-folders">
      <TriangleAlert />
      <AlertTitle>{t(`missingFolders.${context}.title`)}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          {t(`missingFolders.${context}.description`, {
            folders: missing.join(", "),
            count: missing.length,
          })}
        </p>
        {onAdd ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onAdd(missing)}
          >
            {t("missingFolders.add", { count: missing.length })}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export interface MachineDataFoldersNoticeProps {
  /** What the server says about the machine's data folders (its detail). */
  dataFolders: { missing: readonly string[]; ownFolders: boolean } | null;
  /** The machine's job; the notice says nothing for a machine in no job (that has its own notice). */
  job: { id: string; name: string } | null;
  /** Adds the missing folders to the job; absent when the viewer may not change jobs. */
  onAdd?: (folders: string[]) => void;
  pending?: boolean;
  /** Why the button is closed (public demo, a role that may only look). */
  closedReason?: string;
  className?: string;
}

/**
 * On a machine's page: the folders with data the machine's agent found that its job does not back
 * up (#59), with "add to job". A machine with folders of its own in the job is sent to the job.
 */
export function MachineDataFoldersNotice({
  dataFolders,
  job,
  onAdd,
  pending = false,
  closedReason,
  className,
}: MachineDataFoldersNoticeProps) {
  const { t } = useTranslation("backupjobs");
  if (!job || !dataFolders || dataFolders.missing.length === 0) {
    return null;
  }
  const missing = [...dataFolders.missing];
  return (
    <Alert
      variant="warning"
      data-slot="machine-data-folders"
      className={className}
      aria-busy={pending || undefined}
    >
      <TriangleAlert />
      <AlertTitle>{t("missingFolders.machine.title")}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          {t("missingFolders.machine.description", {
            job: job.name,
            folders: missing.join(", "),
            count: missing.length,
          })}
        </p>
        {missing.includes(DOCKER_VOLUMES) && !dataFolders.ownFolders ? (
          <p>{t("missingFolders.docker")}</p>
        ) : null}
        {dataFolders.ownFolders ? (
          <p>{t("missingFolders.machine.ownFolders")}</p>
        ) : onAdd ? (
          <p>{t("missingFolders.machine.others")}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {onAdd && !dataFolders.ownFolders ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending || closedReason !== undefined}
              title={closedReason}
              onClick={() => onAdd(missing)}
            >
              {t("missingFolders.machine.add", { count: missing.length })}
            </Button>
          ) : null}
          <Link
            {...linkProps(jobDefinitionTo(job.id, "endpoint"))}
            className={buttonVariants({ size: "sm", variant: "ghost" })}
          >
            {t("missingFolders.machine.openJob")}
          </Link>
        </div>
      </AlertDescription>
    </Alert>
  );
}
