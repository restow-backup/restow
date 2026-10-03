import { Link } from "@tanstack/react-router";
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
import { Input } from "@/components/ui/input";
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
import { sourceDetailTo } from "@/features/sources/paths";
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

/** Most bare logins that get a row of their own (password, username) below the box. */
export const MAX_ENTRY_ROWS = 50;

/** One bare entry of the box: `login[, name[, email]]`, no header. */
export interface BareEntry {
  login: string;
  displayName: string;
  email: string;
}

/**
 * The accounts of a box that holds only bare positional lines
 * `login[, name[, email]]` (docs/IMAP.md, `accounts.format`), or null when the
 * text is CSV-shaped instead: a cell naming a recognised header, or more than
 * the three positional columns, means an already-CSV paste whose header row
 * carries its own `password` column. Only bare entries get a password field
 * of their own on a per_mailbox source.
 */
export function parseBareEntries(text: string): BareEntry[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }
  const entries: BareEntry[] = [];
  for (const line of lines) {
    const delimiter = ([",", ";", "\t"] as const).reduce((best, candidate) =>
      line.split(candidate).length > line.split(best).length ? candidate : best,
    );
    const fields = line.split(delimiter).map((field) => field.trim());
    if (fields.length > 3 || fields.some((field) => HEADER_LABELS.has(field.toLowerCase()))) {
      return null;
    }
    entries.push({ login: fields[0] ?? "", displayName: fields[1] ?? "", email: fields[2] ?? "" });
  }
  return entries;
}

/** Whether the box holds exactly one bare account (see {@link parseBareEntries}). */
export function isSingleLoginEntry(text: string): boolean {
  return parseBareEntries(text)?.length === 1;
}

/** What the admin typed for one bare entry below the box. */
export interface EntryCredentials {
  password: string;
  /** The IMAP login, when it differs from the mailbox address entered above. */
  username: string;
}

/**
 * The text that gets sent. Without any password or username it is the box as
 * typed (unchanged, so the CSV path and plain lists behave as before). With
 * some, every bare entry becomes a row of a header CSV with a `password`
 * column (the only shape the API reads passwords from); a username replaces
 * the login and the entered mailbox becomes the address shown.
 */
export function buildImportPayload(
  text: string,
  entries: readonly BareEntry[] | null,
  credentials: Readonly<Record<string, EntryCredentials>>,
): string {
  if (!entries) {
    return text;
  }
  const filled = entries.some((entry) => {
    const own = credentials[entry.login];
    return own !== undefined && (own.password.length > 0 || own.username.trim().length > 0);
  });
  if (!filled) {
    return text;
  }
  const rows = entries.map((entry) => {
    const own = credentials[entry.login];
    const username = own?.username.trim() ?? "";
    const login = username || entry.login;
    const email = entry.email || (username ? entry.login : "");
    return [login, entry.displayName, email, own?.password ?? ""].map(csvField).join(",");
  });
  return `login,name,email,password\n${rows.join("\n")}`;
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

/** Which login the source uses, and a way to the source's page to change it. */
function AuthModeNote({ source }: { source: DirectorySource }) {
  const { t } = useTranslation("directory");
  const mode = source.imapAuthMode ?? "shared";
  return (
    <p className="text-sm" data-testid="accounts-auth-mode">
      {t(`accounts.authMode.${mode}`)}{" "}
      <Link
        to={sourceDetailTo(source.id)}
        className="font-medium text-primary underline-offset-4 hover:underline"
      >
        {t("accounts.authMode.change")}
      </Link>
    </p>
  );
}

function AccountsForm({ source, onDone }: { source: DirectorySource; onDone: () => void }) {
  const { t } = useTranslation("directory");
  const { t: tc } = useTranslation();
  const importAccounts = useImportAccounts();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [text, setText] = React.useState("");
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [credentials, setCredentials] = React.useState<Record<string, EntryCredentials>>({});
  const [preview, setPreview] = React.useState<{
    payload: string;
    outcome: CsvImportOutcome;
  } | null>(null);
  const [result, setResult] = React.useState<CsvImportOutcome | null>(null);

  // Only a per_mailbox source has a password of its own to set here at all
  // (docs/IMAP.md). Bare logins each get a password and username field right
  // below the box; a CSV with a header row carries its own `password` column
  // instead. Past MAX_ENTRY_ROWS the rows would bury the dialog, so a long
  // list is left to the CSV form too.
  const perMailbox = source.imapAuthMode === "per_mailbox";
  const parsed = perMailbox ? parseBareEntries(text) : null;
  const entries = parsed && parsed.length <= MAX_ENTRY_ROWS ? parsed : null;
  const payload = buildImportPayload(text, entries, credentials);

  const current = preview !== null && preview.payload === payload ? preview.outcome : null;
  const addable = current ? current.created + current.existing : 0;

  const setCredentialFor = (login: string, patch: Partial<EntryCredentials>) =>
    setCredentials((all) => ({
      ...all,
      [login]: { ...(all[login] ?? { password: "", username: "" }), ...patch },
    }));

  const run = async (dryRun: boolean) => {
    try {
      const outcome = await importAccounts.mutateAsync({
        sourceId: source.id,
        csv: payload,
        dryRun,
      });
      if (dryRun) {
        setPreview({ payload, outcome });
        return;
      }
      toast.success(t("accounts.done", { created: outcome.created }));
      // Show what happened per mailbox instead of closing; the passwords just
      // sent are dropped from memory here.
      setCredentials({});
      setPreview(null);
      setResult(outcome);
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

  if (result) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <PreviewResult outcome={result} perMailbox={perMailbox} />
        </div>
        <DialogFooter>
          <Button onClick={onDone}>{tc("actions.close")}</Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        <AuthModeNote source={source} />
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
            {perMailbox
              ? t("accounts.passwordColumnHint")
              : t("accounts.passwordColumnIgnoredHint")}
          </p>
        </div>

        {entries ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("accounts.entries.title")}</p>
            <ul className="space-y-3">
              {entries.map((entry, index) => {
                const own = credentials[entry.login];
                const id = `accounts-entry-${index}`;
                return (
                  <li
                    key={`${index}-${entry.login}`}
                    className="space-y-2 rounded-md border border-border p-3"
                  >
                    <p className="truncate font-mono text-xs">{entry.login}</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor={`${id}-password`}>{t("accounts.entries.password")}</Label>
                        <PasswordInput
                          id={`${id}-password`}
                          autoComplete="new-password"
                          value={own?.password ?? ""}
                          onChange={(event) =>
                            setCredentialFor(entry.login, { password: event.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`${id}-username`}>{t("accounts.entries.username")}</Label>
                        <Input
                          id={`${id}-username`}
                          autoComplete="off"
                          spellCheck={false}
                          value={own?.username ?? ""}
                          onChange={(event) =>
                            setCredentialFor(entry.login, { username: event.target.value })
                          }
                        />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground">{t("accounts.entries.hint")}</p>
          </div>
        ) : null}

        {current ? <PreviewResult outcome={current} perMailbox={perMailbox} /> : null}
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

function PreviewResult({
  outcome,
  perMailbox,
}: {
  outcome: CsvImportOutcome;
  perMailbox: boolean;
}) {
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
                  <TableHead className={perMailbox ? undefined : "hidden sm:table-cell"}>
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
                    <TableCell className={perMailbox ? undefined : "hidden sm:table-cell"}>
                      {account.hasPassword ? (
                        <Badge variant="outline">{t("accounts.columns.passwordSet")}</Badge>
                      ) : perMailbox ? (
                        <Badge variant="warning">{t("accounts.columns.passwordMissing")}</Badge>
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
