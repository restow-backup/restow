import { describe, expect, it } from "vitest";
import {
  checkPublicUrl,
  isValidHost,
  isValidTenantId,
  mailTestSchema,
  updateSettingsSchema,
} from "./schemas.js";

const smtp = {
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  from: "restow@example.com",
};

function issueMessages(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? []);
}

describe("checkPublicUrl", () => {
  it("reduces a valid HTTPS URL to its origin", () => {
    expect(checkPublicUrl("https://restow.example.com")).toEqual({
      ok: true,
      origin: "https://restow.example.com",
    });
    expect(checkPublicUrl("  https://Restow.Example.com:8443/  ")).toEqual({
      ok: true,
      origin: "https://restow.example.com:8443",
    });
  });

  it("allows plain HTTP only for the localhost development exception", () => {
    expect(checkPublicUrl("http://localhost:5173")).toEqual({
      ok: true,
      origin: "http://localhost:5173",
    });
    expect(checkPublicUrl("http://127.0.0.1:3000").ok).toBe(true);
    expect(checkPublicUrl("http://restow.example.com")).toEqual({
      ok: false,
      reason: "httpsRequired",
    });
  });

  it("rejects paths, queries, fragments and credentials", () => {
    for (const value of [
      "https://example.com/restow",
      "https://example.com/?a=1",
      "https://example.com/#top",
      "https://user:secret@example.com",
    ]) {
      expect(checkPublicUrl(value), value).toEqual({ ok: false, reason: "originOnly" });
    }
  });

  it("requires a domain name because passkeys cannot bind to an IP address", () => {
    expect(checkPublicUrl("https://192.168.10.5")).toEqual({ ok: false, reason: "domainRequired" });
    expect(checkPublicUrl("https://[2001:db8::1]")).toEqual({
      ok: false,
      reason: "domainRequired",
    });
  });

  it("rejects what is not a URL or not HTTP(S)", () => {
    expect(checkPublicUrl("restow.example.com")).toEqual({ ok: false, reason: "url" });
    expect(checkPublicUrl("ftp://restow.example.com")).toEqual({ ok: false, reason: "url" });
  });
});

describe("host and tenant helpers", () => {
  it("accepts host names and IP addresses", () => {
    for (const host of ["smtp.example.com", "mail", "10.0.0.25", "2001:db8::25"]) {
      expect(isValidHost(host), host).toBe(true);
    }
    for (const host of ["", "smtp example.com", "-smtp.example.com", "smtp..example.com"]) {
      expect(isValidHost(host), host).toBe(false);
    }
  });

  it("accepts tenant GUIDs and verified domains", () => {
    expect(isValidTenantId("0b3f6b2e-9c2d-4c3a-9e7f-1d2c3b4a5f60")).toBe(true);
    expect(isValidTenantId("contoso.onmicrosoft.com")).toBe(true);
    expect(isValidTenantId("contoso")).toBe(false);
    expect(isValidTenantId("not a tenant")).toBe(false);
  });
});

describe("updateSettingsSchema", () => {
  it("rejects an empty patch and unknown members", () => {
    expect(updateSettingsSchema.safeParse({}).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ passkeyReady: true }).success).toBe(false);
  });

  it("normalizes the public URL and lets null clear it", () => {
    const parsed = updateSettingsSchema.parse({
      operatingMode: "public",
      publicUrl: "https://restow.example.com/",
    });
    expect(parsed.publicUrl).toBe("https://restow.example.com");
    expect(updateSettingsSchema.parse({ publicUrl: null }).publicUrl).toBeNull();
  });

  it("reports public URL problems as short reasons", () => {
    const result = updateSettingsSchema.safeParse({ publicUrl: "http://restow.example.com" });
    expect(issueMessages(result)).toEqual(["httpsRequired"]);
  });

  it("accepts a complete SMTP transport and normalizes empty credentials", () => {
    const parsed = updateSettingsSchema.parse({
      mail: { transport: "smtp", smtp: { ...smtp, username: "", password: "" } },
    });
    expect(parsed.mail).toEqual({
      transport: "smtp",
      smtp: { ...smtp, username: null, password: undefined },
    });
  });

  it("validates SMTP fields with reasons the form can translate", () => {
    const result = updateSettingsSchema.safeParse({
      mail: {
        transport: "smtp",
        smtp: { host: "bad host", port: 70000, security: "starttls", from: "nope" },
      },
    });
    expect(issueMessages(result).sort()).toEqual(["email", "host", "port"]);
  });

  it("accepts Graph with or without a tenant and rejects a malformed one", () => {
    expect(
      updateSettingsSchema.safeParse({
        mail: { transport: "graph", graph: { sender: "restow@contoso.com" } },
      }).success,
    ).toBe(true);
    expect(
      updateSettingsSchema.parse({
        mail: { transport: "graph", graph: { sender: "restow@contoso.com", tenantId: "" } },
      }).mail,
    ).toEqual({
      transport: "graph",
      graph: { sender: "restow@contoso.com", tenantId: null, app: "backup" },
    });
    const result = updateSettingsSchema.safeParse({
      mail: { transport: "graph", graph: { sender: "restow@contoso.com", tenantId: "contoso" } },
    });
    expect(issueMessages(result)).toEqual(["tenantId"]);
  });

  it("does not accept the stored `implicit` spelling or a mixed transport", () => {
    expect(
      updateSettingsSchema.safeParse({
        mail: { transport: "smtp", smtp: { ...smtp, security: "implicit" } },
      }).success,
    ).toBe(false);
    expect(
      updateSettingsSchema.safeParse({
        mail: { transport: "graph", smtp, graph: { sender: "restow@contoso.com" } },
      }).success,
    ).toBe(false);
  });
});

describe("mailTestSchema", () => {
  it("allows testing the stored transport with the default recipient", () => {
    expect(mailTestSchema.parse({})).toEqual({});
  });

  it("validates the recipient and the draft", () => {
    expect(issueMessages(mailTestSchema.safeParse({ to: "not-an-email" }))).toEqual(["email"]);
    expect(
      mailTestSchema.safeParse({
        to: "ops@example.com",
        mail: { transport: "smtp", smtp },
      }).success,
    ).toBe(true);
  });
});
