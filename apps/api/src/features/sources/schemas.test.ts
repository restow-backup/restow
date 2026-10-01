import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAP_PORT,
  consentLinkSchema,
  createSourceSchema,
  entraTenantHintSchema,
  hostSchema,
  imapTestSchema,
  updateSourceSchema,
} from "./schemas.js";

const imap = {
  kind: "imap",
  name: "Mailbox Alice",
  host: "imap.example.com",
  port: 993,
  security: "tls",
  username: "alice@example.com",
  password: "correct horse battery staple",
};

describe("createSourceSchema", () => {
  it("accepts a Microsoft 365 source with an optional tenant hint and scope", () => {
    const parsed = createSourceSchema.parse({
      kind: "m365",
      name: "Contoso",
      entraTenantHint: "contoso.onmicrosoft.com",
      scope: { mode: "group", groupId: "g-1" },
    });
    expect(parsed.kind).toBe("m365");
    if (parsed.kind === "m365") {
      expect(parsed.scope).toEqual({ mode: "group", groupId: "g-1", exclude: [] });
    }
  });

  it("requires a group id for the group scope", () => {
    const result = createSourceSchema.safeParse({
      kind: "m365",
      name: "Contoso",
      scope: { mode: "group" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["scope", "groupId"]);
    }
  });

  it("accepts a complete IMAP source", () => {
    expect(createSourceSchema.parse(imap)).toMatchObject({ kind: "imap", port: 993 });
  });

  it("rejects an IMAP source without a password or with a bad port", () => {
    expect(createSourceSchema.safeParse({ ...imap, password: "" }).success).toBe(false);
    expect(createSourceSchema.safeParse({ ...imap, port: 0 }).success).toBe(false);
    expect(createSourceSchema.safeParse({ ...imap, port: 70000 }).success).toBe(false);
    expect(createSourceSchema.safeParse({ ...imap, security: "ssl" }).success).toBe(false);
  });

  it("rejects an IMAP source whose host is a URL", () => {
    expect(
      createSourceSchema.safeParse({ ...imap, host: "https://imap.example.com" }).success,
    ).toBe(false);
  });
});

describe("hostSchema", () => {
  it("accepts hostnames and IP literals", () => {
    for (const host of ["imap.example.com", "localhost", "10.0.0.5", "2001:db8::1", "MAIL"]) {
      expect(hostSchema.safeParse(host).success, host).toBe(true);
    }
  });

  it("rejects paths, spaces and schemes", () => {
    for (const host of [
      "imap.example.com/inbox",
      "imap example",
      "imaps://host",
      "",
      "-bad.example",
    ]) {
      expect(hostSchema.safeParse(host).success, host).toBe(false);
    }
  });
});

describe("entraTenantHintSchema", () => {
  it("accepts a tenant id or a verified domain", () => {
    expect(entraTenantHintSchema.safeParse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").success).toBe(
      true,
    );
    expect(entraTenantHintSchema.safeParse("contoso.onmicrosoft.com").success).toBe(true);
  });

  it("rejects free text", () => {
    expect(entraTenantHintSchema.safeParse("Contoso Ltd").success).toBe(false);
    expect(entraTenantHintSchema.safeParse("contoso").success).toBe(false);
  });
});

describe("updateSourceSchema", () => {
  it("rejects an empty patch", () => {
    expect(updateSourceSchema.safeParse({}).success).toBe(false);
  });

  it("only allows pausing and resuming through status", () => {
    expect(updateSourceSchema.safeParse({ status: "disabled" }).success).toBe(true);
    expect(updateSourceSchema.safeParse({ status: "active" }).success).toBe(true);
    expect(updateSourceSchema.safeParse({ status: "error" }).success).toBe(false);
    expect(updateSourceSchema.safeParse({ status: "pending" }).success).toBe(false);
  });

  it("allows clearing the tenant hint with null", () => {
    expect(updateSourceSchema.parse({ entraTenantHint: null })).toEqual({ entraTenantHint: null });
  });

  it("does not let sources overwrite the directory's protection scope", () => {
    expect(updateSourceSchema.safeParse({ scope: { mode: "all" } }).success).toBe(false);
  });
});

describe("imapTestSchema and defaults", () => {
  const { kind: _kind, name: _name, ...connection } = imap;
  const sourceId = "7d8e9f00-1111-2222-3333-444455556666";

  it("takes a typed password for an inline test", () => {
    expect(imapTestSchema.safeParse(connection).success).toBe(true);
  });

  it("may borrow a stored password by naming the source instead", () => {
    const { password: _password, ...withoutPassword } = connection;
    expect(imapTestSchema.safeParse({ ...withoutPassword, sourceId }).success).toBe(true);
    const missing = imapTestSchema.safeParse(withoutPassword);
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues[0]?.path).toEqual(["password"]);
    }
    expect(imapTestSchema.safeParse({ ...withoutPassword, sourceId: "nope" }).success).toBe(false);
  });

  it("knows the conventional port per security mode", () => {
    expect(DEFAULT_IMAP_PORT).toEqual({ tls: 993, starttls: 143, none: 143 });
  });
});

describe("consentLinkSchema", () => {
  it("accepts no body, a tenant, or null for the admin's own organisation", () => {
    expect(consentLinkSchema.parse(undefined)).toBeUndefined();
    expect(consentLinkSchema.parse({})).toEqual({});
    expect(consentLinkSchema.parse({ tenant: "contoso.onmicrosoft.com" })).toEqual({
      tenant: "contoso.onmicrosoft.com",
    });
    expect(consentLinkSchema.parse({ tenant: null })).toEqual({ tenant: null });
  });

  it("rejects free text and unknown fields", () => {
    expect(consentLinkSchema.safeParse({ tenant: "Contoso Ltd" }).success).toBe(false);
    expect(consentLinkSchema.safeParse({ redirectUri: "https://evil.example" }).success).toBe(
      false,
    );
  });
});
