/**
 * IMAP accounts: the manual list and its CSV import.
 *
 * IMAP has no directory to sync from, so an admin types accounts in or
 * imports a list. Accepted CSV (RFC 4180 quoting, quoted line breaks allowed,
 * a UTF-8 BOM is ignored; the delimiter `,`, `;` or tab is detected from the
 * first line, so rows pasted from a spreadsheet work as they are):
 *
 *   with a header row, any order, case-insensitive:
 *     login | username | user | account   -> the IMAP login (required)
 *     email | e-mail | mail | address     -> address shown in the UI (default: login)
 *     name | displayname | display name   -> display name
 *     password | pass | pwd               -> per-mailbox password (optional, see below)
 *
 *   without a header, positional:
 *     login[, display name[, email]]
 *
 * A password column only matters for a source in `per_mailbox` auth mode
 * (docs/IMAP.md): hosters with one password per mailbox and no master user
 * (Hetzner, IONOS, all-inkl). The service seals each row's password into its
 * own protected object on arrival and never stores or logs the file itself; a
 * `shared` or `master_user` source ignores a password column entirely (its
 * accounts share one credential, set on the source). The positional (no
 * header) form never carries a password, only the header form does, so a
 * plain list pasted without a header cannot accidentally be read as one.
 */

export interface ImapAccountInput {
  readonly login: string;
  readonly email: string;
  readonly displayName: string | null;
  /**
   * Per-mailbox password from a `password`/`pass`/`pwd` column, trimmed;
   * undefined when the row has none. Never logged or echoed back (the
   * service seals it and reports only whether a row had one).
   */
  readonly password?: string;
}

export type AccountIssueReason = "missing_login" | "duplicate_login" | "invalid_email";

export interface AccountIssue {
  /** 1-based line in the CSV; null for entries that did not come from a file. */
  readonly line: number | null;
  readonly reason: AccountIssueReason;
  readonly value: string | null;
}

/** One account as entered, before validation. */
export interface AccountRow {
  readonly line: number | null;
  readonly login: string;
  readonly email?: string | null;
  readonly displayName?: string | null;
  /** See {@link ImapAccountInput.password}. */
  readonly password?: string;
}

export type CsvDelimiter = "," | ";" | "\t";

export interface CsvImportPreview {
  readonly accounts: readonly ImapAccountInput[];
  readonly issues: readonly AccountIssue[];
  readonly hasHeader: boolean;
  readonly delimiter: CsvDelimiter;
}

type Column = "login" | "email" | "displayName" | "password";

const HEADER_ALIASES: Record<string, Column> = {
  login: "login",
  username: "login",
  user: "login",
  account: "login",
  email: "email",
  mail: "email",
  address: "email",
  name: "displayName",
  displayname: "displayName",
  password: "password",
  pass: "password",
  pwd: "password",
};

/** Loose address check: something@something with no whitespace. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

export function isAddress(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

/** Pick the delimiter that splits the first non-empty line into the most columns. */
export function detectDelimiter(text: string): CsvDelimiter {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  const candidates: CsvDelimiter[] = [",", ";", "\t"];
  let best: CsvDelimiter = ",";
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Split CSV text into records with their starting line. Quotes may span line
 * breaks; a doubled quote inside quotes is a literal quote. Blank lines are
 * dropped. Fields are returned raw (untrimmed): a password cell must keep
 * leading or trailing whitespace exactly as entered, since it can be part of
 * the password itself; callers trim the columns where that is safe.
 */
export function parseCsvRecords(
  text: string,
  delimiter: CsvDelimiter,
): { line: number; fields: string[] }[] {
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  const endRecord = () => {
    fields.push(field);
    if (fields.some((value) => value.trim().length > 0)) {
      records.push({ line: recordLine, fields });
    }
    fields = [];
    field = "";
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (char === "\n") {
          line++;
        }
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      fields.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") {
        i++;
      }
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += char;
    }
  }
  endRecord();
  return records;
}

function headerColumns(fields: readonly string[]): Map<number, Column> | null {
  const columns = new Map<number, Column>();
  fields.forEach((field, index) => {
    const alias = HEADER_ALIASES[field.toLowerCase().replace(/[\s_-]+/g, "")];
    if (alias && ![...columns.values()].includes(alias)) {
      columns.set(index, alias);
    }
  });
  return [...columns.values()].includes("login") ? columns : null;
}

/**
 * Validate entered accounts: trim, default the address to an address-like
 * login, drop duplicate logins (case-insensitive, first one wins) and
 * addresses that are not addresses. Issues are reported, never thrown.
 */
export function normalizeAccounts(rows: readonly AccountRow[]): {
  accounts: ImapAccountInput[];
  issues: AccountIssue[];
} {
  const accounts: ImapAccountInput[] = [];
  const issues: AccountIssue[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const login = row.login.trim();
    if (!login) {
      issues.push({ line: row.line, reason: "missing_login", value: null });
      continue;
    }
    const key = login.toLowerCase();
    if (seen.has(key)) {
      issues.push({ line: row.line, reason: "duplicate_login", value: login });
      continue;
    }
    // An address equal to the login is what a normalised entry carries when it
    // has no address of its own; accepting it keeps normalisation idempotent.
    const email = row.email?.trim() || (isAddress(login) ? login : "");
    if (email && email.toLowerCase() !== key && !isAddress(email)) {
      issues.push({ line: row.line, reason: "invalid_email", value: email });
      continue;
    }
    seen.add(key);
    // Never trim the password itself: unlike a login or an address, leading
    // or trailing whitespace can be part of it, and silently stripping it
    // would seal a password that no longer matches what the mailbox expects.
    // Only an empty (or whitespace-only) cell counts as "no password".
    const password = row.password && row.password.trim().length > 0 ? row.password : undefined;
    accounts.push({
      login,
      email: email || login,
      displayName: row.displayName?.trim() || null,
      ...(password ? { password } : {}),
    });
  }
  return { accounts, issues };
}

/** Parse CSV text into accounts plus the issues found (never throws). */
export function parseImapAccountsCsv(text: string): CsvImportPreview {
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = detectDelimiter(content);
  const records = parseCsvRecords(content, delimiter);
  const first = records[0];
  const columns = first ? headerColumns(first.fields) : null;
  const dataRecords = columns ? records.slice(1) : records;

  const rows: AccountRow[] = dataRecords.map(({ line, fields }) => {
    if (!columns) {
      // No header, so no password column either (see the module comment): every
      // positional field is safe to trim.
      return {
        line,
        login: (fields[0] ?? "").trim(),
        displayName: fields[1]?.trim(),
        email: fields[2]?.trim(),
      };
    }
    const values: Partial<Record<Column, string>> = {};
    for (const [position, column] of columns) {
      const raw = fields[position] ?? "";
      // The password cell keeps its exact whitespace; every other column is trimmed.
      values[column] = column === "password" ? raw : raw.trim();
    }
    return {
      line,
      login: values.login ?? "",
      email: values.email,
      displayName: values.displayName,
      password: values.password,
    };
  });
  const { accounts, issues } = normalizeAccounts(rows);
  return { accounts, issues, hasHeader: columns !== null, delimiter };
}
