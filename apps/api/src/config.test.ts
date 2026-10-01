import { describe, expect, it } from "vitest";
import { type Config, demoConfigConflict, loadConfig } from "./config.js";

describe("loadConfig, product name", () => {
  it("is the default product name unless the operator sets one", () => {
    expect(loadConfig({}).productName).toBe("Restow");
    expect(loadConfig({ RESTOW_PRODUCT_NAME: "" }).productName).toBe("Restow");
    expect(loadConfig({ RESTOW_PRODUCT_NAME: "   " }).productName).toBe("Restow");
  });

  it("reads RESTOW_PRODUCT_NAME, cleaned up like every name the texts carry", () => {
    expect(loadConfig({ RESTOW_PRODUCT_NAME: "Acme Backup" }).productName).toBe("Acme Backup");
    expect(loadConfig({ RESTOW_PRODUCT_NAME: "  Acme \n  Backup " }).productName).toBe(
      "Acme Backup",
    );
  });
});

describe("loadConfig, Microsoft sign-in", () => {
  it("keeps the experimental sign-in off however the SSO app is configured", () => {
    expect(loadConfig({}).entra.ssoExperimental).toBe(false);
    expect(
      loadConfig({ ENTRA_SSO_CLIENT_ID: "app", ENTRA_SSO_CLIENT_SECRET: "secret" }).entra
        .ssoExperimental,
    ).toBe(false);
    expect(loadConfig({ RESTOW_EXPERIMENTAL_MICROSOFT_SIGN_IN: "1" }).entra.ssoExperimental).toBe(
      false,
    );
  });

  it("switches it on only with RESTOW_EXPERIMENTAL_MICROSOFT_SIGN_IN=true", () => {
    expect(
      loadConfig({ RESTOW_EXPERIMENTAL_MICROSOFT_SIGN_IN: "true" }).entra.ssoExperimental,
    ).toBe(true);
  });
});

describe("loadConfig, demo section", () => {
  it("is off by default with nothing configured", () => {
    const config = loadConfig({});
    expect(config.demo).toEqual({
      enabled: false,
      email: undefined,
      password: undefined,
      seedToken: undefined,
    });
  });

  it("reads every demo variable", () => {
    const config = loadConfig({
      RESTOW_DEMO: "true",
      RESTOW_DEMO_EMAIL: "demo@example.org",
      RESTOW_DEMO_PASSWORD: "swordfish",
      RESTOW_DEMO_SEED_TOKEN: "seed-secret",
    });
    expect(config.demo).toEqual({
      enabled: true,
      email: "demo@example.org",
      password: "swordfish",
      seedToken: "seed-secret",
    });
  });

  it("is case-insensitive and exact about RESTOW_DEMO's value", () => {
    expect(loadConfig({ RESTOW_DEMO: "TRUE" }).demo.enabled).toBe(true);
    expect(loadConfig({ RESTOW_DEMO: "1" }).demo.enabled).toBe(false);
    expect(loadConfig({ RESTOW_DEMO: "yes" }).demo.enabled).toBe(false);
  });
});

function fixtureConfig(overrides: Partial<Config["demo"]>): Config {
  return {
    ...loadConfig({}),
    demo: {
      enabled: false,
      email: undefined,
      password: undefined,
      seedToken: undefined,
      ...overrides,
    },
  };
}

describe("demoConfigConflict (security review finding 5)", () => {
  it("is null when demo mode is on, whatever else is set", () => {
    expect(
      demoConfigConflict(
        fixtureConfig({ enabled: true, email: "demo@example.org", password: "x" }),
      ),
    ).toBeNull();
  });

  it("is null when demo mode is off and neither demo variable is set", () => {
    expect(demoConfigConflict(fixtureConfig({ enabled: false }))).toBeNull();
  });

  it("flags demo mode off with a leftover email, password, or both", () => {
    expect(
      demoConfigConflict(fixtureConfig({ enabled: false, email: "demo@example.org" })),
    ).toContain("RESTOW_DEMO");
    expect(demoConfigConflict(fixtureConfig({ enabled: false, password: "x" }))).toContain(
      "RESTOW_DEMO",
    );
    expect(
      demoConfigConflict(
        fixtureConfig({ enabled: false, email: "demo@example.org", password: "x" }),
      ),
    ).toContain("RESTOW_DEMO");
  });

  it("never includes the actual secret values in the message", () => {
    const message = demoConfigConflict(
      fixtureConfig({ enabled: false, email: "demo@example.org", password: "super-secret-value" }),
    );
    expect(message).not.toContain("demo@example.org");
    expect(message).not.toContain("super-secret-value");
  });
});

