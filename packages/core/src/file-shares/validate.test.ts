import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isIpLiteral,
  isValidDomain,
  isValidShareName,
  isValidSharePassword,
  isValidSubfolder,
  isValidUsername,
  normalizeShareExport,
  normalizeShareServer,
  shareSpecProblems,
  splitAccount,
} from "./validate.js";

/** The same vectors the mounter's runner-protocol.test.ts checks (contract). */
const VECTORS = JSON.parse(
  readFileSync(new URL("./testdata/specs.json", import.meta.url), "utf8"),
) as {
  shareNames: { valid: string[]; invalid: string[] };
  subfolders: { valid: string[]; invalid: string[] };
  usernames: { valid: string[]; invalid: string[] };
  domains: { valid: string[]; invalid: string[] };
  passwords: { valid: string[]; invalid: string[] };
  addresses: { valid: string[]; invalid: string[] };
  specs: {
    valid: Record<string, unknown>[];
    invalid: { why: string; spec: Record<string, unknown> }[];
  };
};

describe("file share validation (mirror of the mounter)", () => {
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

  it("agrees with the mounter on whole specs", () => {
    for (const spec of VECTORS.specs.valid) {
      expect(shareSpecProblems(spec), JSON.stringify(spec)).toEqual([]);
    }
    for (const { why, spec } of VECTORS.specs.invalid) {
      expect(shareSpecProblems(spec).length, why).toBeGreaterThan(0);
    }
  });

  it("names the fields that are wrong", () => {
    const base = VECTORS.specs.valid[0] as Record<string, unknown>;
    expect(shareSpecProblems({ ...base, password: "", address: "fs1" }).sort()).toEqual([
      "address",
      "password",
    ]);
    expect(shareSpecProblems({ protocol: "ftp" })).toEqual(["protocol"]);
  });

  it("normalises servers and exports like the mounter", () => {
    expect(normalizeShareServer("[2001:DB8::1]")).toBe("2001:db8::1");
    expect(normalizeShareServer("FS1.Corp.Example.")).toBe("fs1.corp.example");
    expect(normalizeShareServer("1.2.3")).toBeNull();
    expect(normalizeShareServer("a,b")).toBeNull();
    expect(normalizeShareExport("//volume1//data/")).toBe("/volume1/data");
    expect(normalizeShareExport("/a/../b")).toBeNull();
  });

  it("splits DOMAIN\\user", () => {
    expect(splitAccount("CORP\\backup")).toEqual({ domain: "CORP", username: "backup" });
    expect(splitAccount("backup@corp.example")).toEqual({
      domain: null,
      username: "backup@corp.example",
    });
    expect(splitAccount("a\\b\\c")).toEqual({ domain: null, username: "a\\b\\c" });
  });
});
