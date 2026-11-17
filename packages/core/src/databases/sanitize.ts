/**
 * Error texts of database clients never carry a credential (docs/DATABASES.md 10): before a
 * message is stored or shown, URLs lose their user and password, the user name and the password
 * of the connection are replaced, `IDENTIFIED BY` clauses (MySQL and MariaDB grants) lose their
 * secret, and the text is bounded. The agent does the same in Go (internal/dbprobe/sanitize.go);
 * the server runs this on everything an executor reports, whoever produced it.
 */

export const DB_MESSAGE_MAX_LENGTH = 500;

export interface DbSecretsToHide {
  user?: string | null;
  password?: string | null;
}

const REDACTED = "***";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove what must never leave the executor from one message. */
export function sanitizeDbMessage(message: string, secrets: DbSecretsToHide = {}): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed.
  let text = message.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
  // scheme://user:password@host -> scheme://***@host
  text = text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]*@/g, `$1${REDACTED}@`);
  // key=value pairs of connection strings
  text = text.replace(
    /\b(password|passwd|pwd|pass)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s;,]+)/gi,
    `$1=${REDACTED}`,
  );
  text = redactIdentifiedBy(text);
  const password = secrets.password ?? "";
  if (password.length >= 1) {
    text = text.split(password).join(REDACTED);
  }
  const user = secrets.user ?? "";
  // A user name of one or two characters would replace letters everywhere; such a name stays.
  if (user.length >= 3) {
    text = text.replace(new RegExp(escapeRegExp(user), "g"), REDACTED);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > DB_MESSAGE_MAX_LENGTH
    ? `${text.slice(0, DB_MESSAGE_MAX_LENGTH - 1)}…`
    : text;
}

/** `IDENTIFIED BY [PASSWORD] '…'` and `IDENTIFIED VIA/WITH … USING/AS '…'` without the secret. */
export function redactIdentifiedBy(text: string): string {
  return text
    .replace(
      /\bIDENTIFIED\s+BY\s+(PASSWORD\s+)?('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi,
      (_m, p) => (p ? `IDENTIFIED BY PASSWORD '${REDACTED}'` : `IDENTIFIED BY '${REDACTED}'`),
    )
    .replace(
      /\b(IDENTIFIED\s+(?:VIA|WITH)\s+[A-Za-z0-9_]+\s+(?:USING|AS))\s+(PASSWORD\s*\(\s*)?('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")(\s*\))?/gi,
      (_m, clause: string) => `${clause} '${REDACTED}'`,
    );
}
