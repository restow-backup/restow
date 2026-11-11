/**
 * What the recovery ISO reports at the end of a restore (docs/BAREMETAL.md 10.17, 9.8): the
 * verification report `restow-verify-v1` in `POST /agent/v1/recovery/sessions/current/finish` and
 * the codes of its warnings. `restow-agent recover` writes it (agent/internal/recovery/verify.go,
 * the types in agent/internal/api/recovery.go); the server stores it as the ISO sent it (redacted,
 * at most 64 KiB) and hands the web app only what parses here, never the raw value. A finish that
 * reports `succeeded` is held against it ({@link successContradiction}): without a report that
 * bears the success out, the server stores the recovery as failed.
 *
 * The codes are shared with the agent: agent/internal/recovery/testdata/recover-codes.json holds
 * the problems and warnings `recover` adds to the planner's (agent/internal/baremetal/testdata/
 * plan-codes.json), the ids of the ten checks and the hints with their parameters
 * (verification.test.ts proves both sides name the same). Neither side adds a code alone.
 *
 * The schema is lenient where a newer ISO may add something (extra fields pass, an unknown check
 * id or hint code is kept and shown by its id) and strict where the page relies on it: the format,
 * the results, the limits of 4.2 (no control characters, evidence values are short strings,
 * integers or booleans, at most 50 findings per check).
 */
import { z } from "zod";
import { noControlChars } from "./canonical.js";
import { PLAN_PROBLEM_CODES, PLAN_WARNING_CODES } from "./plan.js";

export const VERIFICATION_FORMAT = "restow-verify-v1";

/** The largest verification report the server keeps (9.8). */
export const MAX_VERIFICATION_BYTES = 64 * 1024;
/** Findings per check. */
export const MAX_VERIFICATION_FINDINGS = 50;
/** The longest evidence string. */
export const MAX_EVIDENCE_STRING = 300;

/** Problems `recover` adds to the planner's. Sorted; equal to recover-codes.json. */
export const RECOVER_PROBLEM_CODES = [
  "access_expired",
  "arch_unsupported",
  "clock_wrong",
  "foreign_mapping_open",
  "holders_busy",
  "lvm_filter_multiline",
  "manifest_format_unknown",
  "manifest_invalid",
  "manifest_mismatch",
  "mkfs_readback_mismatch",
  "no_disks_found",
  "partition_readback_mismatch",
  "recovery_too_old",
  "restore_failed",
  "spki_mismatch",
  "step_failed",
  "system_files_incomplete",
  "tls_untrusted",
  "verify_failed",
] as const;
export type RecoverProblemCode = (typeof RECOVER_PROBLEM_CODES)[number];

/** Warnings `recover` adds to the planner's. Sorted; equal to recover-codes.json. */
export const RECOVER_WARNING_CODES = [
  "boot_space_low",
  "cancel_requested",
  "device_name_refs_found",
  "initramfs_not_rebuilt",
  "low_memory",
  "mok_enroll_pending",
  "nic_rename_skipped",
  "old_disk_present",
  "quota_rescan_failed",
  "restore_file_errors",
  "selinux_autorelabel",
] as const;
export type RecoverWarningCode = (typeof RECOVER_WARNING_CODES)[number];

/** The ten checks after a restore (10.17), in the order the page shows them. */
export const VERIFICATION_CHECK_IDS = [
  "restic_verify",
  "storage_stack",
  "fstab",
  "crypttab",
  "initramfs",
  "boot_entries",
  "boot_config",
  "identity_conflicts",
  "mount_points",
  "secure_boot",
] as const;
export type VerificationCheckId = (typeof VERIFICATION_CHECK_IDS)[number];

/** The parameters of each hint for the time after the restore (step 6 of the wizard). */
export const RECOVERY_HINT_PARAMS = {
  bios_boot_disk: ["model", "identity"],
  device_name_refs: ["path", "line"],
  initramfs_not_adapted: ["kernel"],
  keymap_at_boot: ["layout"],
  luks_reenroll_token: ["volume", "tokenTypes"],
  md_add_disk: ["array"],
  md_degraded_first_boot: ["array"],
  mok_enroll: [],
  nic_mapped: ["oldName", "oldMac", "newMac"],
  old_disk_present: ["model", "identity"],
  secure_boot_disabled: [],
  selinux_autorelabel: [],
} as const satisfies Record<string, readonly string[]>;
export type RecoveryHintCode = keyof typeof RECOVERY_HINT_PARAMS;

/** The hint codes, sorted (`hints` of recover-codes.json). */
export const RECOVERY_HINT_CODES = Object.keys(RECOVERY_HINT_PARAMS).sort() as RecoveryHintCode[];

/**
 * Every code a finish `warnings[]` entry may carry: the planner's problems and warnings and the
 * ones `recover` adds. Sorted, without duplicates.
 */
export const FINISH_WARNING_CODES: readonly string[] = [
  ...new Set<string>([
    ...PLAN_PROBLEM_CODES,
    ...PLAN_WARNING_CODES,
    ...RECOVER_PROBLEM_CODES,
    ...RECOVER_WARNING_CODES,
  ]),
].sort();

const FINISH_CODE_SET = new Set(FINISH_WARNING_CODES);

