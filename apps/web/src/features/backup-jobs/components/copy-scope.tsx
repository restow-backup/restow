import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";
import { Card, CardContent } from "@/components/ui/card";
import { fileShareTo, linkTo } from "@/features/file-shares/paths";
import { formatDateTime } from "@/lib/format";

import type { BackupJob } from "../api.js";

/**
 * What a copy job copies (docs/FILESHARES.md 12.6): from which share into which share and
 * folder, overwrite or mirror, and the restore point it copied last. A copy job has no members.
 */
export function CopyScope({ job }: { job: BackupJob }) {
  const { t, i18n } = useTranslation("backupjobs");
  const copy = job.copy;
  if (!copy) {
    return <p className="text-sm text-muted-foreground">{t("scope.nothing")}</p>;
  }
  return (
    <Card data-slot="copy-scope">
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Link {...linkTo(fileShareTo(copy.source.id))} className="font-medium hover:underline">
            {copy.source.name}
          </Link>
          <ArrowRight className="size-4 text-muted-foreground" aria-label={t("copyEditor.into")} />
          <Link {...linkTo(fileShareTo(copy.target.id))} className="font-medium hover:underline">
            {copy.target.name}
          </Link>
          <span className="font-mono text-xs text-muted-foreground">/{copy.targetFolder}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusBadge tone="warning" icon>
            {t("copyEditor.notBackup")}
          </StatusBadge>
          <StatusBadge tone={copy.mode === "mirror" ? "warning" : "neutral"}>
            {t(`copyEditor.mode.${copy.mode}.label`)}
          </StatusBadge>
          {copy.source.retired || copy.target.retired ? (
            <StatusBadge tone="destructive" icon>
              {t("copyEditor.retired")}
            </StatusBadge>
          ) : null}
          {!copy.target.allowRestore ? (
            <StatusBadge tone="destructive" icon>
              {t("copyEditor.rules.restore_not_allowed")}
            </StatusBadge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground" data-slot="last-copied">
          {copy.lastCopied?.at
            ? t("copyEditor.lastCopied", {
                when: formatDateTime(copy.lastCopied.at, i18n.language),
              })
            : t("copyEditor.neverCopied")}
        </p>
      </CardContent>
    </Card>
  );
}
