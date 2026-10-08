import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "@/lib/api";
import {
  CORE_LICENSE_URL,
  aboutLinks,
  authStatusKey,
  backupCodesDocument,
  changePasswordErrorKey,
  detectBrowser,
  detectDevice,
  formatDuration,
  parseTotpUri,
  passkeyErrorKey,
  passkeyRemoval,
  probeTone,
  settingsErrorKey,
  toPasskeyRows,
  toSessionRows,
  twoFactorErrorKey,
} from "./presenters";

describe("aboutLinks", () => {
  const repository = "https://github.com/restow-backup/restow";

  it("points a release at its tag", () => {
    expect(aboutLinks("0.1.0")).toEqual({
      source: `${repository}/tree/v0.1.0`,
      thirdParty: `${repository}/blob/v0.1.0/THIRD_PARTY_NOTICES.md`,
    });
    expect(aboutLinks("v1.2.0-rc.1").source).toBe(`${repository}/tree/v1.2.0-rc.1`);
  });

  it("points a development build at the repository and main", () => {
    for (const running of [null, "", "  "]) {
      expect(aboutLinks(running)).toEqual({
        source: repository,
        thirdParty: `${repository}/blob/main/THIRD_PARTY_NOTICES.md`,
      });
    }
  });

  it("names the English text of the core license", () => {
    expect(CORE_LICENSE_URL).toBe("https://www.apache.org/licenses/LICENSE-2.0");
  });
});

describe("settingsErrorKey", () => {
  it("explains known problem types", () => {
    const problem = (type: string) =>
      new ApiError(409, { type, title: "x", status: 409 }, "fallback");
    expect(settingsErrorKey(problem("urn:restow:problem:setup-incomplete"))).toBe(
      "settings:errors.setupIncomplete",
    );
    expect(settingsErrorKey(problem("urn:restow:problem:master-key-missing"))).toBe(
      "settings:errors.masterKey",
    );
  });

  it("falls back to the shared error keys", () => {
    expect(settingsErrorKey(new ApiError(403, null, "forbidden"))).toBe("common:errors.forbidden");
    expect(settingsErrorKey(new NetworkError(new Error("down")))).toBe("common:errors.network");
  });
});

describe("probeTone", () => {
  it("marks trust, doubt and failure", () => {
    // An answering server is a state, not a passed restore check: no green.
    expect(probeTone("ok")).toBe("neutral");
    expect(probeTone("skipped")).toBe("muted");
    expect(probeTone("unreachable")).toBe("warning");
    expect(probeTone("timeout")).toBe("warning");
    expect(probeTone("certificate_invalid")).toBe("destructive");
    expect(probeTone("unexpected_response")).toBe("destructive");
  });
});

describe("formatDuration", () => {
  it("formats seconds in the UI language", () => {
    expect(formatDuration(1234, "en")).toBe("1.2 sec");
    expect(formatDuration(1234, "de")).toBe("1,2 Sek.");
    expect(formatDuration(15_400, "en")).toBe("15 sec");
  });
});

