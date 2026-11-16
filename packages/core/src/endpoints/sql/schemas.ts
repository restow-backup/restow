/**
 * The SQL Server parts of the agent contract (W2a, docs/BAREMETAL-WINDOWS.md 5.1 and 6.2; the
 * fixtures under agent/internal/api/testdata/contract are shared with the Go agent): the Windows
 * facts of the heartbeat (W1), the SQL inventory, the reports of the runs `sql`, `sql_restore`
 * and `sql_verify`, and the notices of a run.
 *
 * Encoding: LSNs are decimal strings (numeric(25,0) is larger than 2^53), GUIDs lower case with
 * dashes, times RFC 3339 UTC; an optional field is left out, never null, unless said otherwise.
 * Every reader drops what does not fit instead of refusing the request.
 */
import {
  bool,
  code,
  compact,
  guid,
  int,
  isObject,
  list,
  lsn,
  message,
  name,
  optional,
  sha256,
  snapshotPath,
  text,
  time,
} from "./parse.js";

/** What an agent names when it can do the native SQL backup; the server offers SQL actions only then. */
export const SQL_CAPABILITY = "sql_native_v1";

export const SQL_TASK_KINDS = ["sql_restore", "sql_verify", "sql_inventory"] as const;
export const SQL_RUN_KINDS = ["sql", "sql_restore", "sql_verify"] as const;
export type SqlRunKind = (typeof SQL_RUN_KINDS)[number];

/** Tags of a SQL snapshot; the host is the agent's hostname. */
export const SQL_SNAPSHOT_TAG = "restow-sql";
export const SQL_INSTANCE_TAG_PREFIX = "restow-sql-instance=";

/** The error codes of the SQL runs (`errors[].code` and a database's `code`). */
export const SQL_ERROR_CODES = [
  "sql_instance_unreachable",
  "sql_login_missing",
  "sql_permission_missing",
  "sql_powershell_constrained",
  "sql_strict_encryption",
  "sql_fci_unsupported",
  "sql_mode_unsupported",
  "sql_staging_unusable",
  "sql_staging_too_small",
  "sql_database_unavailable",
  "sql_backup_failed",
  "sql_snapshot_failed",
  "sql_script_failed",
  "sql_restore_name_taken",
  "sql_restore_no_space",
  "sql_restore_failed",
  "sql_backup_mismatch",
  "sql_verify_no_space",
  "sql_verify_timeout",
  "sql_verify_system_db",
] as const;
export type SqlErrorCode = (typeof SQL_ERROR_CODES)[number];

/** The notice codes of a run (`notices[].code`). */
export const RUN_NOTICE_CODES = [
  "app_files_not_app_backup",
  "sql_log_growing",
  "sql_tde_certificate",
  "sql_version_untested",
] as const;
export type RunNoticeCode = (typeof RUN_NOTICE_CODES)[number];

/** The applications `app_files_not_app_backup` names. */
export const APP_SUBJECTS = ["sql_server", "exchange", "active_directory", "hyper_v"] as const;
export type AppSubject = (typeof APP_SUBJECTS)[number];

export const MAX_SQL_DATABASES = 1000;
export const MAX_SQL_FILES = 256;
export const MAX_CHECKDB_ERRORS = 100;
export const MAX_RUN_NOTICES = 16;
export const MAX_SQL_INSTANCES = 50;
/** SQL Server allows 128 characters in a database name (sysname). */
export const MAX_SQL_NAME = 128;
/** An instance name is at most 16 characters; the reader allows some room. */
export const MAX_SQL_INSTANCE_NAME = 64;

// ---------------------------------------------------------------------------
// Windows facts (heartbeat `machine.windows`, W1)
// ---------------------------------------------------------------------------

export interface WindowsSqlInstanceFacts {
  name: string;
  id: string;
  version: string;
  edition: string;
  serviceName: string;
  serviceAccount: string;
  clustered: boolean;
  strictEncryption: boolean;
}

