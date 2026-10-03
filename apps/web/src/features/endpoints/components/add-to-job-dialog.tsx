import { Link } from "@tanstack/react-router";
import { ListPlus, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/sonner";
import {
  JobsAccessNote,
  closedProps,
  useJobsAccess,
} from "@/features/backup-jobs/components/access-note";
import { useAddJobMembers, useBackupJobs } from "@/features/backup-jobs/hooks";
import { linkProps, newJobTo } from "@/features/backup-jobs/paths";
import { type MemberConflict, conflictsOf, jobErrorKey } from "@/features/backup-jobs/problems";
import { cn } from "@/lib/utils";

/** A machine the dialog adds: its id and the name the lists show. */
export interface JobCandidate {
  id: string;
  name: string;
}

export interface AddToJobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The machines to add (one from a row, or every machine without backup from the banner). */
  endpoints: readonly JobCandidate[];
}

/**
 * "Add to job" for machines that are in no backup job (release 0.2.1: a machine in no job is not
 * backed up). It lists the machine jobs and adds the machines to the one chosen; the job's
 * schedule and settings reach each machine with its next contact. A machine another
 * administrator put into a job meanwhile is moved only after "Move here", as in the job's own
 * "Add" sheet.
 */
export function AddToJobDialog({ open, onOpenChange, endpoints }: AddToJobDialogProps) {
  const { t } = useTranslation("endpoints");
  const access = useJobsAccess();
  const jobs = useBackupJobs("endpoint");
  const items = jobs.data?.items ?? [];
  const [jobId, setJobId] = React.useState<string>("");
  const [conflicts, setConflicts] = React.useState<MemberConflict[] | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const add = useAddJobMembers(jobId);
  const chosen = items.find((job) => job.id === jobId) ?? null;

  // Every opening starts with nothing chosen.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setJobId("");
      setConflicts(null);
      setError(null);
    }
  }

  const count = endpoints.length;
  const subject = count === 1 ? (endpoints[0]?.name ?? "") : "";

  const submit = async (move: boolean): Promise<void> => {
    if (!chosen) {
      return;
    }
    setError(null);
    try {
      await add.mutateAsync({
        members: endpoints.map((endpoint) => ({ id: endpoint.id })),
        ...(move ? { move: true } : {}),
      });
      toast.success(t("addToJob.added", { count, job: chosen.name, name: subject }), {
        description: t("addToJob.addedNote"),
      });
      onOpenChange(false);
    } catch (failure) {
      const taken = conflictsOf(failure);
      if (taken && taken.length > 0) {
        setConflicts(taken);
      } else {
        setError(failure);
      }
    }
  };

  const moving = conflicts !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="add-to-job-dialog">
        <DialogHeader>
          <DialogTitle>{t("addToJob.title", { count })}</DialogTitle>
          <DialogDescription>
            {t("addToJob.description", { count, name: subject })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            // The dialog may open from inside another form (the settings tab): its submit stays here.
            event.stopPropagation();
            if (chosen && !access.closed) {
              void submit(moving);
            }
          }}
        >
          <JobsAccessNote access={access} />
          {jobs.isPending ? (
            <p className="text-sm text-muted-foreground">{t("addToJob.loading")}</p>
          ) : jobs.isError ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{t(jobErrorKey(jobs.error))}</AlertDescription>
            </Alert>
          ) : items.length === 0 ? (
            <div className="grid gap-3" data-slot="add-to-job-empty">
              <p className="text-sm text-muted-foreground">{t("addToJob.noJobs")}</p>
              <Link
                {...linkProps(
                  newJobTo(
                    "endpoint",
                    endpoints.map((endpoint) => endpoint.id),
                  ),
                )}
                className={buttonVariants({ variant: "outline", size: "sm", className: "w-fit" })}
              >
                <ListPlus aria-hidden="true" />
                {t("noJob.createJob")}
              </Link>
            </div>
          ) : (
            <fieldset className="m-0 grid gap-2 border-0 p-0">
              <legend className="mb-2 text-sm font-medium">{t("addToJob.label")}</legend>
              <RadioGroup
                value={jobId}
                onValueChange={(value) => {
                  setJobId(value);
                  setConflicts(null);
                  setError(null);
                }}
                className="grid gap-2"
                aria-label={t("addToJob.label")}
                disabled={access.closed}
              >
                {items.map((job) => {
                  const id = `add-to-job-${job.id}`;
                  return (
                    <Label
                      key={job.id}
                      htmlFor={id}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors",
                        jobId === job.id && "border-primary bg-primary/5",
                      )}
                    >
                      <RadioGroupItem value={job.id} id={id} className="mt-1" />
                      <span className="min-w-0 space-y-0.5">
                        <span className="block truncate text-sm font-medium">{job.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t("addToJob.machines", { count: job.scope.count })}
                        </span>
                      </span>
                    </Label>
                  );
                })}
              </RadioGroup>
            </fieldset>
          )}
          {moving ? (
            <Alert variant="warning" data-slot="add-to-job-conflict">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>
                {t("addToJob.conflict", {
                  count: conflicts.length,
                  job: conflicts[0]?.jobName ?? "",
                })}
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{t(jobErrorKey(error))}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={add.isPending}
            >
              {t("addToJob.cancel")}
            </Button>
            {items.length > 0 ? (
              <Button
                type="submit"
                loading={add.isPending}
                disabled={access.closed || chosen === null}
                {...closedProps(access)}
              >
                {moving ? t("addToJob.move") : t("addToJob.submit")}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
