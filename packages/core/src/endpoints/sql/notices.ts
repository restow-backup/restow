/**
 * The fixed warnings of W1 (docs/BAREMETAL-WINDOWS.md 0 and 6.5): the files of open databases in
 * a file backup are no restorable backup of SQL Server, Exchange, Active Directory or the virtual
 * machines of a Hyper-V host. The machine page and the run sheet show them for every role the
 * agent reports, as long as the matching function is not on: the SQL part disappears once the
 * native SQL backup covers every database.
 */
import type { AppSubject, RunNotice, WindowsFacts } from "./schemas.js";
import { type SqlSettings, sqlCoversEverything } from "./settings.js";

export function appSubjectsOf(
  windows: Pick<WindowsFacts, "roles" | "productType"> | null | undefined,
  sql: SqlSettings | null | undefined,
): AppSubject[] {
  if (!windows) {
    return [];
  }
  const subjects: AppSubject[] = [];
  if (windows.roles.sqlServer && !sqlCoversEverything(sql)) {
    subjects.push("sql_server");
  }
  if (windows.roles.exchange) {
    subjects.push("exchange");
  }
  if (windows.roles.domainController || windows.productType === "domain_controller") {
    subjects.push("active_directory");
  }
  if (windows.roles.hyperV) {
    subjects.push("hyper_v");
  }
  return subjects;
}

/** The machine's app warning as a notice; none when no role applies. */
export function appFilesNotices(
  windows: Pick<WindowsFacts, "roles" | "productType"> | null | undefined,
  sql: SqlSettings | null | undefined,
): RunNotice[] {
  const subjects = appSubjectsOf(windows, sql);
  return subjects.length > 0 ? [{ code: "app_files_not_app_backup", subjects }] : [];
}
