import { describe, expect, it } from "vitest";

import {
  type ImapFormValues,
  type StoredImapConnection,
  emptyImapForm,
  fieldMessageKey,
  imapFormFromStored,
  imapFormSchema,
  isMicrosoftImapHost,
  isValidHost,
  isValidPort,
  isValidTenantHint,
  m365FormSchema,
  needsPasswordAgain,
  portForSecurity,
  toCreateImapInput,
  toCreateM365Input,
  toImapTestInput,
  toUpdateImapInput,
  toUpdateM365Input,
} from "./forms";

const stored: StoredImapConnection = {
  name: "Mailbox Alice",
  host: "imap.example.com",
  port: 993,
  security: "tls",
  username: "alice@example.com",
  imapAuthMode: "shared",
  masterUser: null,
};
const sourceId = "7d8e9f00-1111-2222-3333-444455556666";

function values(patch: Partial<ImapFormValues> = {}): ImapFormValues {
  return { ...imapFormFromStored(stored), ...patch };
}

function issuePaths(result: ReturnType<ReturnType<typeof imapFormSchema>["safeParse"]>) {
  return result.success
    ? []
    : result.error.issues.map((issue) => [issue.path.join("."), issue.message]);
}

describe("host and port", () => {
  it("accepts hostnames and IP literals, never URLs", () => {
    expect(isValidHost("imap.example.com")).toBe(true);
    expect(isValidHost("10.0.0.5")).toBe(true);
    expect(isValidHost("2001:db8::1")).toBe(true);
    expect(isValidHost("imaps://imap.example.com")).toBe(false);
    expect(isValidHost("imap.example.com/inbox")).toBe(false);
    expect(isValidHost(" ")).toBe(false);
  });

  it("accepts ports 1..65535 only", () => {
    expect(isValidPort("993")).toBe(true);
    expect(isValidPort("0")).toBe(false);
    expect(isValidPort("65536")).toBe(false);
    expect(isValidPort("99a")).toBe(false);
  });

  it("follows the conventional port unless the user typed their own", () => {
    expect(portForSecurity("993", "starttls")).toBe("143");
    expect(portForSecurity("", "tls")).toBe("993");
    expect(portForSecurity("1993", "starttls")).toBe("1993");
  });
});

describe("isMicrosoftImapHost", () => {
  it("recognises Microsoft's IMAP servers, whatever the case or a trailing dot", () => {
    expect(isMicrosoftImapHost("outlook.office365.com")).toBe(true);
    expect(isMicrosoftImapHost(" Outlook.Office.com ")).toBe(true);
    expect(isMicrosoftImapHost("imap-mail.outlook.com.")).toBe(true);
  });

  it("leaves every other server alone", () => {
    expect(isMicrosoftImapHost("imap.gmail.com")).toBe(false);
    expect(isMicrosoftImapHost("mail.example.com")).toBe(false);
    expect(isMicrosoftImapHost("outlook.office365.com.example.com")).toBe(false);
    expect(isMicrosoftImapHost("")).toBe(false);
  });
});

describe("imapFormSchema", () => {
  it("requires a password when creating", () => {
    const create = imapFormSchema(null);
    const filled = { ...emptyImapForm, name: "A", host: "imap.example.com", username: "a" };
    expect(issuePaths(create.safeParse(filled))).toEqual([["password", "required"]]);
    expect(create.safeParse({ ...filled, password: "secret" }).success).toBe(true);
  });

  it("keeps the stored password while host and username stay the same", () => {
    const edit = imapFormSchema(stored);
    expect(edit.safeParse(values()).success).toBe(true);
    expect(edit.safeParse(values({ port: "143", security: "starttls" })).success).toBe(true);
    expect(edit.safeParse(values({ host: "IMAP.example.com" })).success).toBe(true);
  });

  it("asks for the password again when host or username change", () => {
    const edit = imapFormSchema(stored);
    expect(issuePaths(edit.safeParse(values({ host: "mail.example.net" })))).toEqual([
      ["password", "passwordAgain"],
    ]);
    expect(issuePaths(edit.safeParse(values({ username: "bob@example.com" })))).toEqual([
      ["password", "passwordAgain"],
    ]);
    expect(edit.safeParse(values({ host: "mail.example.net", password: "new" })).success).toBe(
      true,
    );
  });

  it("reports feature reasons for bad hosts and ports", () => {
    const input = values({ host: "https://x", port: "0", password: "p" });
    expect(issuePaths(imapFormSchema(stored).safeParse(input))).toEqual([
      ["host", "host"],
      ["port", "port"],
    ]);
  });
});

