import { generateKeyPairSync } from "node:crypto";
import type { License } from "@restow/db";
import { describe, expect, it } from "vitest";
import { keyringOf } from "../../../licensing/src/index.js";
import { buildLicenseState } from "./dto.js";

const DEV_BUILD = { version: null, releasedAt: null };

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
  series: null,
  updatesUntil: null,
  signingKeyId: null,
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
      build: DEV_BUILD,
    });
    expect(state).toEqual({
      edition: "community",
      source: "environment",
      environmentEdition: "community",
      installationId: INSTALLATION,
      key: null,
      verification: { status: "unconfigured", source: null, fingerprint: null },
      runAsCommunity: false,
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
        keyring: keyringOf(publicKey),
        fingerprint: "SHA256:abc",
      },
      build: { version: "0.4.5", releasedAt: "2026-11-01T10:00:00Z" },
    });
    expect(state.key).toEqual({
      keyId: "ABCD-EF01-2345-6789",
      licensee: "Example GmbH",
      issuedAt: "2026-09-01T08:00:00.000Z",
      installedAt: "2026-09-20T10:00:00.000Z",
      installationId: INSTALLATION,
      // A key installed before 0.4.5 is a beta licence: every 1.x and 0.x release.
      updates: { series: "1", until: null, coversRunning: true, reason: "series" },
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
      build: DEV_BUILD,
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

  it("reports the update period and whether it covers the running release", () => {
    const state = buildLicenseState({
      effective: { edition: "business", source: "key" },
      environmentEdition: "community",
      installed: { ...installedRow, series: "1", updatesUntil: "2027-11-30" },
      installedKeyId: "ABCD-EF01-2345-6789",
      installationId: INSTALLATION,
      verification: { status: "unconfigured" },
      build: { version: "1.4.0", releasedAt: "2027-12-01T00:00:00Z" },
    });
    expect(state.key?.updates).toEqual({
      series: "1",
      until: "2027-11-30",
      coversRunning: false,
      reason: "after_period",
    });
    expect(state.runAsCommunity).toBe(false);
  });

  it("keeps showing the key while the release runs as Community (RESTOW_RUN_AS_COMMUNITY)", () => {
    const state = buildLicenseState({
      effective: { edition: "community", source: "environment", runAsCommunity: true },
      environmentEdition: "community",
      installed: { ...installedRow, updatesUntil: "2027-11-30" },
      installedKeyId: "ABCD-EF01-2345-6789",
      installationId: INSTALLATION,
      verification: { status: "unconfigured" },
      build: { version: "1.4.0", releasedAt: "2028-01-10T00:00:00Z" },
    });
    expect(state.edition).toBe("community");
    expect(state.runAsCommunity).toBe(true);
    expect(state.key?.updates.coversRunning).toBe(false);
  });
});
