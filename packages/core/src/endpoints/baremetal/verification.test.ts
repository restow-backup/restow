import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLAN_PROBLEM_CODES, PLAN_WARNING_CODES } from "./plan.js";
import {
  FINISH_WARNING_CODES,
  isFinishWarningCode,
  isServerFinishWarningCode,
  parseRecoveryVerification,
  RECOVER_PROBLEM_CODES,
  RECOVER_WARNING_CODES,
  RECOVERY_HINT_CODES,
  RECOVERY_HINT_PARAMS,
  SERVER_FINISH_WARNING_CODES,
  successContradiction,
  VERIFICATION_CHECK_IDS,
} from "./verification.js";

/**
 * The codes and examples of `restow-agent recover`, written and owned by the Go agent
 * (agent/internal/recovery/testdata, C-M4-6): the lists here must equal recover-codes.json, and
 * every example report the ISO would send must parse.
 */
const TESTDATA = fileURLToPath(
  new URL("../../../../../agent/internal/recovery/testdata/", import.meta.url),
);

const codes = JSON.parse(readFileSync(join(TESTDATA, "recover-codes.json"), "utf8")) as {
  problems: string[];
  warnings: string[];
  checks: string[];
  hints: string[];
  hintParams: Record<string, string[]>;
};

const examples = existsSync(join(TESTDATA, "verification"))
  ? readdirSync(join(TESTDATA, "verification")).filter((name) => name.endsWith(".json"))
  : [];

const example = {
  format: "restow-verify-v1",
  result: "warning",
  snapshotId: "4f2a9c1d",
  planSha256: "9b1e".padEnd(64, "0"),
  startedAt: "2026-11-05T09:12:00Z",
  finishedAt: "2026-11-05T10:40:13Z",
  restoreErrors: 0,
  checks: [
    {
      id: "restic_verify",
      result: "ok",
      findings: [],
      evidence: { files: 412233, errors: 0 },
    },
    {
      id: "initramfs",
      result: "warning",
      findings: [
        {
          code: "initramfs_not_rebuilt",
          ref: "6.1.0-25-amd64",
          message: "not enough space on /boot",
          params: {},
        },
      ],
      evidence: {
        kernel: "6.1.0-27-amd64",
        image: "/boot/initrd.img-6.1.0-27-amd64",
        readable: true,
        bootFreePercent: 23,
      },
    },
  ],
  hints: [
    { code: "luks_reenroll_token", params: { volume: "c0", tokenTypes: "systemd-tpm2" } },
    { code: "mok_enroll", params: {} },
  ],
  fixups: [
    { path: "/etc/fstab", rule: "device_names", backup: "/etc/fstab.restow-20261105T101500Z" },
  ],
  notAdaptedKernels: ["6.1.0-25-amd64"],
};

describe("recover-codes.json", () => {
  it("names the same codes, checks and hints as @restow/core", () => {
    expect([...RECOVER_PROBLEM_CODES]).toEqual(codes.problems);
    expect([...RECOVER_WARNING_CODES]).toEqual(codes.warnings);
    expect([...VERIFICATION_CHECK_IDS]).toEqual(codes.checks);
    expect([...RECOVERY_HINT_CODES]).toEqual(codes.hints);
    expect(RECOVERY_HINT_PARAMS).toEqual(codes.hintParams);
    expect([...RECOVER_PROBLEM_CODES]).toEqual([...RECOVER_PROBLEM_CODES].sort());
    expect([...RECOVER_WARNING_CODES]).toEqual([...RECOVER_WARNING_CODES].sort());
  });

  it("allows every planner and recover code as a finish warning", () => {
    for (const code of [
      ...PLAN_PROBLEM_CODES,
      ...PLAN_WARNING_CODES,
      ...RECOVER_PROBLEM_CODES,
      ...RECOVER_WARNING_CODES,
    ]) {
      expect(isFinishWarningCode(code), code).toBe(true);
    }
    expect(isFinishWarningCode("made_up")).toBe(false);
    expect(FINISH_WARNING_CODES).toEqual([...FINISH_WARNING_CODES].sort());
  });
});

