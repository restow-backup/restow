/**
 * The restore planner's wire formats (docs/BAREMETAL.md 10.1, 12.1 L3, 12.2): what the worker
 * hands `restow-agent baremetal plan` on stdin (the manifest, then the facts `restow-plan-facts-v1`)
 * and what the planner prints (`restow-plan-v1`). The planner itself is the agent's
 * (agent/internal/baremetal/plan.go); the server never plans, it only runs the binary in a sandbox
 * (apps/worker/src/endpoints/planner.ts) and reads its answer here. The shared test data
 * (agent/internal/baremetal/testdata/{facts,targets,plans}, plan-codes.json) proves both sides
 * agree.
 *
 * Objects are loose: a newer planner may add fields, and they pass. Every string is free of
 * control characters, every number an integer from 0 to 2^53-1.
 */
import { z } from "zod";
import { noControlChars } from "./canonical.js";

export const PLAN_FORMAT = "restow-plan-v1";
export const PLAN_FACTS_FORMAT = "restow-plan-facts-v1";
export const PLAN_TARGET_FORMAT = "restow-plan-target-v1";

/** The targets the server plans against (`--target`); a file target comes with M4's `recover`. */
export const PLAN_TARGETS = ["same", "minimal", "other-controller"] as const;
export type PlanTarget = (typeof PLAN_TARGETS)[number];

/** The largest text of one kernel's module list in the facts (`modules.alias` and the others). */
export const MAX_KERNEL_FACT_BYTES = 8 * 1024 * 1024;
/** The largest facts document the planner reads. */
export const MAX_PLAN_FACTS_BYTES = 32 * 1024 * 1024;

/**
 * The problems the planner reports (a plan with one of them is not executable). Sorted; equal to
 * `problems` of agent/internal/baremetal/testdata/plan-codes.json (plan.test.ts).
 */
export const PLAN_PROBLEM_CODES = [
  "adopt_incomplete",
  "bios_4kn",
  "btrfs_raid_missing_device",
  "firmware_mode_mismatch",
  "identity_conflict",
  "layout_unsupported",
  "lvm_raid_missing_pv",
  "mapping_invalid",
  "md_too_few_members",
  "mkfs_feature_unknown",
  "mkfs_unsupported_type",
  "mok_key_missing",
  "multipath_detected",
  "sector_size_incompatible",
  "secure_boot_ca_missing",
  "secure_boot_revoked",
  "secure_boot_sbat_revoked",
  "sed_locked",
  "shrink_needs_confirmation",
  "storage_driver_missing",
  "target_missing",
  "target_too_small",
  "target_unusable",
] as const;
export type PlanProblemCode = (typeof PLAN_PROBLEM_CODES)[number];

/** The warnings the planner reports. Sorted; equal to `warnings` of plan-codes.json. */
export const PLAN_WARNING_CODES = [
  "bios_boot_disk",
  "btrfs_csum_assumed",
  "driver_facts_missing",
  "dual_boot_windows_not_restored",
  "esp_grown_4kn",
  "ext_block_size_raised",
  "fallback_kernel_driver_missing",
  "fs_not_recreated",
  "grow_not_last",
  "keyfile_regenerated",
  "luks_sector_size_changed",
  "luks_tokens_not_restored",
  "lv_shrunk",
  "lvm_mixed_block_sizes_allowed",
  "mbr_2tib_limit",
  "md_degraded_first_boot",
  "mok_enroll_required",
  "nic_driver_missing",
  "non_systemd_init",
  "other_controller_driver_missing",
  "partition_realigned",
  "partition_shrunk",
  "raw_lvs_created_empty",
  "raw_lvs_skipped",
  "redundant_boot_partition_dropped",
  "restore_size_estimated",
  "secure_boot_dbx_unknown",
  "secure_boot_disabled_by_choice",
  "secure_boot_unsigned_chain",
  "untested_distribution",
  "vfat_sector_size_changed",
] as const;
export type PlanWarningCode = (typeof PLAN_WARNING_CODES)[number];

