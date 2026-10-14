import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import { uncoveredDataFolders } from "../folders.js";

export interface MissingDataFoldersNoticeProps {
  /** The folders a job backs up, or a restore point contains. */
  paths: readonly string[];
  /** Adds the missing folders to the job; without it the notice only says what is missing. */
  onAdd?: (folders: string[]) => void;
  /** `job`: the folders being edited; `restorePoint`: what a backup of a machine contains. */
  context?: "job" | "restorePoint";
  disabled?: boolean;
}

/**
 * Says which of the folders where Linux applications keep their data a machine
 * job leaves out (#59): /opt, /var/lib (databases), /usr/local,
 * /var/backups and the like. Nothing when all of them are covered.
 */
export function MissingDataFoldersNotice({
  paths,
  onAdd,
  context = "job",
  disabled = false,
}: MissingDataFoldersNoticeProps) {
  const { t } = useTranslation("backupjobs");
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
