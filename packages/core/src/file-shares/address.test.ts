import { describe, expect, it } from "vitest";
import { approvalCovers, approvalRange, judgeShareAddresses } from "./address.js";

describe("share addresses (10.1)", () => {
  const closed = { privateNetworksAllowed: false, approval: null };

  it("allows public addresses and pins IPv4 first", () => {
    expect(judgeShareAddresses(["2001:db8::1", "203.0.113.7"], closed)).toEqual({
      ok: false,
      reason: "forbidden_address",
    });
    expect(judgeShareAddresses(["2a00:1450:4001::1", "93.184.216.34"], closed)).toEqual({
      ok: true,
      address: "93.184.216.34",
    });
    expect(judgeShareAddresses([], closed)).toEqual({ ok: false, reason: "unresolvable" });
  });

  it("never allows link-local, multicast or reserved", () => {
    for (const address of ["169.254.169.254", "224.0.0.1", "0.0.0.0", "fe80::1"]) {
      expect(
        judgeShareAddresses([address], { privateNetworksAllowed: true, approval: null }),
      ).toMatchObject({ ok: false, reason: "forbidden_address" });
    }
  });

  it("allows private addresses with the installation switch or an approval of its range", () => {
    expect(judgeShareAddresses(["10.0.0.5"], closed)).toEqual({
      ok: false,
      reason: "private_network",
    });
    expect(
      judgeShareAddresses(["10.0.0.5"], { privateNetworksAllowed: true, approval: null }),
    ).toEqual({
      ok: true,
      address: "10.0.0.5",
    });
    const approval = { address: "10.0.0.9" };
    expect(judgeShareAddresses(["10.0.0.5"], { privateNetworksAllowed: false, approval })).toEqual({
      ok: true,
      address: "10.0.0.5",
    });
    expect(judgeShareAddresses(["10.0.1.5"], { privateNetworksAllowed: false, approval })).toEqual({
      ok: false,
      reason: "private_network",
    });
  });

  it("compares /24 and /64 ranges", () => {
    expect(approvalCovers("192.168.1.10", "192.168.1.200")).toBe(true);
    expect(approvalCovers("192.168.1.10", "192.168.2.10")).toBe(false);
    expect(approvalCovers("fd00:1:2:3::10", "fd00:1:2:3:aaaa::1")).toBe(true);
    expect(approvalCovers("fd00:1:2:3::10", "fd00:1:2:4::10")).toBe(false);
    expect(approvalCovers("::ffff:10.0.0.1", "::ffff:10.0.0.2")).toBe(true);
    expect(approvalCovers("10.0.0.1", "fd00::1")).toBe(false);
    expect(approvalRange("10.1.2.3")).toBe("10.1.2.0/24");
    expect(approvalRange("fd00:1:2:3::10")).toBe("fd00:1:2:3::/64");
  });
});