/** Why the planner refused its input (`error.code` of a refused run). */
export const PLAN_ERROR_CODES = [
  "manifest_invalid",
  "facts_invalid",
  "target_invalid",
  "choices_invalid",
  "input_too_large",
  "platform_unsupported",
  "planner_internal",
] as const;
export type PlanErrorCode = (typeof PLAN_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function text(max = 4096) {
  return z
    .string()
    .refine(noControlChars, { message: "control character" })
    .refine((value) => utf8Length(value) <= max, { message: `longer than ${max} bytes` });
}

/**
 * A text that may hold line breaks (the module lists of a kernel): everything but the other
 * control characters.
 */
function multiline(max: number) {
  return z
    .string()
    .refine((value) => noControlChars(value.replace(/[\n\t]/g, " ")), {
      message: "control character",
    })
    .refine((value) => utf8Length(value) <= max, { message: `longer than ${max} bytes` });
}

const S = text();
const SN = S.nullable();
const I = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const IN = I.nullable();
const B = z.boolean();
const HEX = z.string().regex(/^[0-9a-f]{64}$/, { message: "not a lowercase hex SHA-256" });

// ---------------------------------------------------------------------------
// Facts (worker to planner)
// ---------------------------------------------------------------------------

export const restoreSizeSchema = z.looseObject({ bytes: I, files: I, inodes: I });
export type RestoreSize = z.infer<typeof restoreSizeSchema>;

export const planFactsSchema = z.looseObject({
  format: z.literal(PLAN_FACTS_FORMAT),
  kernels: z
    .array(
      z.looseObject({
        version: S,
        default: B,
        /** `modules.alias` of the kernel; empty when the snapshot has none. */
        modulesAlias: multiline(MAX_KERNEL_FACT_BYTES),
        /** `modules.builtin`. */
        modulesBuiltin: multiline(MAX_KERNEL_FACT_BYTES),
        /** `modules.builtin.modinfo` with every NUL replaced by a line break. */
        modulesBuiltinModinfo: multiline(MAX_KERNEL_FACT_BYTES),
      }),
    )
    .max(64),
  /** Per mount target: what a restore writes there (12.1 L8). */
  restoreSizes: z.record(S, restoreSizeSchema),
  mokFiles: z.array(z.looseObject({ path: S, present: B, sha256: HEX.nullable() })).max(16),
});
export type PlanFacts = z.infer<typeof planFactsSchema>;

// ---------------------------------------------------------------------------
// Target and choices (written by `recover` in M4; the server uses the keywords)
// ---------------------------------------------------------------------------

const targetSignatureSchema = z.looseObject({
  kind: z.enum(["disk_guid", "part_uuid", "fs", "md", "pv", "luks"]),
  uuid: S,
});

const targetDiskSchema = z.looseObject({
  id: S,
  path: S,
  sizeBytes: I,
  logicalSectorSize: I,
  physicalSectorSize: I,
  model: SN.optional(),
  serial: SN.optional(),
  wwn: SN.optional(),
  eui64: SN.optional(),
  nguid: SN.optional(),
  nsid: IN.optional(),
  transport: SN,
  removable: B,
  readOnly: B,
  zoned: S,
  ioError: B,
  identity: SN,
  driverChain: z.array(S).max(64),
  driverModaliases: z.array(S).max(64),
  signatures: z.array(targetSignatureSchema).max(1024),
});

export const planTargetSchema = z.looseObject({
  format: z.literal(PLAN_TARGET_FORMAT),
  kind: S,
  firmware: z.looseObject({
    mode: z.enum(["uefi", "bios"]),
    secureBoot: B.nullable(),
    setupMode: B.nullable(),
    db: z.array(z.looseObject({ subject: S, sha256: HEX })).max(64),
    dbx: z.looseObject({ hashes: z.array(HEX).max(4096), certs: z.array(HEX).max(256) }).nullable(),
    sbatLevel: z.array(text(256)).max(64),
    mokList: z.array(z.looseObject({ subject: SN, sha256: HEX })).max(64),
  }),
  disks: z.array(targetDiskSchema).max(64),
  others: z.array(targetDiskSchema).max(256),
  nics: z.array(z.looseObject({ name: S, mac: SN, driver: SN, modalias: SN })).max(64),
  ramBytes: I,
});
export type PlanTargetDocument = z.infer<typeof planTargetSchema>;

export const planChoicesSchema = z.looseObject({
  diskMapping: z.record(S, S).optional(),
  adopt: z.array(S).max(1024).optional(),
  shrink: z.enum(["none", "auto"]).optional(),
  rawLvs: z.enum(["skip", "create"]).optional(),
  secureBootOff: B.optional(),
  allowDevices: z.array(S).max(64).optional(),
});
export type PlanChoices = z.infer<typeof planChoicesSchema>;

// ---------------------------------------------------------------------------
// Output (planner to worker)
// ---------------------------------------------------------------------------

export const planFindingSchema = z.looseObject({
  code: S,
  severity: z.enum(["problem", "warning"]),
  ref: SN,
  message: text(8192),
  params: z.record(z.string(), z.unknown()),
});
export type PlanFinding = z.infer<typeof planFindingSchema>;

const minimumSizesSchema = z.looseObject({
  disks: z.array(z.looseObject({ disk: S, kname: S, sizeBytes: I, minBytes: I })),
  filesystems: z.array(z.looseObject({ fs: S, mount: SN, type: S, restoreBytes: I, minBytes: I })),
  lvs: z.array(z.looseObject({ vg: S, lv: S, minBytes: I })),
  thinPools: z.array(z.looseObject({})),
});
export type PlanMinimumSizes = z.infer<typeof minimumSizesSchema>;

const stepSchema = z.looseObject({
  n: I,
  phase: S,
  kind: S,
  target: SN,
  args: z.array(text(65536)),
  /** Never a secret (C-M2-5); the sfdisk script and the like. */
  stdin: z
    .string()
    .max(1024 * 1024)
    .nullable(),
  stdinSecret: z.enum(["passphrase", "old_passphrase", "keyfile"]).nullable(),
  reason: text(8192),
});

const planSchema = z
  .looseObject({
    format: z.literal(PLAN_FORMAT),
    target: S,
    ok: B,
    problems: z.array(planFindingSchema),
    warnings: z.array(planFindingSchema),
    mapping: z.array(z.looseObject({ source: S, target: SN, action: S, reason: SN })),
    adopted: z.array(z.looseObject({})),
    minimumSizes: minimumSizesSchema,
    disks: z.array(z.looseObject({})),
    steps: z.array(stepSchema),
    secureBoot: z.looseObject({
      checked: B,
      targetSecureBoot: B.nullable(),
      loaders: z.array(z.looseObject({ path: S, verdict: S, detail: SN })),
    }),
    drivers: z.looseObject({
      kernel: SN,
      fallback: SN,
      storage: z.array(z.looseObject({})),
      nics: z.array(z.looseObject({})),
    }),
  })
  .superRefine((plan, ctx) => {
    if (plan.ok !== (plan.problems.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["ok"],
        message: "ok must be true exactly without problems",
      });
    }
    for (const [list, severity] of [
      [plan.problems, "problem"],
      [plan.warnings, "warning"],
    ] as const) {
      list.forEach((finding, index) => {
        if (finding.severity !== severity) {
          ctx.addIssue({
            code: "custom",
            path: [severity === "problem" ? "problems" : "warnings", index, "severity"],
            message: `not a ${severity}`,
          });
        }
      });
    }
  });