describe("parseRecoveryVerification", () => {
  it("has the Go examples ok, warning and failed", () => {
    expect([...examples].sort()).toEqual(["failed.json", "ok.json", "warning.json"]);
  });

  it.each(examples)("parses verification/%s with known codes", (name) => {
    const raw = JSON.parse(readFileSync(join(TESTDATA, "verification", name), "utf8"));
    const parsed = parseRecoveryVerification(raw);
    expect(parsed, name).not.toBeNull();
    expect(parsed?.result).toBe(name.replace(/\.json$/, ""));
    for (const check of parsed?.checks ?? []) {
      expect((VERIFICATION_CHECK_IDS as readonly string[]).includes(check.id), check.id).toBe(true);
    }
    for (const hint of parsed?.hints ?? []) {
      const wanted = RECOVERY_HINT_PARAMS[hint.code as keyof typeof RECOVERY_HINT_PARAMS];
      expect(wanted, hint.code).toBeDefined();
      expect(Object.keys(hint.params).sort()).toEqual([...wanted].sort());
    }
  });

  it("parses the contract example and keeps fields a newer ISO adds", () => {
    const parsed = parseRecoveryVerification({ ...example, future: { x: 1 } });
    expect(parsed?.checks.map((check) => check.id)).toEqual(["restic_verify", "initramfs"]);
    expect(parsed?.hints[0]).toEqual({
      code: "luks_reenroll_token",
      params: { volume: "c0", tokenTypes: "systemd-tpm2" },
    });
    expect(parsed?.notAdaptedKernels).toEqual(["6.1.0-25-amd64"]);
  });

  it("is null for nothing, another format, nested evidence, control characters and too much", () => {
    expect(parseRecoveryVerification(null)).toBeNull();
    expect(parseRecoveryVerification({})).toBeNull();
    expect(parseRecoveryVerification([])).toBeNull();
    expect(parseRecoveryVerification({ ...example, format: "restow-verify-v2" })).toBeNull();
    expect(parseRecoveryVerification({ ...example, result: "great" })).toBeNull();
    const nested = structuredClone(example);
    (nested.checks[0] as { evidence: unknown }).evidence = { files: { deep: 1 } };
    expect(parseRecoveryVerification(nested)).toBeNull();
    const control = structuredClone(example);
    (control.checks[1] as { findings: { message: string }[] }).findings[0] = {
      ...control.checks[1]?.findings[0],
      message: "evil\u001b[2J",
    } as never;
    expect(parseRecoveryVerification(control)).toBeNull();
    const long = structuredClone(example);
    (long.checks[1] as { evidence: Record<string, unknown> }).evidence.image = "x".repeat(301);
    expect(parseRecoveryVerification(long)).toBeNull();
    const many = structuredClone(example);
    (many.checks[1] as { findings: unknown[] }).findings = Array.from({ length: 51 }, () => ({
      code: "initramfs_not_rebuilt",
      ref: null,
      message: "",
      params: {},
    }));
    expect(parseRecoveryVerification(many)).toBeNull();
    expect(
      parseRecoveryVerification({
        ...example,
        notAdaptedKernels: Array.from({ length: 60 }, () => "k".repeat(128)),
        fixups: Array.from({ length: 200 }, () => ({
          path: "p".repeat(300),
          rule: "device_names",
          backup: "b".repeat(300),
        })),
      }),
    ).toBeNull();
  });
});

describe("successContradiction", () => {
  const read = (name: string) =>
    JSON.parse(readFileSync(join(TESTDATA, "verification", name), "utf8")) as {
      result: string;
      checks: { id: string; result: string }[];
    };
  /** All ten checks, `ok` unless named. */
  const full = (results: Record<string, string> = {}) => ({
    ...example,
    result: "ok",
    checks: VERIFICATION_CHECK_IDS.map((id) => ({
      id,
      result: results[id] ?? "ok",
      findings: [],
      evidence: {},
    })),
  });

  it("takes the agent's ok and warning examples and refuses its failed one", () => {
    expect(successContradiction(read("ok.json"))).toBeNull();
    expect(successContradiction(read("warning.json"))).toBeNull();
    const failed = read("failed.json");
    expect(successContradiction(failed)).toEqual({
      code: "success_checks_failed",
      checks: failed.checks.filter((check) => check.result === "failed").map((check) => check.id),
    });
  });

  it("needs a report that parses as restow-verify-v1", () => {
    for (const raw of [
      undefined,
      null,
      {},
      [],
      "ok",
      { fstab: "ok" },
      { ...full(), format: "restow-verify-v9" },
      { ...full(), planSha256: "not a hash" },
      { ...full(), checks: "none" },
    ]) {
      expect(successContradiction(raw), JSON.stringify(raw)).toEqual({
        code: "success_report_missing",
        checks: [],
      });
    }
  });

  it("refuses a failed check or result, whatever the other says", () => {
    expect(successContradiction(full({ identity_conflicts: "failed" }))).toEqual({
      code: "success_checks_failed",
      checks: ["identity_conflicts"],
    });
    expect(
      successContradiction({ ...full({ fstab: "failed", crypttab: "failed" }), result: "warning" }),
    ).toEqual({ code: "success_checks_failed", checks: ["fstab", "crypttab"] });
    expect(successContradiction({ ...full(), result: "failed" })).toEqual({
      code: "success_checks_failed",
      checks: [],
    });
    // A check a newer ISO adds counts when it failed.
    const more = full();
    more.checks.push({ id: "future_check" as never, result: "failed", findings: [], evidence: {} });
    expect(successContradiction(more)).toEqual({
      code: "success_checks_failed",
      checks: ["future_check"],
    });
  });

  it("needs every one of the ten checks, and takes warnings and added checks", () => {
    // The contract example holds two checks only.
    expect(successContradiction(example)).toEqual({
      code: "success_checks_missing",
      checks: VERIFICATION_CHECK_IDS.filter((id) => id !== "restic_verify" && id !== "initramfs"),
    });
    const short = full();
    short.checks = short.checks.filter((check) => check.id !== "secure_boot");
    expect(successContradiction(short)).toEqual({
      code: "success_checks_missing",
      checks: ["secure_boot"],
    });
    expect(
      successContradiction({ ...full({ initramfs: "warning" }), result: "warning" }),
    ).toBeNull();
    const more = full();
    more.checks.push({ id: "future_check" as never, result: "ok", findings: [], evidence: {} });
    expect(successContradiction(more)).toBeNull();
  });

  it("keeps the server's own warning codes apart from the ISO's", () => {
    expect([...SERVER_FINISH_WARNING_CODES]).toEqual([...SERVER_FINISH_WARNING_CODES].sort());
    for (const code of SERVER_FINISH_WARNING_CODES) {
      expect(isServerFinishWarningCode(code), code).toBe(true);
      expect(isFinishWarningCode(code), code).toBe(false);
      expect(code).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    }
    for (const code of FINISH_WARNING_CODES) {
      expect(isServerFinishWarningCode(code), code).toBe(false);
    }
  });
});
