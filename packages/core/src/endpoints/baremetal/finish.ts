/**
 * The end of a bare metal recovery as the server stores it (docs/BAREMETAL.md 9.8, 10.17), shared
 * by the API (the ISO's `POST /agent/v1/recovery/sessions/current/finish`) and the worker (the
 * finish a boot probe relays through the lab, 12.3): one schema for the body, one redaction, one
 * rule for a reported success. What only the database knows (whether the report's snapshot is a
 * whole machine backup of the machine) is the caller's; @restow/db `finishRecovery` writes it.
 */
import { z } from "zod";
import { redactAgentLog, redactAgentMessage } from "../run-redact.js";
import { noControlChars } from "./canonical.js";
import { isServerFinishWarningCode, type SuccessContradiction } from "./verification.js";

/** A string the ISO reports: at most `max` characters, no control characters (4.2). */
const isoText = (max: number) =>
  z.string().max(max).refine(noControlChars, "control character in string");
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The body of a finish (9.8); unknown fields are ignored, every text field has a limit. */
export const recoveryFinishSchema = z.object({
  status: z.enum(["succeeded", "failed", "cancelled"]),
  verification: z
    .record(z.string(), z.unknown())
    .default({})
    .refine(
      (value) => JSON.stringify(value).length <= 64 * 1024,
      "verification larger than 64 KiB",
    ),
  warnings: z
    .array(z.object({ code: isoText(64), message: isoText(1000) }))
    .max(200)
    .default([]),
  durationSeconds: count.default(0),
});
export type RecoveryFinishInput = z.infer<typeof recoveryFinishSchema>;

/**
 * A value the ISO reported (the verification report), every string in it redacted line by line
 * (a command's output keeps its lines); below 32 levels the rest is kept as redacted JSON text.
 */
export function redactIsoValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return redactAgentLog(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth > 32) {
    return redactAgentLog(JSON.stringify(value));
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactIsoValue(item, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactIsoValue(item, depth + 1)]),
  );
}

export interface RecoveryFinishWarning {
  code: string;
  message: string;
}

/**
 * What the server keeps of a reported finish before it judges it: the verification report and the
 * warnings redacted, and no warning with a code of the server's own (`SERVER_FINISH_WARNING_CODES`):
 * those are the server's to give, the ISO cannot report them.
 */
export function redactRecoveryFinish(input: RecoveryFinishInput): {
  verification: Record<string, unknown>;
  warnings: RecoveryFinishWarning[];
} {
  return {
    verification: redactIsoValue(input.verification) as Record<string, unknown>,
    warnings: input.warnings
      .map((warning) => ({
        code: redactAgentMessage(warning.code, 64),
        message: redactAgentMessage(warning.message, 1000),
      }))
      .filter((warning) => !isServerFinishWarningCode(warning.code)),
  };
}

/**
 * The state a finish is stored as, and its warnings: the reported one, except a `succeeded` the
 * report does not bear out (`contradiction`), which ends as `failed` with the reason as the first
 * warning.
 */
export function settleRecoveryFinish(
  reported: RecoveryFinishInput["status"],
  warnings: readonly RecoveryFinishWarning[],
  contradiction: SuccessContradiction | null,
): { status: RecoveryFinishInput["status"]; warnings: RecoveryFinishWarning[] } {
  if (!contradiction) {
    return { status: reported, warnings: [...warnings] };
  }
  return {
    status: "failed",
    warnings: [{ code: contradiction.code, message: contradiction.checks.join(", ") }, ...warnings],
  };
}
