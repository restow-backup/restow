import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PLAN_PROBLEM_CODES,
  PLAN_WARNING_CODES,
  parsePlanOutput,
  planChoicesSchema,
  planFactsSchema,
  planTargetSchema,
} from "./plan.js";

/**
 * The planner's test data, written and owned by the Go agent (agent/internal/baremetal/testdata):
 * the facts the worker hands it, the targets `recover` will hand it, the golden plans it printed,
 * and the list of its codes. Every one of them must parse here, so the worker and the page read
 * what the planner writes.
 */
const TESTDATA = fileURLToPath(
  new URL("../../../../../agent/internal/baremetal/testdata/", import.meta.url),
);

const jsonFiles = (dir: string) =>
  existsSync(join(TESTDATA, dir))
    ? readdirSync(join(TESTDATA, dir)).filter((name) => name.endsWith(".json"))
    : [];
const read = (dir: string, name: string) => readFileSync(join(TESTDATA, dir, name), "utf8");

const plans = jsonFiles("plans");
const facts = jsonFiles("facts");
const targets = jsonFiles("targets");

describe("the planner's shared test data", () => {
  it("has golden plans, facts and targets", () => {
    expect(plans.length).toBeGreaterThan(0);
    expect(facts.length).toBeGreaterThan(0);
    expect(targets.length).toBeGreaterThan(0);
  });

  it("names the same codes as plan-codes.json", () => {
    const codes = JSON.parse(readFileSync(join(TESTDATA, "plan-codes.json"), "utf8")) as {
      problems: string[];
      warnings: string[];
    };
    expect([...PLAN_PROBLEM_CODES]).toEqual(codes.problems);
    expect([...PLAN_WARNING_CODES]).toEqual(codes.warnings);
    expect([...PLAN_PROBLEM_CODES]).toEqual([...PLAN_PROBLEM_CODES].sort());
    expect([...PLAN_WARNING_CODES]).toEqual([...PLAN_WARNING_CODES].sort());
  });

  it.each(plans)("plans/%s parses as restow-plan-v1 with known codes", (name) => {
    const parsed = parsePlanOutput(read("plans", name));
    expect(parsed.kind === "invalid" ? parsed.reason : parsed.kind).not.toBe("invalid");
    if (parsed.kind !== "plan") return;
    const known = new Set<string>([...PLAN_PROBLEM_CODES, ...PLAN_WARNING_CODES]);
    for (const finding of [...parsed.plan.problems, ...parsed.plan.warnings]) {
      expect(known.has(finding.code), finding.code).toBe(true);
    }
    expect(parsed.plan.ok).toBe(parsed.plan.problems.length === 0);
  });

  it.each(facts)("facts/%s parses as restow-plan-facts-v1", (name) => {
    const parsed = planFactsSchema.safeParse(JSON.parse(read("facts", name)));
    expect(parsed.success ? true : parsed.error.issues).toBe(true);
  });

  it.each(targets)("targets/%s parses as restow-plan-target-v1", (name) => {
    const parsed = planTargetSchema.safeParse(JSON.parse(read("targets", name)));
    expect(parsed.success ? true : parsed.error.issues).toBe(true);
  });
});

describe("parsePlanOutput", () => {
  const plan = {
    format: "restow-plan-v1",
    target: "same",
    ok: true,
    problems: [],
    warnings: [
      {
        code: "secure_boot_dbx_unknown",
        severity: "warning",
        ref: null,
        message: "the target's revocation list is unknown",
        params: {},
      },
    ],
    mapping: [{ source: "d0", target: "t0", action: "erase", reason: "identity" }],
    adopted: [],
    minimumSizes: {
      disks: [{ disk: "d0", kname: "nvme0n1", sizeBytes: 512110190592, minBytes: 115964116992 }],
      filesystems: [
        { fs: "f2", mount: "/", type: "ext4", restoreBytes: 9123456789, minBytes: 10871128064 },
      ],
      lvs: [{ vg: "srv01-vg", lv: "root", minBytes: 10871128064 }],
      thinPools: [],
    },
    disks: [],
    steps: [
      {
        n: 1,
        phase: "partition",
        kind: "partition",
        target: "/dev/nvme0n1",
        args: ["sfdisk", "--no-reread", "--wipe", "always", "/dev/nvme0n1"],
        stdin: "label: gpt\nunit: sectors\n",
        stdinSecret: null,
        reason: "recreate the GPT of d0",
      },
    ],
    secureBoot: { checked: true, targetSecureBoot: true, loaders: [] },
    drivers: { kernel: "6.1.0-27-amd64", fallback: null, storage: [], nics: [] },
  };

  it("reads a plan, also with fields a newer planner adds", () => {
    const parsed = parsePlanOutput(JSON.stringify({ ...plan, future: { x: 1 } }));
    expect(parsed.kind).toBe("plan");
  });

  it("reads a refusal", () => {
    expect(
      parsePlanOutput(
        JSON.stringify({
          format: "restow-plan-v1",
          ok: false,
          error: { code: "manifest_invalid", message: "disks[0].id: bad" },
        }),
      ),
    ).toEqual({
      kind: "refused",
      error: { code: "manifest_invalid", message: "disks[0].id: bad" },
    });
  });

  it("refuses ok that disagrees with the problems, a problem filed as a warning, and garbage", () => {
    expect(parsePlanOutput(JSON.stringify({ ...plan, ok: false })).kind).toBe("invalid");
    expect(
      parsePlanOutput(
        JSON.stringify({
          ...plan,
          warnings: [{ ...plan.warnings[0], severity: "problem" }],
        }),
      ).kind,
    ).toBe("invalid");
    expect(parsePlanOutput("not json").kind).toBe("invalid");
    expect(parsePlanOutput(JSON.stringify({ ...plan, format: "other" })).kind).toBe("invalid");
  });

  it("refuses a secret on stdin of a step and a control character", () => {
    const secret = {
      ...plan,
      steps: [{ ...plan.steps[0], stdinSecret: "the passphrase itself" }],
    };
    expect(parsePlanOutput(JSON.stringify(secret)).kind).toBe("invalid");
    const control = { ...plan, target: "same\u0007" };
    expect(parsePlanOutput(JSON.stringify(control)).kind).toBe("invalid");
  });
});

describe("planChoicesSchema", () => {
  it("accepts the empty default and the documented keys", () => {
    expect(planChoicesSchema.safeParse({}).success).toBe(true);
    expect(
      planChoicesSchema.safeParse({
        diskMapping: { d0: "t0", d1: "missing" },
        adopt: ["md:md1"],
        shrink: "auto",
        rawLvs: "skip",
        secureBootOff: false,
        allowDevices: ["t3"],
      }).success,
    ).toBe(true);
    expect(planChoicesSchema.safeParse({ shrink: "maybe" }).success).toBe(false);
  });
});
