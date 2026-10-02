import { Archive, Info } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, formatInteger } from "@/lib/format";
import { cn } from "@/lib/utils";
import { FormatBadge } from "../components/format-badge";
import { noteKey, shortHash } from "../presenters";
import type {
  ImportArchiveReport,
  ImportDetail,
  ImportFileReport,
  ImportFileStatus,
  ImportReport,
} from "../types";

type StatTone = "destructive" | "warning";

function Stat({ label, value, tone }: { label: string; value: string; tone?: StatTone }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "destructive" && "text-destructive",
          tone === "warning" && "text-warning-foreground dark:text-warning",
        )}
      >
        {value}
      </p>
    </div>
  );
}

/** The final numbers of an import as tiles; problems get their own tone. */
export function ReportCards({ report }: { report: ImportReport }) {
  const { t, i18n } = useTranslation("imports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const number = (value: number) => formatInteger(value, language);
  const { totals } = report;
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
      data-testid="report-cards"
    >
      <Stat label={t("report.messages")} value={number(totals.messages)} />
      <Stat label={t("report.folders")} value={number(totals.folders)} />
      <Stat label={t("report.attachments")} value={number(totals.attachments)} />
      <Stat label={t("report.duplicates")} value={number(totals.duplicates)} />
      <Stat
        label={t("report.failed")}
        value={number(totals.failed)}
        tone={totals.failed > 0 ? "destructive" : undefined}
      />
      <Stat
        label={t("report.skipped")}
        value={number(totals.skipped)}
        tone={totals.skipped > 0 ? "warning" : undefined}
      />
      <Stat label={t("report.bytes")} value={formatBytes(totals.messageBytes, language)} />
      <Stat label={t("report.rebuilt")} value={number(totals.synthesizedMessages)} />
    </div>
  );
}

/** Known limits of this import in plain sentences; a code this version does not know gets a generic sentence naming the code. */
export function NotesAlert({ notes }: { notes: readonly string[] }) {
  const { t } = useTranslation("imports");
  if (notes.length === 0) {
    return null;
  }
  return (
    <Alert variant="info" data-testid="report-notes">
      <Info />
      <AlertTitle>{t("notes.title")}</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {notes.map((note) => {
            const key = noteKey(note);
            return <li key={note}>{key ? t(key) : t("notes.other", { code: note })}</li>;
          })}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** What happened when the messages were also handed to the archive. */
export function ArchiveCard({
  requested,
  archive,
  live,
}: {
  requested: boolean;
  archive: ImportArchiveReport | null;
  live: boolean;
}) {
  const { t, i18n } = useTranslation("imports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const number = (value: number) => formatInteger(value, language);
  if (!requested) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Archive aria-hidden="true" className="size-4 text-muted-foreground" />
          {t("archive.title")}
        </CardTitle>
        <CardDescription>{t("archive.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {archive ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label={t("archive.ingested")} value={number(archive.ingested)} />
            <Stat label={t("archive.already")} value={number(archive.alreadyArchived)} />
            <Stat
              label={t("archive.failed")}
              value={number(archive.failed)}
              tone={archive.failed > 0 ? "destructive" : undefined}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t(live ? "archive.pending" : "archive.none")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// A file that was imported is done, not proven: the outline, never green.
const FILE_STATUS_TONE: Record<ImportFileStatus, BadgeProps["variant"]> = {
  imported: "outline",
  partial: "warning",
  failed: "destructive",
  refused: "warning",
};

/** Per file: what it was and how many messages, folders and attachments came out of it. */
export function FilesCard({ detail }: { detail: ImportDetail }) {
  const { t, i18n } = useTranslation("imports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const number = (value: number) => formatInteger(value, language);
  const report = detail.report;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">{t("files.table.title")}</CardTitle>
        <CardDescription>{t("files.table.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {report ? (
          <Table className="min-w-[56rem]" scrollLabel={t("files.table.title")}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead pin={PIN_FIRST}>{t("files.table.file")}</TableHead>
                <TableHead>{t("files.table.status")}</TableHead>
                <TableHead className="text-right whitespace-nowrap">
                  {t("files.table.messages")}
                </TableHead>
                <TableHead className="text-right whitespace-nowrap">
                  {t("files.table.folders")}
                </TableHead>
                <TableHead className="text-right whitespace-nowrap">
                  {t("files.table.attachments")}
                </TableHead>
                <TableHead className="text-right whitespace-nowrap">
                  {t("files.table.duplicates")}
                </TableHead>
                <TableHead className="text-right whitespace-nowrap">
                  {t("files.table.skipped")}
                </TableHead>
                <TableHead className="text-right whitespace-nowrap">
                  {t("files.table.failed")}
                </TableHead>
                <TableHead>{t("files.table.sha256")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.files.map((file) => (
                <ReportFileRow key={file.path} file={file} language={language} number={number} />
              ))}
            </TableBody>
          </Table>
        ) : detail.files.length > 0 ? (
          <Table scrollLabel={t("files.table.title")}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead pin={PIN_FIRST}>{t("files.table.file")}</TableHead>
                <TableHead>{t("files.table.format")}</TableHead>
                <TableHead className="text-right">{t("files.table.size")}</TableHead>
                <TableHead>{t("files.table.origin")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.files.map((file) => (
                <TableRow key={`${file.origin}:${file.path}`}>
                  <TableCell pin={PIN_FIRST} className="max-w-0 min-w-40">
                    <p className="truncate font-mono text-xs" title={file.path}>
                      {file.path}
                    </p>
                  </TableCell>
                  <TableCell>{file.format ? <FormatBadge format={file.format} /> : null}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatBytes(file.size, language)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {t(`files.table.origins.${file.origin}`)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">{t("files.table.none")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function ReportFileRow({
  file,
  language,
  number,
}: {
  file: ImportFileReport;
  language: string;
  number: (value: number) => string;
}) {
  const { t } = useTranslation("imports");
  const hash = shortHash(file.sha256);
  return (
    <TableRow>
      <TableCell pin={PIN_FIRST} className="max-w-0 min-w-44">
        <p className="truncate font-mono text-xs font-medium" title={file.path}>
          {file.path}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <FormatBadge format={file.format} />
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatBytes(file.size, language)}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={FILE_STATUS_TONE[file.status]}>{t(`files.status.${file.status}`)}</Badge>
      </TableCell>
      <TableCell className="text-right tabular-nums">{number(file.messages)}</TableCell>
      <TableCell className="text-right tabular-nums">{number(file.folders)}</TableCell>
      <TableCell className="text-right tabular-nums">{number(file.attachments)}</TableCell>
      <TableCell className="text-right tabular-nums">{number(file.duplicates)}</TableCell>
      <TableCell className="text-right tabular-nums">{number(file.skipped)}</TableCell>
      <TableCell
        className={cn("text-right tabular-nums", file.failed > 0 && "font-medium text-destructive")}
      >
        {number(file.failed)}
      </TableCell>
      <TableCell className="font-mono text-xs whitespace-nowrap" title={file.sha256 ?? undefined}>
        {hash ?? t("files.table.noHash")}
      </TableCell>
    </TableRow>
  );
}