describe("needsPasswordAgain", () => {
  it("compares hosts case-insensitively and usernames exactly", () => {
    expect(
      needsPasswordAgain({ host: " IMAP.Example.com ", username: "alice@example.com" }, stored),
    ).toBe(false);
    expect(
      needsPasswordAgain({ host: "imap.example.com", username: "Alice@example.com" }, stored),
    ).toBe(true);
    expect(
      needsPasswordAgain({ host: "imap.example.com", username: "alice@example.com" }, null),
    ).toBe(true);
  });
});

describe("toImapTestInput", () => {
  const withStored = { sourceId, connection: stored };

  it("sends a typed password", () => {
    expect(toImapTestInput(values({ password: "typed" }), withStored)).toEqual({
      host: "imap.example.com",
      port: 993,
      security: "tls",
      username: "alice@example.com",
      password: "typed",
    });
  });

  it("borrows the stored password by source id for the same host and username", () => {
    expect(toImapTestInput(values({ port: "143" }), withStored)).toEqual({
      host: "imap.example.com",
      port: 143,
      security: "tls",
      username: "alice@example.com",
      sourceId,
    });
  });

  it("needs a password for a changed server, or when nothing is stored", () => {
    expect(toImapTestInput(values({ host: "mail.example.net" }), withStored)).toBeNull();
    expect(toImapTestInput(values(), null)).toBeNull();
  });

  it("master_user logs in as the master account, not the label username", () => {
    // Regression: this used to send `values.username` (a label only, see
    // `usernameHintMasterUser`) together with the master password, testing
    // the wrong login and never proving anything about the shape the worker
    // actually uses.
    expect(
      toImapTestInput(
        values({
          imapAuthMode: "master_user",
          masterUsername: " master ",
          password: "typed",
        }),
        withStored,
      ),
    ).toEqual({
      host: "imap.example.com",
      port: 993,
      security: "tls",
      username: "master",
      password: "typed",
    });
  });

  it("master_user needs a master username, and never reuses a stored password by label username", () => {
    expect(
      toImapTestInput(
        values({ imapAuthMode: "master_user", masterUsername: "", password: "typed" }),
        withStored,
      ),
    ).toBeNull();
    expect(
      toImapTestInput(
        values({ imapAuthMode: "master_user", masterUsername: "master" }),
        withStored,
      ),
    ).toBeNull();
  });
});

describe("IMAP payloads", () => {
  it("trims the create payload and converts the port", () => {
    expect(
      toCreateImapInput({
        name: " Alice ",
        host: " imap.example.com ",
        port: "993",
        security: "tls",
        username: " alice ",
        password: " keep spaces ",
        imapAuthMode: "shared",
        masterUsername: "",
        masterUserStyle: "dovecot_separator",
        masterUserSeparator: "",
      }),
    ).toEqual({
      kind: "imap",
      name: "Alice",
      host: "imap.example.com",
      port: 993,
      security: "tls",
      username: "alice",
      password: " keep spaces ",
      imapAuthMode: "shared",
    });
  });

  it("per_mailbox omits the source-level password; master_user includes the master login", () => {
    const base = {
      name: "Hoster",
      host: "imap.hoster.example",
      port: "993",
      security: "tls" as const,
      username: "ignored",
      password: "typed",
      masterUsername: "",
      masterUserStyle: "dovecot_separator" as const,
      masterUserSeparator: "",
    };
    expect(toCreateImapInput({ ...base, imapAuthMode: "per_mailbox" })).toEqual({
      kind: "imap",
      name: "Hoster",
      host: "imap.hoster.example",
      port: 993,
      security: "tls",
      username: "ignored",
      imapAuthMode: "per_mailbox",
    });
    expect(
      toCreateImapInput({
        ...base,
        imapAuthMode: "master_user",
        masterUsername: " master ",
        masterUserStyle: "sasl_authzid",
      }),
    ).toEqual({
      kind: "imap",
      name: "Hoster",
      host: "imap.hoster.example",
      port: 993,
      security: "tls",
      username: "ignored",
      password: "typed",
      imapAuthMode: "master_user",
      masterUser: { username: "master", style: "sasl_authzid" },
    });
  });

  it("patches only what changed; an empty password keeps the stored one", () => {
    expect(toUpdateImapInput(values(), stored)).toEqual({});
    expect(toUpdateImapInput(values({ host: "IMAP.EXAMPLE.COM" }), stored)).toEqual({});
    expect(
      toUpdateImapInput(values({ name: "Alice", port: "143", password: "new" }), stored),
    ).toEqual({
      name: "Alice",
      port: 143,
      password: "new",
    });
  });

  it("drops a stale typed password when switching an existing source to per_mailbox", () => {
    // The password field is unmounted (not cleared) once per_mailbox is
    // selected, so a value typed while shared/master_user was still active
    // can still be sitting in form state; the patch must not forward it.
    expect(
      toUpdateImapInput(values({ password: "stale", imapAuthMode: "per_mailbox" }), stored),
    ).toEqual({
      imapAuthMode: "per_mailbox",
    });
  });
});

