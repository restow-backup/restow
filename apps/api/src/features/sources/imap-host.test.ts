import { describe, expect, it } from "vitest";
import { ProblemError } from "../../problem.js";
import {
  type ImapHostContext,
  approveImapHost,
  decideImapHost,
  imapHostNotAllowed,
  probeMayReachPrivateNetworks,
  storedHostMayBePrivate,
} from "./imap-host.js";

const NOW = new Date("2026-09-23T08:00:00.000Z");

const tenantAdmin: ImapHostContext = {
  isProviderAdmin: false,
  privateNetworksAllowed: false,
  actorEmail: "admin@contoso.example",
  now: NOW,
};

const providerAdmin: ImapHostContext = {
  ...tenantAdmin,
  isProviderAdmin: true,
  actorEmail: "ops@provider.example",
};

describe("decideImapHost", () => {
  it("allows public and not yet resolvable hosts for everyone, without an approval", () => {
    for (const assessment of ["public", "unresolvable"] as const) {
      expect(decideImapHost(assessment, tenantAdmin)).toEqual({ kind: "allowed", approval: null });
      expect(decideImapHost(assessment, providerAdmin)).toEqual({
        kind: "allowed",
        approval: null,
      });
    }
  });

  it("refuses internal hosts to tenant admins", () => {
    expect(decideImapHost("private", tenantAdmin)).toEqual({
      kind: "refused",
      reason: "private_network",
    });
  });

  it("records a provider admin's approval of an internal host", () => {
    expect(decideImapHost("private", providerAdmin)).toEqual({
      kind: "allowed",
      approval: { by: "ops@provider.example", at: "2026-09-23T08:00:00.000Z" },
    });
  });

  it("lets the installation flag allow internal hosts without a per-source approval", () => {
    expect(decideImapHost("private", { ...tenantAdmin, privateNetworksAllowed: true })).toEqual({
      kind: "allowed",
      approval: null,
    });
  });

  it("refuses link-local and reserved addresses to everyone", () => {
    const everyone = { ...providerAdmin, privateNetworksAllowed: true };
    expect(decideImapHost("forbidden", everyone)).toEqual({
      kind: "refused",
      reason: "forbidden_address",
    });
  });
});

describe("approveImapHost", () => {
  const resolver = async (host: string): Promise<readonly string[]> =>
    host === "imap.example.com" ? ["93.184.216.34"] : ["10.20.30.40"];

  it("resolves the name and applies the decision", async () => {
    expect(await approveImapHost("imap.example.com", tenantAdmin, resolver)).toBeNull();
    await expect(approveImapHost("mail.corp.example", tenantAdmin, resolver)).rejects.toThrow(
      ProblemError,
    );
    expect(await approveImapHost("mail.corp.example", providerAdmin, resolver)).toEqual({
      by: "ops@provider.example",
      at: NOW.toISOString(),
    });
  });

  it("names the field and the reason in the problem", async () => {
    const problem = imapHostNotAllowed("private_network");
    expect(problem.status).toBe(422);
    expect(problem.type).toBe("urn:restow:problem:imap-host-not-allowed");
    expect(problem.extensions).toEqual({ field: "host", reason: "private_network" });
    await expect(approveImapHost("169.254.169.254", providerAdmin, resolver)).rejects.toMatchObject(
      { extensions: { reason: "forbidden_address" } },
    );
  });
});

describe("probeMayReachPrivateNetworks", () => {
  const approved = {
    host: "mail.corp.example",
    port: 993,
    config: { privateNetworkApproval: { by: "ops@provider.example", at: NOW.toISOString() } },
  };

  it("lets provider admins and the installation flag test any server", () => {
    expect(probeMayReachPrivateNetworks(providerAdmin, null, { host: "10.0.0.1", port: 25 })).toBe(
      true,
    );
    expect(
      probeMayReachPrivateNetworks({ ...tenantAdmin, privateNetworksAllowed: true }, null, {
        host: "10.0.0.1",
        port: 25,
      }),
    ).toBe(true);
  });

  it("lets tenant admins test an approved source only at its approved endpoint", () => {
    expect(
      probeMayReachPrivateNetworks(tenantAdmin, approved, { host: "MAIL.corp.example", port: 993 }),
    ).toBe(true);
    expect(
      probeMayReachPrivateNetworks(tenantAdmin, approved, { host: "mail.corp.example", port: 22 }),
    ).toBe(false);
    expect(
      probeMayReachPrivateNetworks(tenantAdmin, approved, { host: "10.0.0.1", port: 993 }),
    ).toBe(false);
    expect(
      probeMayReachPrivateNetworks(
        tenantAdmin,
        { ...approved, config: {} },
        { host: "mail.corp.example", port: 993 },
      ),
    ).toBe(false);
  });
});

describe("storedHostMayBePrivate", () => {
  it("follows the installation flag or the source's approval", () => {
    expect(storedHostMayBePrivate({}, false)).toBe(false);
    expect(storedHostMayBePrivate({ privateNetworkApproval: null }, false)).toBe(false);
    expect(storedHostMayBePrivate({}, true)).toBe(true);
    expect(
      storedHostMayBePrivate(
        { privateNetworkApproval: { by: "ops@provider.example", at: NOW.toISOString() } },
        false,
      ),
    ).toBe(true);
  });
});
