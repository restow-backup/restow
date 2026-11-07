/**
 * The T-SQL block the machine page shows once per instance for the DBA to run (W2a,
 * docs/BAREMETAL-WINDOWS.md 5.1.2). The agent signs in with the service SID of its service
 * (`NT SERVICE\RestowAgent`, integrated authentication); SQL Server gives neither SYSTEM nor the
 * administrators sysadmin, so without a login every connection fails with 18456. No credential is
 * ever stored: there is none.
 *
 *   sysadmin  the default and the simple choice: the login is a member of sysadmin.
 *   minimal   dbcreator (restore under a new name, the check copy), VIEW SERVER STATE (space
 *             planning), read access to the backup history in msdb, and per database a user with
 *             db_backupoperator and db_owner (CHECKDB). New databases do not get it on their own.
 *
 * Every name is a bracketed identifier with `]` doubled and every string an N'' literal with `'`
 * doubled, so a database name cannot end the statement.
 */

export const SQL_AGENT_LOGIN = "NT SERVICE\\RestowAgent";

export type SqlLoginVariant = "sysadmin" | "minimal";

/** `[name]` with `]` doubled, as QUOTENAME does. */
export function quoteSqlIdentifier(value: string): string {
  return `[${value.replace(/\]/g, "]]")}]`;
}

/** `N'text'` with `'` doubled. */
export function quoteSqlString(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

export interface SqlLoginScriptInput {
  variant: SqlLoginVariant;
  /** The user databases the minimal variant grants rights in (system databases are skipped). */
  databases?: readonly string[];
  account?: string;
}

const SYSTEM = new Set(["master", "model", "msdb", "tempdb"]);

export function sqlLoginScript(input: SqlLoginScriptInput): string {
  const account = input.account ?? SQL_AGENT_LOGIN;
  const login = quoteSqlIdentifier(account);
  const literal = quoteSqlString(account);
  const lines = [`IF SUSER_ID(${literal}) IS NULL CREATE LOGIN ${login} FROM WINDOWS;`];
  if (input.variant === "sysadmin") {
    lines.push(`ALTER SERVER ROLE [sysadmin] ADD MEMBER ${login};`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(`ALTER SERVER ROLE [dbcreator] ADD MEMBER ${login};`);
  lines.push(`GRANT VIEW SERVER STATE TO ${login};`);
  lines.push("USE [msdb];");
  lines.push(
    `IF USER_ID(${literal}) IS NULL CREATE USER ${login} FOR LOGIN ${login};`,
    `GRANT SELECT ON [dbo].[backupset] TO ${login};`,
  );
  const databases = [...new Set(input.databases ?? [])].filter(
    (name) => !SYSTEM.has(name.toLowerCase()),
  );
  for (const database of databases) {
    lines.push(`USE ${quoteSqlIdentifier(database)};`);
    lines.push(`IF USER_ID(${literal}) IS NULL CREATE USER ${login} FOR LOGIN ${login};`);
    lines.push(`ALTER ROLE [db_backupoperator] ADD MEMBER ${login};`);
    lines.push(`ALTER ROLE [db_owner] ADD MEMBER ${login};`);
  }
  return `${lines.join("\n")}\n`;
}
