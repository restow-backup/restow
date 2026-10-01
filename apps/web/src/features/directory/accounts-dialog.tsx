import { FileUp, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { messageId } from "@/components/forms/field";
import { PasswordInput } from "@/components/forms/password-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessageKey } from "@/lib/api";

import { useImportAccounts } from "./hooks";
import { Textarea } from "./textarea";
import type { AccountIssue, CsvImportOutcome, DirectorySource } from "./types";

/** Largest file the dialog reads; the API accepts 2 MB of CSV text. */
const MAX_FILE_BYTES = 2_000_000;

/** Quote a CSV field only when it needs it (RFC 4180: a comma, semicolon, tab, quote or newline). */
function csvField(value: string): string {
  return /[,;\t"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Header labels the CSV import recognises (mirrors `HEADER_ALIASES` in
 * packages/core/src/directory/csv.ts, kept small and in sync here rather
 * than importing across the package boundary for one check).
 */
const HEADER_LABELS = new Set([
  "login",
  "username",
  "user",
  "account",
  "email",
  "e-mail",
  "mail",
  "address",
  "name",
  "displayname",
  "display name",
  "password",
  "pass",
  "pwd",
]);

/**
 * Whether the box holds exactly one account entered positionally: a single
 * line with at most the three no-header columns `login[, name[, email]]`
 * (docs/IMAP.md, `accounts.format`). Only then does the standalone password
 * field below it (per_mailbox sources only) apply; more than three columns,
 * or a cell that names a recognised header, means several accounts or an
 * already-CSV-shaped paste, which keep using the header row's own
 * `password` column instead.
 */
export function isSingleLoginEntry(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) {
    return false;
  }
  const line = lines[0] as string;
  const delimiter = ([",", ";", "\t"] as const).reduce((best, candidate) =>
    line.split(candidate).length > line.split(best).length ? candidate : best,
  );
  const fields = line.split(delimiter).map((field) => field.trim());
  if (fields.length > 3) {
    return false;
  }
  return !fields.some((field) => HEADER_LABELS.has(field.toLowerCase()));
}

interface AccountsDialogProps {
  source: DirectorySource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Add IMAP accounts: paste logins or CSV lines, or load a CSV file, check
 * the list (a dry run on the server, which also tells new from existing
 * logins) and add it. Adding is only possible for the list that was checked.
 */
export function AccountsDialog({ source, open, onOpenChange }: AccountsDialogProps) {
  const { t } = useTranslation("directory");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>{t("accounts.title")}</DialogTitle>
          <DialogDescription>
            {t("accounts.description", { source: source.name })}
          </DialogDescription>
        </DialogHeader>
        {open ? <AccountsForm source={source} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AccountsForm({ source, onDone }: { source: DirectorySource; onDone: () => void }) {
  const { t } = useTranslation("directory");
  const { t: tc } = useTranslation();
  const importAccounts = useImportAccounts();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [text, setText] = React.useState("");
  const [singlePassword, setSinglePassword] = React.useState("");
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<{
    text: string;
    password: string;
    outcome: CsvImportOutcome;
  } | null>(null);

  // Only a per_mailbox source has a password of its own to set here at all
  // (docs/IMAP.md); the standalone field only makes sense while the box
  // holds exactly one bare login, otherwise a CSV header's own `password`
  // column is how several accounts each get their own.
  const offerSinglePassword = source.imapAuthMode === "per_mailbox" && isSingleLoginEntry(text);
  // What actually gets sent: the box as typed, or, with a single login and a
  // password entered for it, that login and password as a one-row CSV.
  const payload =
    offerSinglePassword && singlePassword.length > 0
      ? `login,password\n${csvField(text.trim())},${csvField(singlePassword)}`
      : text;

  const current =
    preview !== null && preview.text === text && preview.password === singlePassword
      ? preview.outcome
      : null;
  const addable = current ? current.created + current.existing : 0;

  const run = async (dryRun: boolean) => {
    try {
      const outcome = await importAccounts.mutateAsync({
        sourceId: source.id,
        csv: payload,
        dryRun,
      });
      if (dryRun) {
        setPreview({ text, password: singlePassword, outcome });
        return;
      }
      toast.success(t("accounts.done", { created: outcome.created }));
      onDone();
    } catch (error) {
      toast.error(t("accounts.failed"), { description: tc(errorMessageKey(error)) });
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      toast.error(t("accounts.fileError"));
      return;
    }
    try {
      setText(await file.text());
      setFileName(file.name);
      setPreview(null);
    } catch {
      toast.error(t("accounts.fileError"));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="accounts-text">{t("accounts.text")}</Label>
            <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
              <FileUp />
              {t("accounts.file")}
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={(event) => {
                void loadFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
          <Textarea
            id="accounts-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("accounts.placeholder")}
            aria-describedby={messageId("accounts-text")}
            rows={7}
            spellCheck={false}
            className="font-mono text-xs"
          />
          <p id={messageId("accounts-text")} className="text-xs text-muted-foreground">
            {fileName ? `${t("accounts.fileLoaded", { name: fileName })} ` : null}
            {t("accounts.format")}{" "}
            {source.imapAuthMode === "per_mailbox"
              ? t("accounts.passwordColumnHint")
              : t("accounts.passwordColumnIgnoredHint")}
          </p>
        </div>

        {offerSinglePassword ? (
          <div className="space-y-1.5">
            <Label htmlFor="accounts-single-password">{t("accounts.singlePassword.label")}</Label>
            <PasswordInput
              id="accounts-single-password"
              autoComplete="new-password"
              value={singlePassword}
              onChange={(event) => setSinglePassword(event.target.value)}
              aria-describedby={messageId("accounts-single-password")}
            />
            <p id={messageId("accounts-single-password")} className="text-xs text-muted-foreground">
              {t("accounts.singlePassword.hint")}
            </p>
          </div>
        ) : null}

        {current ? <PreviewResult outcome={current} /> : null}
        {!current && text.trim().length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("accounts.empty")}</p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={importAccounts.isPending}>
          {tc("actions.cancel")}
        </Button>
        {current && addable > 0 ? (
          <Button onClick={() => void run(false)} loading={importAccounts.isPending}>
            {t("accounts.add", { count: addable })}
          </Button>
        ) : (
          <Button
            onClick={() => void run(true)}
            loading={importAccounts.isPending}
            disabled={text.trim().length === 0 || current !== null}
          >
            {t("accounts.check")}
          </Button>
        )}
      </DialogFooter>
    </div>
  );
}

function PreviewResult({ outcome }: { outcome: CsvImportOutcome }) {
  const { t } = useTranslation("directory");
  return (
    <div className="space-y-3">
      {outcome.accounts.length === 0 ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertDescription>{t("accounts.nothing")}</AlertDescription>
        </Alert>
      ) : (
        <>
          <p className="text-sm" aria-live="polite">
            {t("accounts.summary", { created: outcome.created, existing: outcome.existing })}
          </p>
          <div className="max-h-56 overflow-y-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t("accounts.columns.login")}</TableHead>
                  <TableHead className="hidden sm:table-cell">
                    {t("accounts.columns.displayName")}
                  </TableHead>
                  <TableHead className="hidden sm:table-cell">
                    {t("accounts.columns.email")}
                  </TableHead>
                  <TableHead className="hidden sm:table-cell">
                    {t("accounts.columns.password")}
                  </TableHead>
                  <TableHead>{t("accounts.columns.state")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outcome.accounts.map((account) => (
                  <TableRow key={account.login}>
                    <TableCell className="font-mono text-xs">{account.login}</TableCell>
                    <TableCell className="hidden sm:table-cell">{account.displayName}</TableCell>
                    <TableCell className="hidden sm:table-cell">{account.email}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {account.hasPassword ? (
                        <Badge variant="outline">{t("accounts.columns.passwordSet")}</Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={account.state === "new" ? "info" : "muted"}>
                        {t(`accounts.state.${account.state}`)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      {outcome.issues.length > 0 ? <IssueList issues={outcome.issues} /> : null}
    </div>
  );
}

function IssueList({ issues }: { issues: readonly AccountIssue[] }) {
  const { t } = useTranslation("directory");
  return (
    <Alert variant="warning">
      <TriangleAlert />
      <AlertTitle>{t("accounts.issues.title", { count: issues.length })}</AlertTitle>
      <AlertDescription>
        <ul className="mt-1 space-y-0.5">
          {issues.map((issue, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: issues have no identity beyond their position
            <li key={index} className="flex gap-1.5">
              <span className="text-muted-foreground">
                {issue.line !== null
                  ? t("accounts.issues.line", { line: issue.line })
                  : t("accounts.issues.entry")}
              </span>
              <span>{t(`accounts.issues.${issue.reason}`, { value: issue.value ?? "" })}</span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