describe("loadConfig, import section", () => {
  it("has the documented defaults", () => {
    expect(loadConfig({}).imports).toEqual({
      dir: "/var/lib/restow/import",
      maxFileBytes: 10 * 1024 * 1024 * 1024,
      uploadTtlHours: 48,
      maxStagingBytes: 100 * 1024 * 1024 * 1024,
      segmentBytes: 8 * 1024 * 1024,
      maxMessageBytes: 256 * 1024 * 1024,
    });
  });

  it("reads every import variable", () => {
    expect(
      loadConfig({
        IMPORT_DIR: "/srv/mail-import",
        IMPORT_MAX_FILE_BYTES: "5000000",
        IMPORT_UPLOAD_TTL_HOURS: "12",
        IMPORT_MAX_STAGING_BYTES: "7000000",
        IMPORT_SEGMENT_BYTES: "1048576",
        IMPORT_MAX_MESSAGE_BYTES: "33554432",
      }).imports,
    ).toEqual({
      dir: "/srv/mail-import",
      maxFileBytes: 5_000_000,
      uploadTtlHours: 12,
      maxStagingBytes: 7_000_000,
      segmentBytes: 1_048_576,
      maxMessageBytes: 33_554_432,
    });
  });

  it("falls back to the defaults for unusable numbers", () => {
    const imports = loadConfig({
      IMPORT_MAX_FILE_BYTES: "0",
      IMPORT_UPLOAD_TTL_HOURS: "-4",
      IMPORT_MAX_STAGING_BYTES: "0",
      IMPORT_MAX_MESSAGE_BYTES: "lots",
    }).imports;
    expect(imports.maxStagingBytes).toBe(100 * 1024 * 1024 * 1024);
    expect(imports.maxFileBytes).toBe(10 * 1024 * 1024 * 1024);
    expect(imports.uploadTtlHours).toBe(48);
    expect(imports.maxMessageBytes).toBe(256 * 1024 * 1024);
  });

  it("keeps the segment size inside the range the segment store supports", () => {
    expect(loadConfig({ IMPORT_SEGMENT_BYTES: "10" }).imports.segmentBytes).toBe(64 * 1024);
    expect(loadConfig({ IMPORT_SEGMENT_BYTES: "999999999999" }).imports.segmentBytes).toBe(
      32 * 1024 * 1024,
    );
  });
});

describe("loadConfig, journal section", () => {
  it("has no certificate and no insecure opt-out by default", () => {
    expect(loadConfig({}).journal).toMatchObject({
      tlsCertPath: undefined,
      tlsKeyPath: undefined,
      allowInsecure: false,
    });
  });

  it("reads the certificate paths", () => {
    const journal = loadConfig({
      JOURNAL_TLS_CERT_PATH: "/etc/restow/journal-tls/fullchain.pem",
      JOURNAL_TLS_KEY_PATH: "/etc/restow/journal-tls/privkey.pem",
    }).journal;
    expect(journal.tlsCertPath).toBe("/etc/restow/journal-tls/fullchain.pem");
    expect(journal.tlsKeyPath).toBe("/etc/restow/journal-tls/privkey.pem");
  });

  it("takes the insecure opt-out only from the exact value true", () => {
    expect(loadConfig({ JOURNAL_ALLOW_INSECURE: "true" }).journal.allowInsecure).toBe(true);
    expect(loadConfig({ JOURNAL_ALLOW_INSECURE: "TRUE" }).journal.allowInsecure).toBe(true);
    for (const value of ["", "false", "1", "yes", "on"]) {
      expect(loadConfig({ JOURNAL_ALLOW_INSECURE: value }).journal.allowInsecure).toBe(false);
    }
  });
});

describe("loadConfig, preview section", () => {
  it("parses previews in two processes unless told otherwise, at most eight", () => {
    expect(loadConfig({}).preview).toEqual({ workers: 2, timeoutMs: 10_000 });
    expect(loadConfig({ PREVIEW_PARSE_WORKERS: "4" }).preview.workers).toBe(4);
    expect(loadConfig({ PREVIEW_PARSE_WORKERS: "99" }).preview.workers).toBe(8);
    for (const value of ["0", "-1", "many"]) {
      expect(loadConfig({ PREVIEW_PARSE_WORKERS: value }).preview.workers).toBe(2);
    }
    expect(loadConfig({ PREVIEW_TIMEOUT_MS: "3000" }).preview.timeoutMs).toBe(3000);
    expect(loadConfig({ PREVIEW_TIMEOUT_MS: "0" }).preview.timeoutMs).toBe(10_000);
  });
});

describe("loadConfig, export section", () => {
  it("keeps a finished export for 24 hours unless told otherwise", () => {
    expect(loadConfig({}).exports).toEqual({ ttlHours: 24, maxTenantBytes: 50 * 1024 ** 3 });
    expect(loadConfig({ EXPORT_TTL_HOURS: "6" }).exports).toEqual({
      ttlHours: 6,
      maxTenantBytes: 50 * 1024 ** 3,
    });
  });

  it("limits the export storage of a tenant to 50 GiB unless told otherwise", () => {
    expect(loadConfig({ EXPORT_MAX_TENANT_BYTES: "1000000" }).exports.maxTenantBytes).toBe(
      1_000_000,
    );
    for (const value of ["0", "-5", "unlimited"]) {
      expect(loadConfig({ EXPORT_MAX_TENANT_BYTES: value }).exports.maxTenantBytes).toBe(
        50 * 1024 ** 3,
      );
    }
  });

  it("falls back to the default for unusable lifetimes", () => {
    for (const value of ["0", "-1", "soon"]) {
      expect(loadConfig({ EXPORT_TTL_HOURS: value }).exports.ttlHours).toBe(24);
    }
  });
});
