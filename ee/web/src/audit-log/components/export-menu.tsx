import { Download } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { downloadFile } from "@/features/stats/download";
import { errorMessageKey } from "@/lib/api";

import { type AuditQuery, auditExportPath } from "../api";

/**
 * Export of the filtered log for an auditor: CSV for a spreadsheet, JSON with every hashed
 * field, oldest first, to check the chain outside {appName}. The export is itself recorded in
 * the audit log.
 */
export function AuditExportMenu({ query }: { query: AuditQuery }) {
  const { t } = useTranslation("audit");
  const { t: tc } = useTranslation("common");
  const [running, setRunning] = React.useState(false);

  async function run(format: "csv" | "json") {
    setRunning(true);
    const toastId = toast.loading(t("export.preparing"));
    try {
      const filename = await downloadFile({
        path: auditExportPath(query, format),
        accept: format === "csv" ? "text/csv" : "application/json",
        fallbackName: `audit-log.${format}`,
      });
      toast.success(t("export.done"), { id: toastId, description: filename });
    } catch (error) {
      toast.error(t("export.failed"), { id: toastId, description: tc(errorMessageKey(error)) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" loading={running} data-slot="audit-export">
          <Download aria-hidden="true" />
          {t("export.action")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void run("csv")}>{t("export.csv")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("json")}>{t("export.json")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
