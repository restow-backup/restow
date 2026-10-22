import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";

import { formatDay, licenseErrorMessage, updatesLine, updatesNotice } from "./presenters";
import type { InstalledKey } from "./types";

function key(until: string | null): InstalledKey {
  return {
    keyId: "ABCD-EFGH-IJKL-MNOP",
    licensee: "Example IT GmbH",
    issuedAt: "2026-09-01T10:00:00.000Z",
    installedAt: "2026-09-02T10:00:00.000Z",
    installationId: "11111111-1111-4111-8111-111111111111",
    updates: { series: "1", until, coversRunning: true, reason: "series" },
  };
}

describe("updatesLine", () => {
  it("names a beta licence by its series and a period by its last day", () => {
    expect(updatesLine(key(null), "de")).toEqual({
      key: "license:updates.series",
      values: { series: "1" },
    });
    expect(updatesLine(key("2027-11-30"), "de")).toEqual({
      key: "license:updates.until",
      values: { date: "30.11.2027" },
    });
  });

  it("says nothing for a server before 0.4.5", () => {
    expect(updatesLine({ ...key(null), updates: undefined }, "en")).toBeNull();
  });
});

describe("updatesNotice", () => {
  const at = (iso: string) => Date.parse(iso);

  it("starts 30 days before the end of the last day and stays after it", () => {
    const k = key("2027-11-30");
    expect(updatesNotice(k, at("2027-10-31T23:59:59.998Z"), "en")).toBeNull();
    expect(updatesNotice(k, at("2027-10-31T23:59:59.999Z"), "en")?.key).toBe(
      "license:updates.endingSoon",
    );
    expect(updatesNotice(k, at("2027-11-30T23:59:59.999Z"), "en")?.key).toBe(
      "license:updates.endingSoon",
    );
    expect(updatesNotice(k, at("2027-12-01T00:00:00.000Z"), "en")?.key).toBe(
      "license:updates.ended",
    );
  });

  it("never appears for a beta licence or without a key", () => {
    expect(updatesNotice(key(null), at("2040-01-01T00:00:00Z"), "en")).toBeNull();
    expect(updatesNotice(null, at("2040-01-01T00:00:00Z"), "en")).toBeNull();
  });
});

describe("licenseErrorMessage: update terms", () => {
  const rejected = (extensions: Record<string, unknown>) =>
    new ApiError(
      422,
      {
        type: "urn:restow:problem:license-invalid",
        title: "License key rejected",
        status: 422,
        ...extensions,
      },
      "rejected",
    );

  it("explains a key whose update period ended before this version", () => {
    expect(
      licenseErrorMessage(
        rejected({ reason: "outside_update_period", updatesUntil: "2027-11-30", version: "1.8.0" }),
        "de",
      ),
    ).toEqual({
      key: "license:errors.outside_update_period",
      values: { date: "30.11.2027", version: "1.8.0" },
    });
    expect(
      licenseErrorMessage(
        rejected({
          reason: "outside_update_period",
          updatesUntil: null,
          series: "1",
          version: "2.0.0",
        }),
      ),
    ).toEqual({ key: "license:errors.outside_series", values: { series: "1", version: "2.0.0" } });
  });

  it("explains a key signed with a vendor key this version does not know", () => {
    expect(licenseErrorMessage(rejected({ reason: "unknown_signing_key" }))).toEqual({
      key: "license:errors.unknown_signing_key",
    });
  });

  it("formats a day without shifting it", () => {
    expect(formatDay("2028-02-29", "en")).toBe("Feb 29, 2028");
  });
});