export type BaremetalPlan = z.infer<typeof planSchema>;

const planErrorSchema = z.looseObject({
  format: z.literal(PLAN_FORMAT),
  ok: z.literal(false),
  error: z.looseObject({ code: z.enum(PLAN_ERROR_CODES), message: text(8192) }),
});
export type PlanError = z.infer<typeof planErrorSchema>;

/** Either a plan or the refusal of the input. */
export const planOutputSchema = z.union([planErrorSchema, planSchema]);
export type PlanOutput = z.infer<typeof planOutputSchema>;

export type ParsedPlanOutput =
  | { kind: "plan"; plan: BaremetalPlan }
  | { kind: "refused"; error: PlanError["error"] }
  | { kind: "invalid"; reason: string };

/** Read what the planner printed (one JSON value on stdout). */
export function parsePlanOutput(output: string): ParsedPlanOutput {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return { kind: "invalid", reason: "the planner's output is not JSON" };
  }
  const parsed = planOutputSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      kind: "invalid",
      reason: `the planner's output does not match ${PLAN_FORMAT}: ${first ? `${first.path.join(".")}: ${first.message}` : "invalid"}`,
    };
  }
  const output_ = parsed.data;
  if ("error" in output_ && output_.error) {
    return { kind: "refused", error: (output_ as PlanError).error };
  }
  return { kind: "plan", plan: output_ as BaremetalPlan };
}
