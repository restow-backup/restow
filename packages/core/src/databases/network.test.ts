import { describe, expect, it } from "vitest";
import {
  dbApprovedAddress,
  dbCanonicalAddress,
  dbHostClass,
  dbMayReachPrivateNetworks,
  dbPlaintextAllowedFor,
  judgeDbHost,
} from "./network.js";

const context = {
  isProviderAdmin: false,
  privateNetworksAllowed: false,
  actorEmail: "admin@tenant.example",
  now: new Date("2026-11-17T10:00:00Z"),
};

const resolver = (map: Record<string, string[]>) => async (host: string) => {
  const found = map[host];
  if (!found) throw new Error("ENOTFOUND");
  return found;
};

describe("network protection of the server executor (docs/DATABASES.md 4.2) [DB-003]", () => {
  it("lets a tenant admin use public addresses only", async () => {
    const resolve = resolver({
      "db.example.com": ["93.184.216.34"],
      "lan.example.com": ["10.1.2.3"],
    });
    expect(await judgeDbHost("db.example.com", context, resolve)).toEqual({
      kind: "allowed",
      approval: null,
    });
    expect(await judgeDbHost("lan.example.com", context, resolve)).toEqual({
      kind: "refused",
      reason: "db_private_network",
    });
    expect(await judgeDbHost("postgres", context, resolve)).toEqual({
      kind: "refused",
      reason: "db_private_network",
    });
    expect(await judgeDbHost("192.168.0.10", context, resolve)).toMatchObject({ kind: "refused" });
  });

  it("records a provider admin's approval, or follows the installation flag", async () => {
    expect(await judgeDbHost("10.0.0.5", { ...context, isProviderAdmin: true })).toEqual({
      kind: "allowed",
      approval: {
        by: "admin@tenant.example",
        at: "2026-11-17T10:00:00.000Z",
        addresses: ["10.0.0.5"],
      },
    });
    expect(await judgeDbHost("10.0.0.5", { ...context, privateNetworksAllowed: true })).toEqual({
      kind: "allowed",
      approval: null,
    });
    expect(dbMayReachPrivateNetworks(null, false)).toBe(false);
    expect(dbMayReachPrivateNetworks({ by: "x", at: "y", addresses: ["10.0.0.5"] }, false)).toBe(
      true,
    );
  });

  it("binds an approval to addresses, never to what a lookup of its own finds", async () => {
    const resolve = resolver({ postgres: ["172.18.0.4"], "lan.example.com": ["10.1.2.3"] });
    const admin = { ...context, isProviderAdmin: true };
    // A name: the server adds the address the approved test connected to.
    expect(await judgeDbHost("postgres", admin, resolve)).toEqual({
      kind: "allowed",
      approval: { by: "admin@tenant.example", at: "2026-11-17T10:00:00.000Z", addresses: [] },
    });
    const approval = { by: "x", at: "y", addresses: ["172.18.0.4"] };
    expect(dbApprovedAddress(approval, "172.18.0.4")).toBe(true);
    expect(dbApprovedAddress(approval, "::ffff:172.18.0.4")).toBe(true);
    // Another private or loopback address under the same name is not approved.
    expect(dbApprovedAddress(approval, "172.18.0.5")).toBe(false);
    expect(dbApprovedAddress(approval, "127.0.0.1")).toBe(false);
    // An approval without addresses (or none) approves nothing.
    expect(dbApprovedAddress({ by: "x", at: "y" }, "172.18.0.4")).toBe(false);
    expect(dbMayReachPrivateNetworks({ by: "x", at: "y" }, false)).toBe(false);
    expect(dbCanonicalAddress("[FD00::1]")).toBe("fd00::1");
  });

  it("refuses link-local, metadata and reserved addresses for everyone", async () => {
    const everyone = { ...context, isProviderAdmin: true, privateNetworksAllowed: true };
    const resolve = resolver({ "metadata.example": ["169.254.169.254"] });
    for (const host of [
      "169.254.169.254",
      "fe80::1",
      "0.0.0.0",
      "198.51.100.7",
      "metadata.example",
    ]) {
      expect(await judgeDbHost(host, everyone, resolve), host).toEqual({
        kind: "refused",
        reason: "db_forbidden_address",
      });
    }
  });

  it("allows plaintext only to private and loopback addresses", async () => {
    expect(dbPlaintextAllowedFor("public")).toBe(false);
    expect(dbPlaintextAllowedFor("private")).toBe(true);
    expect(dbPlaintextAllowedFor("loopback")).toBe(true);
    expect(dbPlaintextAllowedFor("link_local")).toBe(false);
    const resolve = resolver({ "db.example.com": ["93.184.216.34", "10.0.0.1"] });
    expect(await dbHostClass("db.example.com", resolve)).toBe("public");
    expect(await dbHostClass("pg-container", resolve)).toBe("private");
    expect(await dbHostClass("gone.example.com", resolve)).toBe("unresolvable");
  });
});
