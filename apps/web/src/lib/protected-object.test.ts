import { describe, expect, it } from "vitest";
import {
  hasOnlyTechnicalId,
  protectedObjectAddress,
  protectedObjectName,
} from "@/lib/protected-object";

const DRIVE_ID = "b!f1lGwdLjf06QXdLirTM3UGc1qQJ";
const ENTRA_ID = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";

describe("protected object names (#55)", () => {
  it("names a OneDrive by its owner, never by the drive id", () => {
    const drive = { kind: "onedrive" as const, displayName: null, externalId: DRIVE_ID };
    expect(protectedObjectName({ ...drive, email: "anna@contoso.example" })).toBe(
      "anna@contoso.example",
    );
    expect(protectedObjectName({ ...drive, ownerEmail: "anna@contoso.example" })).toBe(
      "anna@contoso.example",
    );
    expect(protectedObjectName({ ...drive, upn: "anna@contoso.onmicrosoft.com" })).toBe(
      "anna@contoso.onmicrosoft.com",
    );
    expect(hasOnlyTechnicalId({ ...drive, email: "anna@contoso.example" })).toBe(false);
  });

  it("shows the address next to a display name, never the Entra id", () => {
    const mailbox = {
      kind: "mailbox" as const,
      displayName: "Anna Berger",
      externalId: ENTRA_ID,
      ownerEmail: "anna@contoso.example",
    };
    expect(protectedObjectName(mailbox)).toBe("Anna Berger");
    expect(protectedObjectAddress(mailbox)).toBe("anna@contoso.example");
    expect(protectedObjectAddress({ ...mailbox, ownerEmail: null })).toBeNull();
  });

  it("leaves out an address that only repeats the name", () => {
    expect(
      protectedObjectAddress({
        kind: "mailbox",
        displayName: "Anna@Contoso.example",
        externalId: ENTRA_ID,
        email: "anna@contoso.example",
      }),
    ).toBeNull();
  });

  it("uses an IMAP account's login, which is an address", () => {
    const imap = { kind: "imap" as const, displayName: "Info", externalId: "info@example.org" };
    expect(protectedObjectAddress(imap)).toBe("info@example.org");
    expect(protectedObjectName({ ...imap, displayName: null })).toBe("info@example.org");
    expect(hasOnlyTechnicalId({ ...imap, displayName: null })).toBe(false);
  });

  it("falls back to the technical id only when nothing else is known", () => {
    const bare = { kind: "mailbox" as const, displayName: "  ", externalId: ENTRA_ID };
    expect(protectedObjectName(bare)).toBe(ENTRA_ID);
    expect(hasOnlyTechnicalId(bare)).toBe(true);
  });
});