export interface WindowsBitLockerVolume {
  mount: string;
  protection: "on" | "off" | "unknown";
  conversion: string;
}

export interface WindowsFacts {
  productName: string;
  editionId: string;
  productType: "workstation" | "server" | "domain_controller" | "unknown";
  installationType: string;
  build: number;
  ubr: number;
  displayVersion: string;
  domainMember: boolean;
  domain: string;
  roles: {
    domainController: boolean;
    dfsr: boolean;
    exchange: boolean;
    hyperV: boolean;
    sqlServer: boolean;
  };
  sqlInstances: WindowsSqlInstanceFacts[];
  bitlocker: { state: "ok" | "unavailable" | "error"; volumes: WindowsBitLockerVolume[] };
}

const PRODUCT_TYPES = ["workstation", "server", "domain_controller"] as const;
const BITLOCKER_STATES = ["ok", "unavailable", "error"] as const;
const PROTECTION = ["on", "off"] as const;

function oneOf<T extends string>(value: unknown, values: readonly T[]): T | null {
  return (values as readonly unknown[]).includes(value) ? (value as T) : null;
}

/** A short token such as an edition id or a conversion state: letters, digits, `_ -.`. */
function token(value: unknown, max: number): string {
  return (text(value, max) ?? "").replace(/[^A-Za-z0-9_ .()-]/g, "");
}

function readWindowsSqlInstance(value: unknown): WindowsSqlInstanceFacts | null {
  if (!isObject(value)) {
    return null;
  }
  const instance = name(value.name, MAX_SQL_INSTANCE_NAME);
  if (instance === null) {
    return null;
  }
  return {
    name: instance,
    id: text(value.id, 128) ?? "",
    version: token(value.version, 32),
    edition: text(value.edition, 128) ?? "",
    serviceName: text(value.serviceName, 128) ?? "",
    serviceAccount: text(value.serviceAccount, 256) ?? "",
    clustered: bool(value.clustered) ?? false,
    strictEncryption: bool(value.strictEncryption) ?? false,
  };
}

function readBitLockerVolume(value: unknown): WindowsBitLockerVolume | null {
  if (!isObject(value)) {
    return null;
  }
  const mount = name(value.mount, 260);
  if (mount === null) {
    return null;
  }
  return {
    mount,
    protection: oneOf(value.protection, PROTECTION) ?? "unknown",
    conversion: token(value.conversion, 40).toLowerCase(),
  };
}

/** The Windows facts of a heartbeat, checked and bounded; undefined for none or a malformed one. */
export function parseWindowsFacts(value: unknown): WindowsFacts | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const roles = isObject(value.roles) ? value.roles : {};
  const bitlocker = isObject(value.bitlocker) ? value.bitlocker : {};
  const instances = list(value.sqlInstances, MAX_SQL_INSTANCES, readWindowsSqlInstance);
  return {
    productName: text(value.productName, 128) ?? "",
    editionId: token(value.editionId, 64),
    productType: oneOf(value.productType, PRODUCT_TYPES) ?? "unknown",
    installationType: token(value.installationType, 32).toLowerCase(),
    build: int(value.build, 0, 1_000_000) ?? 0,
    ubr: int(value.ubr, 0, 1_000_000) ?? 0,
    displayVersion: token(value.displayVersion, 16),
    domainMember: bool(value.domainMember) ?? false,
    domain: (text(value.domain, 253) ?? "").replace(/[^A-Za-z0-9.-]/g, ""),
    roles: {
      domainController: bool(roles.domainController) ?? value.productType === "domain_controller",
      dfsr: bool(roles.dfsr) ?? false,
      exchange: bool(roles.exchange) ?? false,
      hyperV: bool(roles.hyperV) ?? false,
      sqlServer: bool(roles.sqlServer) ?? instances.length > 0,
    },
    sqlInstances: instances,
    bitlocker: {
      state: oneOf(bitlocker.state, BITLOCKER_STATES) ?? "error",
      volumes: list(bitlocker.volumes, 64, readBitLockerVolume),
    },
  };
}

