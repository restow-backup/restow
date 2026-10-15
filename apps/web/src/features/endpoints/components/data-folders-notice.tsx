import { useTranslation } from "react-i18next";
import { toast } from "@/components/ui/sonner";
import { useJobsAccess } from "@/features/backup-jobs/components/access-note";
import { MachineDataFoldersNotice } from "@/features/backup-jobs/components/missing-data-folders";
import { useAddDataFolders } from "@/features/backup-jobs/hooks";

import type { EndpointDetail } from "../api.js";
import { endpointErrorKey } from "../presenters.js";
import { useCanManageJobs } from "./without-backup.js";

/**
 * The machine's page: folders with data its agent found that its job leaves out (#59), with "add
 * to job" for who may change jobs. Nothing for an agent that does not report folders.
 */
export function EndpointDataFoldersNotice({
  detail,
  className,
}: {
  detail: Pick<EndpointDetail, "status" | "job" | "dataFolders">;
  className?: string;
}) {
  const { t: tJobs } = useTranslation("backupjobs");
  const { t: tEndpoints } = useTranslation("endpoints");
  const canManage = useCanManageJobs();
  const access = useJobsAccess();
  const add = useAddDataFolders();
  if (detail.status !== "active") {
    return null;
  }
  const job = detail.job ?? null;
  return (
    <MachineDataFoldersNotice
      className={className}
      job={job}
      dataFolders={detail.dataFolders}
      pending={add.isPending}
      closedReason={access.reason}
      onAdd={
        canManage && job
          ? (folders) =>
              add.mutate(
                { jobId: job.id, folders },
                {
                  onSuccess: () =>
                    toast.success(
                      tJobs("missingFolders.machine.added", {
                        count: folders.length,
                        job: job.name,
                      }),
                    ),
                  onError: (error) =>
                    toast.error(tJobs("missingFolders.machine.failed"), {
                      description: tEndpoints(endpointErrorKey(error)),
                    }),
                },
              )
          : undefined
      }
    />
  );
}
