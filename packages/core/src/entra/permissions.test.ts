import { describe, expect, it } from "vitest";
import {
  GRAPH_APPLICATION_PERMISSIONS,
  OPTIONAL_PERMISSIONS,
  REQUIRED_PERMISSIONS,
  decodeJwtClaims,
  diffPermissions,
  rolesFromAccessToken,
} from "./permissions.js";

function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("permission catalogue", () => {
  it("lists the nine required application permissions plus optional Mail.Send", () => {
    expect(REQUIRED_PERMISSIONS).toEqual([
      "Mail.ReadWrite",
      "MailboxSettings.Read",
      "Calendars.ReadWrite",
      "Contacts.ReadWrite",
      "Files.ReadWrite.All",
      "User.Read.All",
      "Group.Read.All",
      "Directory.Read.All",
      "Organization.Read.All",
    ]);
    expect(OPTIONAL_PERMISSIONS).toEqual(["Mail.Send"]);
    expect(GRAPH_APPLICATION_PERMISSIONS.map((entry) => entry.permission)).not.toContain(
      "Sites.ReadWrite.All",
    );
  });
});

describe("diffPermissions", () => {
  it("is complete when every required permission is granted, optional ones aside", () => {
    const diff = diffPermissions(REQUIRED_PERMISSIONS);
    expect(diff.complete).toBe(true);
    expect(diff.missing).toEqual([]);
    expect(diff.readOnlyInstead).toEqual([]);
    expect(diff.unexpected).toEqual([]);
    const mailSend = diff.checks.find((check) => check.permission === "Mail.Send");
    expect(mailSend).toMatchObject({ required: false, state: "missing" });
  });

  it("names the read-only pitfall: Mail.Read granted instead of Mail.ReadWrite", () => {
    const granted = REQUIRED_PERMISSIONS.filter((p) => p !== "Mail.ReadWrite").concat("Mail.Read");
    const diff = diffPermissions(granted);
    expect(diff.complete).toBe(false);
    expect(diff.missing).toEqual(["Mail.ReadWrite"]);
    expect(diff.readOnlyInstead).toEqual([{ expected: "Mail.ReadWrite", granted: "Mail.Read" }]);
    const mail = diff.checks.find((check) => check.permission === "Mail.ReadWrite");
    expect(mail).toMatchObject({ state: "read_only", grantedInstead: "Mail.Read" });
    // The weaker variant is not reported as "unexpected" — it is explained instead.
    expect(diff.unexpected).toEqual([]);
  });

  it("reports missing permissions and unexpected extra roles", () => {
    const diff = diffPermissions(["Mail.ReadWrite", "Sites.ReadWrite.All", "User.Read.All"]);
    expect(diff.complete).toBe(false);
    expect(diff.missing).toEqual([
      "MailboxSettings.Read",
      "Calendars.ReadWrite",
      "Contacts.ReadWrite",
      "Files.ReadWrite.All",
      "Group.Read.All",
      "Directory.Read.All",
      "Organization.Read.All",
    ]);
    expect(diff.granted).toEqual(["Mail.ReadWrite", "User.Read.All"]);
    expect(diff.unexpected).toEqual(["Sites.ReadWrite.All"]);
  });

  it("compares case-insensitively and ignores blanks", () => {
    const diff = diffPermissions(["mail.readwrite", " ", "USER.READ.ALL"]);
    expect(diff.granted).toEqual(["Mail.ReadWrite", "User.Read.All"]);
  });

  it("keeps the checklist in catalogue order with one entry per permission", () => {
    const diff = diffPermissions([]);
    expect(diff.checks.map((check) => check.permission)).toEqual(
      GRAPH_APPLICATION_PERMISSIONS.map((entry) => entry.permission),
    );
    expect(diff.checks.every((check) => check.state === "missing")).toBe(true);
  });
});

describe("rolesFromAccessToken", () => {
  it("reads the roles claim of a client-credentials token", () => {
    const token = fakeJwt({ aud: "https://graph.microsoft.com", roles: ["Mail.ReadWrite", 42] });
    expect(rolesFromAccessToken(token)).toEqual(["Mail.ReadWrite"]);
  });

  it("returns no roles when the claim is absent", () => {
    expect(rolesFromAccessToken(fakeJwt({ aud: "x" }))).toEqual([]);
  });

  it("rejects things that are not JWTs", () => {
    expect(() => decodeJwtClaims("opaque-token")).toThrow(/not a JWT/);
    expect(() =>
      decodeJwtClaims(
        `${Buffer.from("[]").toString("base64url")}.${Buffer.from("[]").toString("base64url")}.x`,
      ),
    ).toThrow(/not a JWT/);
  });
});