describe("passkeys", () => {
  it("normalizes the better-auth list, newest first", () => {
    const rows = toPasskeyRows([
      {
        id: "a",
        name: " Laptop ",
        createdAt: "2026-01-01T10:00:00.000Z",
        deviceType: "singleDevice",
        backedUp: false,
      },
      {
        id: "b",
        name: "",
        createdAt: new Date("2026-03-01T10:00:00.000Z"),
        deviceType: "multiDevice",
        backedUp: true,
      },
      { id: "c", createdAt: "garbage" },
      { name: "no id" },
      null,
    ]);
    expect(rows).toEqual([
      { id: "b", name: null, createdAt: "2026-03-01T10:00:00.000Z", synced: true },
      { id: "a", name: "Laptop", createdAt: "2026-01-01T10:00:00.000Z", synced: false },
      { id: "c", name: null, createdAt: null, synced: false },
    ]);
  });

  it("explains ceremony and server failures", () => {
    expect(passkeyErrorKey({ code: "ERROR_CEREMONY_ABORTED", status: 400 })).toBe(
      "settings:security.passkeys.errors.cancelled",
    );
    expect(
      passkeyErrorKey({ code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", status: 400 }),
    ).toBe("settings:security.passkeys.errors.alreadyRegistered");
    expect(passkeyErrorKey({ code: "ERROR_INVALID_RP_ID", status: 400 })).toBe(
      "settings:security.passkeys.errors.domain",
    );
    expect(passkeyErrorKey({ code: "FAILED_TO_VERIFY_REGISTRATION", status: 400 })).toBe(
      "settings:security.passkeys.errors.verificationFailed",
    );
    expect(passkeyErrorKey({ code: "SOMETHING_NEW", status: 500 })).toBe(
      "settings:security.passkeys.errors.generic",
    );
    expect(passkeyErrorKey({ status: 401 })).toBe("common:errors.unauthorized");
  });

  it("explains plain auth request failures by status", () => {
    expect(authStatusKey({ status: 401 })).toBe("common:errors.unauthorized");
    expect(authStatusKey({ status: 503 })).toBe("common:errors.server");
    expect(authStatusKey({ status: 0 })).toBe("common:errors.generic");
  });

  it("suggests a device name from the user agent", () => {
    expect(
      detectDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Safari/605.1.15",
      ),
    ).toBe("Mac");
    expect(detectDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)")).toBe("iPhone");
    expect(detectDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows");
    expect(detectDevice("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("Android");
    expect(detectDevice("curl/8.0")).toBeNull();
  });
});

describe("parseTotpUri", () => {
  const uri =
    "otpauth://totp/Restow%20(restow.example.com%3A8443):admin%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBV&issuer=Restow+%28restow.example.com%3A8443%29&digits=6&period=30";

  it("reads the secret, the account and the issuer of the key URI", () => {
    expect(parseTotpUri(uri)).toEqual({
      secret: "GEZDGNBVGY3TQOJQGEZDGNBV",
      groupedSecret: "GEZD GNBV GY3T QOJQ GEZD GNBV",
      issuer: "Restow (restow.example.com:8443)",
      account: "admin@example.com",
    });
  });

  it("falls back to the label for the issuer and tolerates a missing one", () => {
    expect(parseTotpUri("otpauth://totp/Restow:ops%40example.com?secret=MZXW6")?.issuer).toBe(
      "Restow",
    );
    expect(parseTotpUri("otpauth://totp/ops%40example.com?secret=MZXW6")).toMatchObject({
      issuer: null,
      account: "ops@example.com",
      groupedSecret: "MZXW 6",
    });
  });

  it("refuses anything that is not a TOTP key", () => {
    expect(parseTotpUri("https://example.com/?secret=MZXW6")).toBeNull();
    expect(parseTotpUri("otpauth://totp/x?secret=not-base32!")).toBeNull();
    expect(parseTotpUri("otpauth://totp/x")).toBeNull();
    expect(parseTotpUri("not a uri")).toBeNull();
  });
});

describe("backupCodesDocument", () => {
  it("writes a plain file with the codes under a short header", () => {
    expect(
      backupCodesDocument(["abcde-12345", "fghij-67890"], {
        title: "Restow recovery codes",
        issuer: "Restow (restow.example.com)",
        account: "admin@example.com",
        note: "Each code works once.",
      }),
    ).toBe(
      "Restow recovery codes\nRestow (restow.example.com)\nadmin@example.com\n\nabcde-12345\nfghij-67890\n\nEach code works once.\n",
    );
  });
});

describe("twoFactorErrorKey", () => {
  const key = (status: number, code?: string) => twoFactorErrorKey({ status, code });

  it("explains the failures of the authenticator requests", () => {
    expect(key(400, "INVALID_PASSWORD")).toBe("settings:security.authenticator.errors.password");
    expect(key(401, "INVALID_CODE")).toBe("settings:security.authenticator.errors.code");
    expect(key(400, "TOTP_ALREADY_ENABLED")).toBe(
      "settings:security.authenticator.errors.alreadyEnabled",
    );
    expect(key(400, "TOTP_NOT_ENABLED")).toBe("settings:security.authenticator.errors.notEnabled");
    expect(key(429)).toBe("settings:security.authenticator.errors.tooManyAttempts");
    expect(key(401, "ACCOUNT_TEMPORARILY_LOCKED")).toBe(
      "settings:security.authenticator.errors.tooManyAttempts",
    );
  });

  it("falls back to the plain request explanations", () => {
    expect(key(401)).toBe("common:errors.unauthorized");
    expect(key(500)).toBe("common:errors.server");
  });
});

describe("passkeyRemoval", () => {
  const base = {
    passkeyCount: 1,
    hasPassword: true,
    hasAuthenticator: true,
    microsoftSignIn: false,
  };
  it("says what the account keeps after removing a passkey", () => {
    expect(passkeyRemoval({ ...base, passkeyCount: 2 })).toBe("others");
    expect(passkeyRemoval(base)).toBe("authenticator");
    expect(passkeyRemoval({ ...base, hasAuthenticator: false })).toBe("noAuthenticator");
    expect(passkeyRemoval({ ...base, hasPassword: false, microsoftSignIn: true })).toBe("sso");
  });

  it("blocks removing the only way to sign in", () => {
    expect(passkeyRemoval({ ...base, hasPassword: false })).toBe("blocked");
    expect(passkeyRemoval({ ...base, hasPassword: false, passkeyCount: 2 })).toBe("others");
  });
});

describe("toSessionRows", () => {
  it("puts the current session first, then by last activity, with device and browser", () => {
    const rows = toSessionRows(
      [
        {
          id: "a",
          token: "t-a",
          userAgent: "Mozilla/5.0 (Windows NT 10.0) Firefox/131.0",
          updatedAt: "2026-10-01T00:00:00Z",
        },
        { id: "b", token: "t-b", userAgent: "", updatedAt: "2026-10-05T00:00:00Z", ipAddress: "" },
        {
          id: "c",
          token: "t-c",
          userAgent: "Mozilla/5.0 (iPhone) Safari/605",
          updatedAt: new Date("2026-09-01T00:00:00Z"),
        },
        { token: "no-id" },
        null,
      ],
      "t-c",
    );
    expect(rows.map((row) => row.id)).toEqual(["c", "b", "a"]);
    expect(rows[0]).toMatchObject({ current: true, device: "iPhone", browser: "Safari" });
    expect(rows[0]?.updatedAt).toBe("2026-09-01T00:00:00.000Z");
    expect(rows[1]).toMatchObject({ device: null, browser: null, ipAddress: null });
    expect(rows[2]).toMatchObject({ device: "Windows", browser: "Firefox" });
  });

  it("names the browser from the user agent", () => {
    expect(detectBrowser("Mozilla/5.0 Chrome/129 Safari/537 Edg/129")).toBe("Edge");
    expect(detectBrowser("Mozilla/5.0 Chrome/129 Safari/537")).toBe("Chrome");
    expect(detectBrowser("curl/8")).toBeNull();
  });
});

describe("changePasswordErrorKey", () => {
  it("explains a wrong current password, the policy and the rate limit", () => {
    expect(changePasswordErrorKey({ status: 400, code: "INVALID_PASSWORD" })).toBe(
      "settings:security.password.errors.current",
    );
    expect(changePasswordErrorKey({ status: 400, code: "PASSWORD_TOO_SHORT" })).toBe(
      "settings:security.password.errors.policy",
    );
    expect(changePasswordErrorKey({ status: 429 })).toBe(
      "settings:security.password.errors.tooMany",
    );
    expect(changePasswordErrorKey({ status: 500 })).toBe("common:errors.server");
  });
});