describe("Microsoft 365 forms", () => {
  it("accepts an empty tenant hint, a GUID or a domain", () => {
    expect(isValidTenantHint("")).toBe(true);
    expect(isValidTenantHint("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBe(true);
    expect(isValidTenantHint("contoso.onmicrosoft.com")).toBe(true);
    expect(isValidTenantHint("Contoso Ltd")).toBe(false);
  });

  it("requires a group id for the group scope", () => {
    const result = m365FormSchema.safeParse({
      name: "Contoso",
      entraTenantHint: "",
      scopeMode: "group",
      groupId: " ",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["groupId"]);
      expect(result.error.issues[0]?.message).toBe("groupId");
    }
  });

  it("builds the create payload with the initial scope", () => {
    expect(
      toCreateM365Input({ name: "Contoso", entraTenantHint: "", scopeMode: "all", groupId: "x" }),
    ).toEqual({ kind: "m365", name: "Contoso", scope: { mode: "all", exclude: [] } });
    expect(
      toCreateM365Input({
        name: "Contoso",
        entraTenantHint: " contoso.com ",
        scopeMode: "group",
        groupId: " g-1 ",
      }),
    ).toEqual({
      kind: "m365",
      name: "Contoso",
      entraTenantHint: "contoso.com",
      scope: { mode: "group", groupId: "g-1", exclude: [] },
    });
  });

  it("edits the tenant hint only before the source is connected", () => {
    const current = { name: "Contoso", entraTenantHint: "contoso.com", connected: false };
    expect(toUpdateM365Input({ name: "Contoso", entraTenantHint: "contoso.com" }, current)).toEqual(
      {},
    );
    expect(toUpdateM365Input({ name: "Contoso", entraTenantHint: "" }, current)).toEqual({
      entraTenantHint: null,
    });
    expect(
      toUpdateM365Input(
        { name: "Contoso AG", entraTenantHint: "other.com" },
        { ...current, connected: true },
      ),
    ).toEqual({ name: "Contoso AG" });
  });
});

describe("fieldMessageKey", () => {
  it("maps feature reasons, common reasons and API problem keys", () => {
    expect(fieldMessageKey({ type: "custom", message: "host" })).toBe("sources:validation.host");
    expect(fieldMessageKey({ type: "custom", message: "passwordAgain" })).toBe(
      "sources:validation.passwordAgain",
    );
    expect(fieldMessageKey({ type: "custom", message: "port" })).toBe("common:validation.port");
    expect(fieldMessageKey({ type: "server", message: "sources:errors.nameTaken" })).toBe(
      "sources:errors.nameTaken",
    );
    expect(fieldMessageKey({ type: "too_small", message: "String must contain" })).toBe(
      "common:validation.required",
    );
    expect(fieldMessageKey(undefined)).toBeUndefined();
  });
});