/** The version line the machine page shows, e.g. "Windows Server 2022 Standard 21H2 (build 20348.2340)". */
export function windowsVersionText(
  facts: Pick<WindowsFacts, "productName" | "displayVersion" | "build" | "ubr">,
): string {
  const parts = [facts.productName.trim()];
  if (facts.displayVersion) {
    parts.push(facts.displayVersion);
  }
  const build =
    facts.build > 0 ? ` (build ${facts.build}${facts.ubr > 0 ? `.${facts.ubr}` : ""})` : "";
  return `${parts.filter(Boolean).join(" ")}${build}`.trim();
}

/** The capabilities an agent names: known-looking codes only, at most 32. */
export function parseCapabilities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return [...new Set(list(value, 32, code))].sort();
}

export function hasSqlCapability(capabilities: readonly string[] | null | undefined): boolean {
  return capabilities?.includes(SQL_CAPABILITY) === true;
}

// ---------------------------------------------------------------------------
// Problems, files, notices
// ---------------------------------------------------------------------------

export interface SqlProblem {
  code: string;
  step?: string;
  number?: number;
  message?: string;
}

export function parseSqlProblem(value: unknown): SqlProblem | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const problemCode = code(value.code);
  if (problemCode === null) {
    return undefined;
  }
  return compact({
    code: problemCode,
    step: optional(code(value.step)),
    number: optional(int(value.number, 0, 2_147_483_647)),
    message: message(value.message),
  });
}

export interface SqlBackupFile {
  logicalName: string;
  /** `D` data, `L` log, `F` FILESTREAM or full text, `S` memory-optimized. */
  type: string;
  fileGroup: string;
  fileId: number;
  sizeBytes: number;
  physicalName: string;
}

export function readSqlBackupFile(value: unknown): SqlBackupFile | null {
  if (!isObject(value)) {
    return null;
  }
  const logicalName = name(value.logicalName, MAX_SQL_NAME);
  const type = typeof value.type === "string" && /^[DLFS]$/.test(value.type) ? value.type : null;
  const fileId = int(value.fileId, 0, 1_000_000);
  if (logicalName === null || type === null || fileId === null) {
    return null;
  }
  return {
    logicalName,
    type,
    fileGroup: text(value.fileGroup, MAX_SQL_NAME) ?? "",
    fileId,
    sizeBytes: int(value.sizeBytes) ?? 0,
    physicalName: text(value.physicalName, 1024) ?? "",
  };
}

export interface RunNotice {
  code: string;
  subjects?: string[];
  message?: string;
}

/** The notices of a run: known codes, at most 16; subjects are codes or names, at most 50 each. */
export function parseRunNotices(value: unknown): RunNotice[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const notices = list(value, MAX_RUN_NOTICES, (item): RunNotice | null => {
    if (!isObject(item)) {
      return null;
    }
    const noticeCode = oneOf(item.code, RUN_NOTICE_CODES);
    if (noticeCode === null) {
      return null;
    }
    const subjects = list(item.subjects, 50, (subject) => name(subject, MAX_SQL_NAME + 70));
    return compact({
      code: noticeCode,
      subjects: subjects.length > 0 ? subjects : undefined,
      message: message(item.message),
    });
  });
  return notices.length > 0 ? notices : undefined;
}

// ---------------------------------------------------------------------------
// SQL inventory (heartbeat `sqlInventory`)
// ---------------------------------------------------------------------------

export interface SqlInventoryDatabase {
  name: string;
  databaseId?: number;
  system: boolean;
  familyGuid: string;
  databaseGuid: string;
  state: string;
  recoveryModel: string;
  readOnly: boolean;
  encrypted: boolean;
  sizeBytes?: number;
  usedBytes?: number;
  canBackup?: boolean;
  lastFullBackupAt?: string;
  lastLogBackupAt?: string;
  availabilityGroup?: string;
  secondaryReplica?: boolean;
}

