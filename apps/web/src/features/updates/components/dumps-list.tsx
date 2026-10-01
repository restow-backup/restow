import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/components/kit/relative-time";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes } from "@/lib/format";

import type { DumpInfo } from "../api";

/** The database backups the updater keeps (one is taken before every update). */
export function DumpsList({ dumps }: { dumps: readonly DumpInfo[] }) {
  const { t, i18n } = useTranslation("updates");
  const language = i18n.resolvedLanguage ?? i18n.language;

  return (
    <section className="space-y-2" data-slot="dumps">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("dumps.title")}</h3>
        <p className="text-sm text-muted-foreground">{t("dumps.description")}</p>
      </div>
      {dumps.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-slot="dumps-empty">
          {t("dumps.empty")}
        </p>
      ) : (
        <div className="rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("dumps.file")}</TableHead>
                <TableHead className="text-right">{t("dumps.size")}</TableHead>
                <TableHead className="text-right">{t("dumps.created")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dumps.map((dump) => (
                <TableRow key={dump.file}>
                  <TableCell className="font-mono text-xs [overflow-wrap:anywhere]">
                    {dump.file}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatBytes(dump.bytes, language)}
                  </TableCell>
                  <TableCell className="text-right">
                    <RelativeTime value={dump.createdAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
