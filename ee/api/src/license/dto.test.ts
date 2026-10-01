import { generateKeyPairSync } from "node:crypto";
import type { License } from "@restow/db";
import { describe, expect, it } from "vitest";
import { buildLicenseState } from "./dto.js";

const INSTALLATION = "11111111-1111-4111-8111-111111111111";

const installedRow: License = {
  id: "row-1",
  edition: "business",
  mailboxLimit: null,
  multiTenant: false,
  licensee: "Example GmbH",
  installationId: INSTALLATION,
  signature: "c2lnbmF0dXJl",
  issuedAt: new Date("2026-09-01T08:00:00.000Z"),
  active: true,
  createdAt: new Date("2026-09-20T10:00:00.000Z"),
  updatedAt: new Date("2026-09-20T10:00:00.000Z"),
};

describe("buildLicenseState", () => {
  it("describes a keyless installation", () => {
    const state = buildLicenseState({
      effective: { edition: "community", source: "environment" },
      environmentEdition: "community",
      installed: null,
      installedKeyId: null,
      installationId: INSTALLATION,
      verification: { status: "unconfigured" },
    });
    expect(state).toEqual({
      edition: "community",
      source: "environment",
      environmentEdition: "community",
      installationId: INSTALLATION,
      key: null,
      verification: { status: "unconfigured", source: null, fingerprint: null },
    });
  });

  it("describes an installed key without ever exposing the key text", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const state = buildLicenseState({
      effective: { edition: "business", source: "key" },
      environmentEdition: "community",
      installed: installedRow,
      installedKeyId: "ABCD-EF01-2345-6789",
      installationId: INSTALLATION,
      verification: {
        status: "ready",
        source: "embedded",
        key: publicKey,
        fingerprint: "SHA256:abc",
      },
    });
    expect(state.key).toEqual({
      keyId: "ABCD-EF01-2345-6789",
      licensee: "Example GmbH",
      issuedAt: "2026-09-01T08:00:00.000Z",
      installedAt: "2026-09-20T10:00:00.000Z",
      installationId: INSTALLATION,
    });
    expect(state.verification).toEqual({
      status: "ready",
      source: "embedded",
      fingerprint: "SHA256:abc",
    });
    expect(JSON.stringify(state)).not.toContain(installedRow.signature ?? "");
  });

  it("reports an unreadable verification key override", () => {
    const state = buildLicenseState({
      effective: { edition: "service_provider", source: "environment" },
      environmentEdition: "service_provider",
      installed: null,
      installedKeyId: null,
      installationId: null,
      verification: { status: "invalid", source: "environment" },
    });
    expect(state.verification).toEqual({
      status: "invalid",
      source: "environment",
      fingerprint: null,
    });
    expect(state.installationId).toBeNull();
    expect(state).not.toHaveProperty("usage");
    expect(state).not.toHaveProperty("limits");
  });
});