export interface SqlInventoryInstance {
  name: string;
  state: "ok" | "error";
  version?: string;
  edition?: string;
  engineEdition?: number;
  clustered?: boolean;
  hadr?: boolean;
  backupCompressionDefault?: boolean;
  login?: { name: string; sysadmin: boolean; canCreateDatabase: boolean };
  error?: SqlProblem;
  databases: SqlInventoryDatabase[];
}

export interface SqlInventory {
  collectedAt: string;
  truncated: boolean;
  instances: SqlInventoryInstance[];
}

const RECOVERY_MODELS = ["FULL", "BULK_LOGGED", "SIMPLE"];

function recoveryModel(value: unknown): string | null {
  return typeof value === "string" && RECOVERY_MODELS.includes(value.toUpperCase())
    ? value.toUpperCase()
    : null;
}

function readInventoryDatabase(value: unknown): SqlInventoryDatabase | null {
  if (!isObject(value)) {
    return null;
  }
  const dbName = name(value.name, MAX_SQL_NAME);
  const familyGuid = guid(value.familyGuid);
  const databaseGuid = guid(value.databaseGuid);
  if (dbName === null || familyGuid === null || databaseGuid === null) {
    return null;
  }
  return compact({
    name: dbName,
    databaseId: optional(int(value.databaseId, 1, 32767)),
    system: bool(value.system) ?? false,
    familyGuid,
    databaseGuid,
    state: token(value.state, 32).toUpperCase() || "UNKNOWN",
    recoveryModel: recoveryModel(value.recoveryModel) ?? "UNKNOWN",
    readOnly: bool(value.readOnly) ?? false,
    encrypted: bool(value.encrypted) ?? false,
    sizeBytes: optional(int(value.sizeBytes)),
    usedBytes: optional(int(value.usedBytes)),
    canBackup: optional(bool(value.canBackup)),
    lastFullBackupAt: optional(time(value.lastFullBackupAt)),
    lastLogBackupAt: optional(time(value.lastLogBackupAt)),
    availabilityGroup: optional(name(value.availabilityGroup, MAX_SQL_NAME)),
    secondaryReplica: optional(bool(value.secondaryReplica)),
  });
}

function readInventoryInstance(value: unknown): SqlInventoryInstance | null {
  if (!isObject(value)) {
    return null;
  }
  const instance = name(value.name, MAX_SQL_INSTANCE_NAME);
  const state = oneOf(value.state, ["ok", "error"] as const);
  if (instance === null || state === null) {
    return null;
  }
  const login = isObject(value.login) ? value.login : null;
  const loginName = login ? name(login.name, 256) : null;
  return compact({
    name: instance,
    state,
    version: optional(token(value.version, 32) || null),
    edition: optional(text(value.edition, 128)),
    engineEdition: optional(int(value.engineEdition, 0, 100)),
    clustered: optional(bool(value.clustered)),
    hadr: optional(bool(value.hadr)),
    backupCompressionDefault: optional(bool(value.backupCompressionDefault)),
    login:
      login && loginName !== null
        ? {
            name: loginName,
            sysadmin: bool(login.sysadmin) ?? false,
            canCreateDatabase: bool(login.canCreateDatabase) ?? false,
          }
        : undefined,
    error: state === "error" ? parseSqlProblem(value.error) : undefined,
    databases: list(value.databases, MAX_SQL_DATABASES, readInventoryDatabase),
  });
}

