import { ArchiveRestore, Download, FileDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { type Selection, countSelection } from "@/features/restore/lib/selection";
import { formatBytes } from "@/lib/format";

/** What is ticked, across folders, and what can be done with it. Stays in view while scrolling. */
export function SelectionBar({
  selection,
  onClear,
  onRestore,
  onDownload,
  onExport,
}: {
  selection: Selection;
  onClear: () => void;
  onRestore: () => void;
  onDownload: () => void;
  /** Opens the export dialog; left out where mail cannot be exported (OneDrive). */
  onExport?: () => void;
}) {
  const { t, i18n } = useTranslation("restore");
  const { t: tExports } = useTranslation("exports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const counts = countSelection(selection);
  const details = [
    counts.folders > 0 ? t("explorer.selection.folders", { count: counts.folders }) : null,
    counts.items > 0 ? t("explorer.selection.items", { count: counts.items }) : null,
    counts.bytes > 0 ? formatBytes(counts.bytes, language) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section
      aria-label={t("explorer.selection.region")}
      className="sticky bottom-4 z-20 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-background/95 px-4 py-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <div className="min-w-0 flex-1" aria-live="polite">
        <p className="text-sm font-medium">
          {t("explorer.selection.count", { count: counts.total })}
        </p>
        <p className="truncate text-xs text-muted-foreground">{details}</p>
      </div>
      <Button variant="ghost" size="sm" onClick={onClear}>
        {t("explorer.selection.clear")}
      </Button>
      {onExport ? (
        <Button variant="outline" size="sm" onClick={onExport}>
          <FileDown />
          {tExports("action.export")}
        </Button>
      ) : null}
      <Button variant="outline" size="sm" onClick={onDownload}>
        <Download />
        {t("explorer.actions.download")}
      </Button>
      <Button size="sm" onClick={onRestore}>
        <ArchiveRestore />
        {t("explorer.actions.restore")}
      </Button>
    </section>
  );
}
