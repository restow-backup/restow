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
import type { AccountIssue, CsvImportOutcome, DirectorySource, ImapAuthMode } from "./types";

/** Largest file the dialog reads; the API accepts 2 MB of CSV text. */
const MAX_FILE_BYTES = 2_000_000;

/** Quote a CSV field only when it needs it (RFC 4180: a comma, semicolon, tab, quote or newline). */
function csvField(value: string): string {
  return /[,;\t"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
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
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<{ text: string; outcome: CsvImportOutcome } | null>(
    null,
  );
  const [passwords, setPasswords] = React.useState<Record<string, string>>({});
  const [usernames, setUsernames] = React.useState<Record<string, string>>({});
  const [added, setAdded] = React.useState<CsvImportOutcome | null>(null);

  const mode: ImapAuthMode = source.imapAuthMode ?? "shared";
  const perMailbox = mode === "per_mailbox";

  const current = preview !== null && preview.text === text ? preview.outcome : null;
  const addable = current ? current.created + current.existing : 0;
  // Per-row fields are offered for new accounts only, and only while the
  // pasted list carries no password column of its own: the rebuilt list below
  // could not repeat those passwords (the check never returns them).
  const rowFields =
    perMailbox && current !== null && !current.accounts.some((account) => account.hasPassword);
  const payload = rowFields && current ? buildRowCsv(current, passwords, usernames) : text;

  const run = async (dryRun: boolean) => {
    try {
      const outcome = await importAccounts.mutateAsync({
        sourceId: source.id,
        csv: payload,
        dryRun,
      });
      if (dryRun) {
        setPreview({ text, outcome });
        return;
      }
      toast.success(t("accounts.done", { created: outcome.created }));
      if (perMailbox) {
        setAdded(outcome);
      } else {
        onDone();
      }
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

  if (added) {
    return <AddedResult outcome={added} onDone={onDone} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        <ModeNotice source={source} mode={mode} onNavigate={onDone} />
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

        {current ? (
          <PreviewResult
            outcome={current}
            rowFields={rowFields}
            passwords={passwords}
            usernames={usernames}
            onPassword={(login, value) => setPasswords((prev) => ({ ...prev, [login]: value }))}
            onUsername={(login, value) => setUsernames((prev) => ({ ...prev, [login]: value }))}
          />
        ) : null}
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

/**
 * The accounts of a checked list as a CSV with a password column, so the
 * import creates each mailbox and seals its password in one call. A username
 * typed for a row replaces the login the list gave (the address stays).
 */
function buildRowCsv(
  outcome: CsvImportOutcome,
  passwords: Record<string, string>,
  usernames: Record<string, string>,
): string {
  const lines = outcome.accounts.map((account) => {
    const username = usernames[account.login]?.trim() ?? "";
    const login = username.length > 0 ? username : account.login;
    return [login, account.displayName ?? "", account.email, passwords[account.login] ?? ""]
      .map(csvField)
      .join(",");
  });
  return ["login,name,email,password", ...lines].join("\n");
}

/** Which login mode applies to this source, in one sentence, and where to change it. */
function ModeNotice({
  source,
  mode,
  onNavigate,
}: {
  source: DirectorySource;
  mode: ImapAuthMode;
  onNavigate: () => void;
}) {
  const { t } = useTranslation("directory");
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
      <p data-testid="accounts-mode">{t(`accounts.mode.${mode}`)}</p>
      <Link
        to={sourceDetailTo(source.id)}
        onClick={onNavigate}
        className="font-medium underline-offset-4 hover:underline"
      >
        {t("accounts.changeMode")}
      </Link>
    </div>
  );
}

/** Per-row outcome of an add with passwords: created or listed already, password sealed or missing. */
function AddedResult({ outcome, onDone }: { outcome: CsvImportOutcome; onDone: () => void }) {
  const { t } = useTranslation("directory");
  const { t: tc } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        <p className="text-sm" aria-live="polite">
          {t("accounts.done", { created: outcome.created })}
        </p>
        <ul
          className="divide-y divide-border rounded-md border border-border"
          data-testid="accounts-results"
        >
          {outcome.accounts.map((account) => (
            <li key={account.login} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="font-mono text-xs">{account.login}</span>
              <span className="flex gap-1.5">
                <Badge variant={account.state === "new" ? "info" : "muted"}>
                  {t(`accounts.state.${account.state}`)}
                </Badge>
                <Badge variant={account.hasPassword ? "outline" : "warning"}>
                  {account.hasPassword
                    ? t("accounts.results.passwordSet")
                    : t("accounts.results.passwordMissing")}
                </Badge>
              </span>
            </li>
          ))}
        </ul>
        {outcome.accounts.some((account) => !account.hasPassword) ? (
          <p className="text-xs text-muted-foreground">{t("accounts.results.missingHint")}</p>
        ) : null}
      </div>
      <DialogFooter>
        <Button onClick={onDone}>{tc("actions.close")}</Button>
      </DialogFooter>
    </div>
  );
}

function PreviewResult({
  outcome,
  rowFields,
  passwords,
  usernames,
  onPassword,
  onUsername,
}: {
  outcome: CsvImportOutcome;
  rowFields: boolean;
  passwords: Record<string, string>;
  usernames: Record<string, string>;
  onPassword: (login: string, value: string) => void;
  onUsername: (login: string, value: string) => void;
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
          {rowFields ? (
            <div className="space-y-2" data-testid="accounts-row-fields">
              <p className="text-xs text-muted-foreground">{t("accounts.rowFields.hint")}</p>
              {outcome.accounts
                .filter((account) => account.state === "new")
                .map((account) => (
                  <div
                    key={account.login}
                    className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_1fr_1fr] sm:items-end"
                  >
                    <span className="font-mono text-xs sm:pb-2">{account.login}</span>
                    <div className="space-y-1">
                      <Label htmlFor={`accounts-username-${account.login}`}>
                        {t("accounts.rowFields.username")}
                      </Label>
                      <Input
                        id={`accounts-username-${account.login}`}
                        autoComplete="off"
                        placeholder={account.login}
                        value={usernames[account.login] ?? ""}
                        onChange={(event) => onUsername(account.login, event.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`accounts-password-${account.login}`}>
                        {t("accounts.rowFields.password")}
                      </Label>
                      <PasswordInput
                        id={`accounts-password-${account.login}`}
                        autoComplete="new-password"
                        value={passwords[account.login] ?? ""}
                        onChange={(event) => onPassword(account.login, event.target.value)}
                      />
                    </div>
                  </div>
                ))}
            </div>
          ) : null}
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