/** The SQL inventory of a heartbeat; undefined for none or a malformed one. */
export function parseSqlInventory(value: unknown): SqlInventory | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const collectedAt = time(value.collectedAt);
  if (collectedAt === null) {
    return undefined;
  }
  let budget = MAX_SQL_DATABASES;
  const instances = list(value.instances, MAX_SQL_INSTANCES, readInventoryInstance).map(
    (instance) => {
      const databases = instance.databases.slice(0, Math.max(0, budget));
      budget -= databases.length;
      return { ...instance, databases };
    },
  );
  return { collectedAt, truncated: bool(value.truncated) ?? false, instances };
}

/** Whether the inventory names every database of an instance (a database missing from it is gone). */
export function inventoryIsComplete(
  inventory: SqlInventory,
  instance: SqlInventoryInstance,
): boolean {
  return !inventory.truncated && instance.state === "ok";
}

// ---------------------------------------------------------------------------
// The end of a `sql` run (`FinishRequest.sql`)
// ---------------------------------------------------------------------------

export interface SqlBackupFacts {
  kind: "full";
  copyOnly: boolean;
  compressed: boolean;
  checksum: boolean;
  pathInSnapshot: string;
  sha256: string;
  bytes: number;
  firstLsn: string;
  lastLsn: string;
  databaseBackupLsn?: string;
  checkpointLsn?: string;
  firstRecoveryForkGuid?: string;
  lastRecoveryForkGuid?: string;
  beginsLogChain: boolean;
  hasBulkLoggedData: boolean;
  backupStart: string;
  backupFinish: string;
  fileList: SqlBackupFile[];
}

export type SqlBackupOutcome = "backed_up" | "skipped" | "failed";

export interface SqlBackupDatabaseReport {
  name: string;
  familyGuid?: string;
  databaseGuid?: string;
  recoveryModel?: string;
  outcome: SqlBackupOutcome;
  backup?: SqlBackupFacts;
  code?: string;
  message?: string;
}

export interface SqlBackupReport {
  instance: string;
  databases: SqlBackupDatabaseReport[];
}

function readBackupFacts(value: unknown): SqlBackupFacts | null {
  if (!isObject(value) || value.kind !== "full") {
    return null;
  }
  const path = snapshotPath(value.pathInSnapshot);
  const hash = sha256(value.sha256);
  const bytes = int(value.bytes);
  const firstLsn = lsn(value.firstLsn);
  const lastLsn = lsn(value.lastLsn);
  const start = time(value.backupStart);
  const finish = time(value.backupFinish);
  const copyOnly = bool(value.copyOnly);
  if (
    path === null ||
    hash === null ||
    bytes === null ||
    firstLsn === null ||
    lastLsn === null ||
    start === null ||
    finish === null ||
    copyOnly === null
  ) {
    return null;
  }
  return compact({
    kind: "full" as const,
    copyOnly,
    compressed: bool(value.compressed) ?? false,
    checksum: bool(value.checksum) ?? false,
    pathInSnapshot: path,
    sha256: hash,
    bytes,
    firstLsn,
    lastLsn,
    databaseBackupLsn: optional(lsn(value.databaseBackupLsn)),
    checkpointLsn: optional(lsn(value.checkpointLsn)),
    firstRecoveryForkGuid: optional(guid(value.firstRecoveryForkGuid)),
    lastRecoveryForkGuid: optional(guid(value.lastRecoveryForkGuid)),
    beginsLogChain: bool(value.beginsLogChain) ?? false,
    hasBulkLoggedData: bool(value.hasBulkLoggedData) ?? false,
    backupStart: start,
    backupFinish: finish,
    fileList: list(value.fileList, MAX_SQL_FILES, readSqlBackupFile),
  });
}

