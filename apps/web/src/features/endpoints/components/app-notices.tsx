import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

import type { RunNotice } from "../api.js";
import { APP_SUBJECTS, NOTICE_CODES } from "../presenters.js";

/**
 * The fixed warnings of a Windows machine (docs/BAREMETAL-WINDOWS.md 0 and 6.5) and of a run: the
 * files of open databases in a file backup are no restorable backup of SQL Server, Exchange,
 * Active Directory or the virtual machines of a Hyper-V host; a database whose log keeps growing;
 * a TDE certificate to back up elsewhere; a SQL Server version that was not checked. The machine
 * page shows the machine's own; the run sheet those of the run.
 */
export function AppNotices({
  notices,
  className,
}: {
  notices: readonly RunNotice[] | undefined;
  className?: string;
}) {
  const { t } = useTranslation("endpoints");
  if (!notices || notices.length === 0) {
    return null;
  }
  return (
    <div className={cn("space-y-3", className)} data-slot="app-notices">
      {notices.map((notice) => {
        const known = (NOTICE_CODES as readonly string[]).includes(notice.code);
        const subjects = notice.subjects ?? [];
        const apps =
          notice.code === "app_files_not_app_backup"
            ? subjects
                .filter((subject) => (APP_SUBJECTS as readonly string[]).includes(subject))
                .map((subject) => t(`notices.apps.${subject}`))
                .join(", ")
            : subjects.join(", ");
        return (
          <Alert
            key={`${notice.code}-${subjects.join(",")}-${notice.message ?? ""}`}
            variant="warning"
            data-notice={notice.code}
          >
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>
              {known ? t(`notices.${notice.code}.title`) : t("notices.other.title")}
            </AlertTitle>
            <AlertDescription>
              <p>
                {known
                  ? t(`notices.${notice.code}.body`, { subjects: apps })
                  : (notice.message ?? notice.code)}
              </p>
              {notice.code === "app_files_not_app_backup" && subjects.includes("sql_server") ? (
                <p>{t("notices.app_files_not_app_backup.sqlHint")}</p>
              ) : null}
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}
