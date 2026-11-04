import { Mail } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SetInInstallation } from "@/components/kit/set-in-installation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import "@/features/archive/i18n";
import { installationSectionPath } from "@/features/installation/paths";

import { useJournalHost, useJournalScope } from "./hooks";

/**
 * The journal host on the tenant page (Archive settings): the name Exchange Online
 * delivers to. It belongs to the installation, so it is shown to read with where
 * it is set; the tenant's own journal address, its rotation and the guide stay on
 * the Archive page. Rendered only where the journal receiver exists (Business and
 * up) and for the administrator of the tenant. It reads the host alone: the tenant's
 * journal address is issued only where journaling is set up (the Archive page, the job
 * editor), because an issued address brings the menu entry "Archive".
 */
export function JournalHostNote() {
  const { t } = useTranslation("archive");
  const { enabled, canManage, licensed } = useJournalScope();
  const host = useJournalHost();
  if (!enabled || !canManage || !licensed || !host.data) {
    return null;
  }
  return (
    <Card data-slot="journal-host">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail aria-hidden="true" className="size-4 text-muted-foreground" />
          {t("journal.hostNote.title")}
        </CardTitle>
        <CardDescription>{t("journal.hostNote.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="break-all font-mono text-sm">
          {host.data.hostname ?? t("journal.hostNote.none")}
        </p>
        <SetInInstallation
          to={installationSectionPath("journal")}
          sectionLabel={t("journal.hostNote.section")}
        />
      </CardContent>
    </Card>
  );
}