function readBackupDatabase(value: unknown): SqlBackupDatabaseReport | null {
  if (!isObject(value)) {
    return null;
  }
  const dbName = name(value.name, MAX_SQL_NAME);
  const outcome = oneOf(value.outcome, ["backed_up", "skipped", "failed"] as const);
  if (dbName === null || outcome === null) {
    return null;
  }
  const backup = outcome === "backed_up" ? readBackupFacts(value.backup) : null;
  const familyGuid = guid(value.familyGuid);
  const databaseGuid = guid(value.databaseGuid);
  // A backup the server cannot place (no identity, no facts) is reported as failed, not stored.
  if (
    outcome === "backed_up" &&
    (backup === null || familyGuid === null || databaseGuid === null)
  ) {
    return compact({
      name: dbName,
      familyGuid: optional(familyGuid),
      databaseGuid: optional(databaseGuid),
      recoveryModel: optional(recoveryModel(value.recoveryModel)),
      outcome: "failed" as const,
      code: "sql_backup_mismatch",
      message: "The agent reported a backup without the facts the server needs to keep it.",
    });
  }
  return compact({
    name: dbName,
    familyGuid: optional(familyGuid),
    databaseGuid: optional(databaseGuid),
    recoveryModel: optional(recoveryModel(value.recoveryModel)),
    outcome,
    backup: optional(backup),
    code: optional(code(value.code)),
    message: message(value.message),
  });
}

/** The `sql` part of a finish request; undefined for none or a malformed one. */
export function parseSqlBackupReport(value: unknown): SqlBackupReport | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const instance = name(value.instance, MAX_SQL_INSTANCE_NAME);
  if (instance === null) {
    return undefined;
  }
  return { instance, databases: list(value.databases, MAX_SQL_DATABASES, readBackupDatabase) };
}

// ---------------------------------------------------------------------------
// The end of a `sql_verify` and a `sql_restore` run
// ---------------------------------------------------------------------------

export interface SqlCheckdbError {
  number: number;
  level?: number;
  state?: number;
  message: string;
  repairLevel?: string;
  objectId?: number;
  indexId?: number;
}

export interface SqlCheckdbResult {
  ran: boolean;
  physicalOnly: boolean;
  errors: SqlCheckdbError[];
  durationMs?: number;
}

export interface SqlServerError {
  number: number;
  severity?: number;
  state?: number;
  message: string;
}

export interface SqlRestoreStep {
  ok: boolean;
  errors: SqlServerError[];
}

function readCheckdbError(value: unknown): SqlCheckdbError | null {
  if (!isObject(value)) {
    return null;
  }
  const number = int(value.number, 0, 2_147_483_647);
  if (number === null) {
    return null;
  }
  return compact({
    number,
    level: optional(int(value.level, 0, 25)),
    state: optional(int(value.state, 0, 255)),
    message: message(value.message) ?? "",
    repairLevel: optional(code(value.repairLevel)),
    objectId: optional(int(value.objectId, -2_147_483_648, 2_147_483_647)),
    indexId: optional(int(value.indexId, -1, 2_147_483_647)),
  });
}

function readServerError(value: unknown): SqlServerError | null {
  if (!isObject(value)) {
    return null;
  }
  const number = int(value.number, 0, 2_147_483_647);
  if (number === null) {
    return null;
  }
  return compact({
    number,
    severity: optional(int(value.severity, 0, 25)),
    state: optional(int(value.state, 0, 255)),
    message: message(value.message) ?? "",
  });
}

function readCheckdb(value: unknown): SqlCheckdbResult | null {
  if (!isObject(value)) {
    return null;
  }
  const ran = bool(value.ran);
  if (ran === null) {
    return null;
  }
  // An error list cut at its bound still says "errors": the count is what matters.
  const errors = Array.isArray(value.errors) ? value.errors : [];
  const parsed = list(errors, MAX_CHECKDB_ERRORS, readCheckdbError);
  if (errors.length > 0 && parsed.length === 0) {
    parsed.push({ number: 0, message: "CHECKDB reported errors the server could not read." });
  }
  return compact({
    ran,
    physicalOnly: bool(value.physicalOnly) ?? false,
    errors: parsed,
    durationMs: optional(int(value.durationMs)),
  });
}

