import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  RunnerCapabilities as CoreCapabilities,
  RunnerExecRequest as CoreExecRequest,
  RunnerExecResult as CoreExecResult,
  RunnerRunDetail as CoreRunDetail,
  RunnerRunRequest as CoreRunRequest,
  ShareSpec as CoreShareSpec,
} from "@restow/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type RunnerCapabilities,
  type RunnerExecRequest,
  type RunnerExecResult,
  type RunnerRunDetail,
  type RunnerRunRequest,
  type ShareSpec,
  isIpLiteral,
  isValidDomain,
  isValidShareName,
  isValidSharePassword,
  isValidSubfolder,
  isValidUsername,
  runnerExecRequestSchema,
  runnerRunRequestSchema,
  shareSpecSchema,
} from "./runner-protocol.js";

/** The vectors packages/core/src/file-shares/validate.ts is checked against as well. */
const VECTORS = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../../../packages/core/src/file-shares/testdata/specs.json", import.meta.url),
    ),
    "utf8",
  ),
) as {
  shareNames: { valid: string[]; invalid: string[] };
  subfolders: { valid: string[]; invalid: string[] };
  usernames: { valid: string[]; invalid: string[] };
  domains: { valid: string[]; invalid: string[] };
  passwords: { valid: string[]; invalid: string[] };
  addresses: { valid: string[]; invalid: string[] };
  specs: { valid: Record<string, unknown>[]; invalid: { why: string; spec: unknown }[] };
  options: { spec: number; access: "ro" | "rw"; type: string; device: string; o: string }[];
};

const RUN_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const SHARE_ID = "5b0c6f0e-9f5c-4c8a-9d55-1a2b3c4d5e6f";
const TOKEN = "A".repeat(43);

describe("runner protocol: field vectors", () => {
  const table = [
    ["share names", VECTORS.shareNames, isValidShareName],
    ["subfolders", VECTORS.subfolders, isValidSubfolder],
    ["user names", VECTORS.usernames, isValidUsername],
    ["domains", VECTORS.domains, isValidDomain],
    ["passwords", VECTORS.passwords, isValidSharePassword],
    ["addresses", VECTORS.addresses, isIpLiteral],
  ] as const;
  for (const [name, vectors, check] of table) {
    it(`accepts and refuses ${name}`, () => {
      for (const value of vectors.valid) {
        expect(check(value), JSON.stringify(value)).toBe(true);
      }
      for (const value of vectors.invalid) {
        expect(check(value), JSON.stringify(value)).toBe(false);
      }
    });
  }

  it("accepts the valid specs and refuses the invalid ones", () => {
    for (const spec of VECTORS.specs.valid) {
      expect(shareSpecSchema.safeParse(spec).success, JSON.stringify(spec)).toBe(true);
    }
    for (const { why, spec } of VECTORS.specs.invalid) {
      expect(shareSpecSchema.safeParse(spec).success, why).toBe(false);
    }
  });

  it("refuses a password longer than 256 bytes of UTF-8", () => {
    expect(isValidSharePassword("ä".repeat(128))).toBe(true);
    expect(isValidSharePassword("ä".repeat(129))).toBe(false);
  });
});

describe("runner protocol: requests", () => {
  const smb = VECTORS.specs.valid[0];
  const limits = {
    memoryMiB: 2048,
    goMemLimitMiB: 1638,
    deadline: "2026-10-12T22:00:00Z",
    cacheKey: SHARE_ID,
  };

  it("accepts a backup with one read-only source and a restore with one writable target", () => {
    expect(
      runnerRunRequestSchema.safeParse({
        runId: RUN_ID,
        kind: "backup",
        mounts: [{ role: "source", share: smb, readOnly: true }],
        token: TOKEN,
        limits,
      }).success,
    ).toBe(true);
    expect(
      runnerRunRequestSchema.safeParse({
        runId: RUN_ID,
        kind: "restore",
        mounts: [{ role: "target", share: smb, readOnly: false }],
        token: TOKEN,
        limits,
      }).success,
    ).toBe(true);
  });

  it("refuses a writable backup source, a read-only restore target and two mounts", () => {
    const bad = [
      { kind: "backup", mounts: [{ role: "source", share: smb, readOnly: false }] },
      { kind: "backup", mounts: [{ role: "target", share: smb, readOnly: true }] },
      { kind: "restore", mounts: [{ role: "target", share: smb, readOnly: true }] },
      {
        kind: "restore",
        mounts: [
          { role: "target", share: smb, readOnly: false },
          { role: "source", share: smb, readOnly: true },
        ],
      },
    ];
    for (const entry of bad) {
      expect(
        runnerRunRequestSchema.safeParse({ runId: RUN_ID, token: TOKEN, limits, ...entry }).success,
      ).toBe(false);
    }
  });

  it("refuses malformed ids, tokens and limits", () => {
    const base = {
      runId: RUN_ID,
      kind: "backup",
      mounts: [{ role: "source", share: smb, readOnly: true }],
      token: TOKEN,
      limits,
    };
    for (const change of [
      { runId: "not-a-uuid" },
      { token: "short" },
      { token: `${"A".repeat(42)}=` },
      { limits: { ...limits, cacheKey: "../x" } },
      { limits: { ...limits, memoryMiB: 10 } },
      { limits: { ...limits, deadline: "tomorrow" } },
      { extra: true },
    ]) {
      expect(
        runnerRunRequestSchema.safeParse({ ...base, ...change }).success,
        JSON.stringify(change),
      ).toBe(false);
    }
  });

  it("validates exec requests", () => {
    expect(runnerExecRequestSchema.safeParse({ op: "probe", share: smb }).success).toBe(true);
    expect(
      runnerExecRequestSchema.safeParse({ op: "list", share: smb, path: "A/B", limit: 500 })
        .success,
    ).toBe(true);
    expect(
      runnerExecRequestSchema.safeParse({ op: "list", share: smb, path: "../x" }).success,
    ).toBe(false);
    expect(runnerExecRequestSchema.safeParse({ op: "list", share: smb, limit: 5000 }).success).toBe(
      false,
    );
    expect(runnerExecRequestSchema.safeParse({ op: "backup", share: smb }).success).toBe(false);
  });

  it("names no value of a refused password in its error", () => {
    const secret = "secret-value,ro";
    const result = shareSpecSchema.safeParse({ ...smb, password: secret });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain("secret-value");
  });
});

describe("runner protocol: the types packages/core gives the worker", () => {
  it("are the mounter's types", () => {
    expectTypeOf<CoreShareSpec>().toMatchTypeOf<ShareSpec>();
    expectTypeOf<ShareSpec>().toMatchTypeOf<CoreShareSpec>();
    expectTypeOf<CoreRunRequest>().toMatchTypeOf<RunnerRunRequest>();
    expectTypeOf<RunnerRunRequest>().toMatchTypeOf<CoreRunRequest>();
    expectTypeOf<CoreExecRequest>().toMatchTypeOf<RunnerExecRequest>();
    expectTypeOf<RunnerExecResult>().toMatchTypeOf<CoreExecResult>();
    expectTypeOf<RunnerRunDetail>().toMatchTypeOf<CoreRunDetail>();
    expectTypeOf<RunnerCapabilities>().toMatchTypeOf<CoreCapabilities>();
  });
});
