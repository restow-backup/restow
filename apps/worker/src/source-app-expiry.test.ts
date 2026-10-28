import { describe, expect, it } from "vitest";
import { ownAppExpiresAt, sourceAppAlertDue, sourceAppNotification } from "./source-app-expiry.js";

const NOW = new Date("2026-11-01T00:00:00.000Z");
const SOURCE = { id: "s-1", tenantId: "t-1", name: "Contoso 365" };

describe("ownAppExpiresAt", () => {
  it("takes the date of the credential kind, the other one as a fallback", () => {
    expect(ownAppExpiresAt({ credentialKind: "secret", secretExpiresAt: "2026-12-01" })).toBe(
      "2026-12-01",
    );
    expect(
      ownAppExpiresAt({
        credentialKind: "certificate",
        secretExpiresAt: "2026-12-01",
        certificateNotAfter: "2027-01-01T00:00:00.000Z",
      }),
    ).toBe("2027-01-01T00:00:00.000Z");
    expect(ownAppExpiresAt({ credentialKind: "certificate", secretExpiresAt: "2026-12-01" })).toBe(
      "2026-12-01",
    );
    expect(ownAppExpiresAt({ credentialKind: "secret", secretExpiresAt: null })).toBeNull();
    expect(ownAppExpiresAt({ credentialKind: "secret", secretExpiresAt: "" })).toBeNull();
    expect(ownAppExpiresAt(null)).toBeNull();
  });
});

describe("sourceAppAlertDue", () => {
  const expiresAt = "2026-11-20T00:00:00.000Z";
  it("names the stage it is in, once per date", () => {
    expect(sourceAppAlertDue({ secretExpiresAt: expiresAt }, NOW)).toEqual({
      expiresAt,
      stage: "soon30",
    });
    expect(
      sourceAppAlertDue(
        { secretExpiresAt: expiresAt, expiryAlert: { expiresAt, stage: "soon30", at: "x" } },
        NOW,
      ),
    ).toBeNull();
    // A mark for another date, or an unreadable one, counts as none.
    expect(
      sourceAppAlertDue(
        {
          secretExpiresAt: expiresAt,
          expiryAlert: { expiresAt: "2026-06-01T00:00:00.000Z", stage: "expired" },
        },
        NOW,
      ),
    ).toEqual({ expiresAt, stage: "soon30" });
    expect(
      sourceAppAlertDue({ secretExpiresAt: expiresAt, expiryAlert: { stage: "later" } }, NOW),
    ).toEqual({ expiresAt, stage: "soon30" });
    expect(sourceAppAlertDue({ secretExpiresAt: "2027-06-01" }, NOW)).toBeNull();
    expect(sourceAppAlertDue({ secretExpiresAt: "not a date" }, NOW)).toBeNull();
  });
});

describe("sourceAppNotification", () => {
  it("is a warning before the end and an error after it, with the details the throttle reads", () => {
    const ownApp = { clientId: "c-1", credentialKind: "secret" };
    const soon = sourceAppNotification(
      SOURCE,
      ownApp,
      { expiresAt: "2026-11-02T00:00:00.000Z", stage: "soon7" },
      NOW,
    );
    expect(soon).toMatchObject({
      tenantId: "t-1",
      level: "warning",
      event: "source.app_secret_expiring",
      details: {
        sourceId: "s-1",
        objectName: "Contoso 365",
        clientId: "c-1",
        credentialKind: "secret",
        expiresAt: "2026-11-02T00:00:00.000Z",
        days: 1,
        stage: "soon7",
      },
    });
    expect(soon.message).toBe(
      "The client secret of the Microsoft 365 app c-1 of the source Contoso 365 expires on 2026-11-02 (in 1 day).",
    );
    const expired = sourceAppNotification(
      SOURCE,
      { credentialKind: "certificate" },
      { expiresAt: "2026-10-30T00:00:00.000Z", stage: "expired" },
      NOW,
    );
    expect(expired.level).toBe("error");
    expect(expired.details).toMatchObject({
      clientId: "",
      credentialKind: "certificate",
      days: -2,
    });
    expect(expired.message).toBe(
      "The certificate of the own Microsoft 365 app of the source Contoso 365 expired on 2026-10-30; its backups cannot sign in until a new one is entered.",
    );
  });
});