function readRestoreStep(value: unknown): SqlRestoreStep | null {
  if (!isObject(value)) {
    return null;
  }
  const ok = bool(value.ok);
  if (ok === null) {
    return null;
  }
  return { ok, errors: list(value.errors, MAX_CHECKDB_ERRORS, readServerError) };
}

export interface SqlVerifyDatabaseReport {
  databaseId?: string;
  backupId?: string;
  name: string;
  method: string;
  verifyName?: string;
  fetched: boolean;
  /** null: not compared (nothing was fetched). */
  sha256Match: boolean | null;
  restore: SqlRestoreStep | null;
  checkdb: SqlCheckdbResult | null;
  dropped?: boolean;
  backupLsn?: string;
  logsApplied?: number;
  durationMs?: number;
  code?: string;
  message?: string;
}

export interface SqlVerifyReport {
  instance: string;
  databases: SqlVerifyDatabaseReport[];
}

function readVerifyDatabase(value: unknown): SqlVerifyDatabaseReport | null {
  if (!isObject(value)) {
    return null;
  }
  const dbName = name(value.name, MAX_SQL_NAME);
  if (dbName === null) {
    return null;
  }
  return compact({
    databaseId: optional(guid(value.databaseId)),
    backupId: optional(guid(value.backupId)),
    name: dbName,
    method:
      typeof value.method === "string" && /^[a-z][a-z+_]{0,39}$/.test(value.method)
        ? value.method
        : "unknown",
    verifyName: optional(name(value.verifyName, MAX_SQL_NAME)),
    fetched: bool(value.fetched) ?? false,
    sha256Match: bool(value.sha256Match),
    restore: readRestoreStep(value.restore),
    checkdb: readCheckdb(value.checkdb),
    dropped: optional(bool(value.dropped)),
    backupLsn: optional(lsn(value.backupLsn)),
    logsApplied: optional(int(value.logsApplied, 0, 100_000)),
    durationMs: optional(int(value.durationMs)),
    code: optional(code(value.code)),
    message: message(value.message),
  });
}

/** The `sqlVerify` part of a finish request; undefined for none or a malformed one. */
export function parseSqlVerifyReport(value: unknown): SqlVerifyReport | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const instance = name(value.instance, MAX_SQL_INSTANCE_NAME);
  if (instance === null) {
    return undefined;
  }
  return { instance, databases: list(value.databases, MAX_SQL_DATABASES, readVerifyDatabase) };
}

export interface SqlRestoreReport {
  backupId?: string;
  instance: string;
  newName: string;
  fetched: boolean;
  sha256Match: boolean | null;
  restored: boolean;
  moves: { logicalName: string; physicalName: string }[];
  checkdb: SqlCheckdbResult | null;
  durationMs?: number;
  code?: string;
  message?: string;
}

/** The `sqlRestore` part of a finish request; undefined for none or a malformed one. */
export function parseSqlRestoreReport(value: unknown): SqlRestoreReport | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const instance = name(value.instance, MAX_SQL_INSTANCE_NAME);
  const newName = name(value.newName, MAX_SQL_NAME);
  if (instance === null || newName === null) {
    return undefined;
  }
  return compact({
    backupId: optional(guid(value.backupId)),
    instance,
    newName,
    fetched: bool(value.fetched) ?? false,
    sha256Match: bool(value.sha256Match),
    restored: bool(value.restored) ?? false,
    moves: list(value.moves, MAX_SQL_FILES, (item) => {
      if (!isObject(item)) return null;
      const logicalName = name(item.logicalName, MAX_SQL_NAME);
      const physicalName = name(item.physicalName, 1024);
      return logicalName !== null && physicalName !== null ? { logicalName, physicalName } : null;
    }),
    checkdb: readCheckdb(value.checkdb),
    durationMs: optional(int(value.durationMs)),
    code: optional(code(value.code)),
    message: message(value.message),
  });
}