/** Whether a reported warning code is one the page has a text for. */
export function isFinishWarningCode(code: string): boolean {
  return FINISH_CODE_SET.has(code);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function text(max: number) {
  return z.string().max(max).refine(noControlChars, { message: "control character" });
}

const CODE = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, { message: "not a code" });
const RESULT = z.enum(["ok", "warning", "failed"]);
const COUNT = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const TIME = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/, { message: "not a UTC time" });

/** An evidence value: a short string, an integer or a boolean (no nesting, no file contents). */
const evidenceValue = z.union([
  text(MAX_EVIDENCE_STRING),
  z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  z.boolean(),
]);

const paramsSchema = z.record(text(64), text(MAX_EVIDENCE_STRING)).default({});

const findingSchema = z.looseObject({
  code: CODE,
  ref: text(MAX_EVIDENCE_STRING).nullable().default(null),
  message: text(1000).default(""),
  params: paramsSchema,
});

const checkSchema = z.looseObject({
  id: CODE,
  result: RESULT,
  findings: z.array(findingSchema).max(MAX_VERIFICATION_FINDINGS).default([]),
  evidence: z.record(text(64), evidenceValue).default({}),
});

const hintSchema = z.looseObject({ code: CODE, params: paramsSchema });

const fixupSchema = z.looseObject({
  path: text(MAX_EVIDENCE_STRING),
  rule: text(64),
  backup: text(MAX_EVIDENCE_STRING).nullable().default(null),
});

export const recoveryVerificationSchema = z.looseObject({
  format: z.literal(VERIFICATION_FORMAT),
  result: RESULT,
  snapshotId: text(64),
  planSha256: z.string().regex(/^[0-9a-f]{64}$/, { message: "not a lowercase hex SHA-256" }),
  startedAt: TIME,
  finishedAt: TIME,
  restoreErrors: COUNT.default(0),
  checks: z.array(checkSchema).max(32),
  hints: z.array(hintSchema).max(200).default([]),
  fixups: z.array(fixupSchema).max(200).default([]),
  notAdaptedKernels: z.array(text(128)).max(64).default([]),
});

export type RecoveryVerification = z.infer<typeof recoveryVerificationSchema>;
export type RecoveryVerificationCheck = RecoveryVerification["checks"][number];
export type RecoveryVerificationHint = RecoveryVerification["hints"][number];

/**
 * The verification report the ISO sent, or null when there is none or it does not match
 * `restow-verify-v1` (an older or a broken ISO): the page then shows the warnings and the log only.
 */
export function parseRecoveryVerification(raw: unknown): RecoveryVerification | null {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  if (Object.keys(raw).length === 0) {
    return null;
  }
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(raw), "utf8");
  } catch {
    return null;
  }
  if (size > MAX_VERIFICATION_BYTES) {
    return null;
  }
  const parsed = recoveryVerificationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// A reported success against its report
// ---------------------------------------------------------------------------

/**
 * Codes the server itself adds to the warnings of a finish (9.8): a finish that reports
 * `succeeded` without a report that bears it out is stored as `failed` with one of them, and the
 * rebind from the ISO stays locked. The ISO never sends them (the server drops a reported warning
 * with such a code), and they are no finish warning codes of recover-codes.json. Sorted.
 *
 *   - `success_checks_failed`: the report's result is `failed`, or one of its checks is;
 *   - `success_checks_missing`: one of the ten checks of 10.17 is not in the report;
 *   - `success_report_missing`: no report, or one that does not parse as `restow-verify-v1`;
 *   - `success_snapshot_unknown`: the report names a snapshot that is no whole machine backup of
 *     the session's machine (the server looks that up, not this module).
 */
export const SERVER_FINISH_WARNING_CODES = [
  "success_checks_failed",
  "success_checks_missing",
  "success_report_missing",
  "success_snapshot_unknown",
] as const;
export type ServerFinishWarningCode = (typeof SERVER_FINISH_WARNING_CODES)[number];

const SERVER_FINISH_CODE_SET: ReadonlySet<string> = new Set(SERVER_FINISH_WARNING_CODES);

/** Whether a warning code is one only the server may put on a finish. */
export function isServerFinishWarningCode(code: string): boolean {
  return SERVER_FINISH_CODE_SET.has(code);
}

/** Why a reported success does not hold, and the checks it is about (in the order of 10.17). */
export interface SuccessContradiction {
  code: ServerFinishWarningCode;
  checks: string[];
}

/**
 * Whether the report a finish carries bears out the `succeeded` it claims (10.17: a failed check
 * means the report to the server is `failed`): null when it does, otherwise the first reason in
 * the order no report, a failed result or check, a missing check. A check counts as present by its
 * id, whatever it found; one the ISO did not run and reports as a warning is still there. The
 * caller passes the report as it stores it, so the state and what the page shows cannot disagree.
 */
export function successContradiction(raw: unknown): SuccessContradiction | null {
  const report = parseRecoveryVerification(raw);
  if (!report) {
    return { code: "success_report_missing", checks: [] };
  }
  const failed = [
    ...new Set(report.checks.filter((check) => check.result === "failed").map((check) => check.id)),
  ];
  if (report.result === "failed" || failed.length > 0) {
    return { code: "success_checks_failed", checks: failed };
  }
  const present = new Set(report.checks.map((check) => check.id));
  const missing = VERIFICATION_CHECK_IDS.filter((id) => !present.has(id));
  if (missing.length > 0) {
    return { code: "success_checks_missing", checks: missing };
  }
  return null;
}
