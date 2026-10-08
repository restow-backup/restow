import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "@/lib/api";

import { reportErrorMessage } from "./report-errors";

/** Keys come back as-is, with interpolated values appended. */
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key}(${Object.values(values).join(",")})` : key) as unknown as TFunction;

function problem(type: string, status = 403, extra: Record<string, unknown> = {}): ApiError {
  return new ApiError(status, { type, title: "Problem", status, ...extra }, "x");
}

describe("reportErrorMessage", () => {
  it("says neutrally that time-triggered reports are not available, whoever refused them", () => {
    expect(
      reportErrorMessage(
        problem("urn:restow:problem:feature-unavailable", 403, { feature: "reports.timed" }),
        t,
      ),
    ).toBe("errors.featureUnavailable");
    expect(reportErrorMessage(problem("urn:restow:problem:edition-required"), t)).toBe(
      "errors.featureUnavailable",
    );
  });

  it("words the refused rule by its code, never with the server's English text", () => {
    expect(
      reportErrorMessage(
        problem("urn:restow:problem:invalid-report-rule", 422, {
          detail: "channels: Add a recipient or a webhook.",
          code: "channel_required",
        }),
        t,
      ),
    ).toBe("errors.invalid(errors.codes.channel_required)");
    expect(
      reportErrorMessage(
        problem("urn:restow:problem:invalid-report-rule", 422, {
          detail: 'timezone: "Europe/Berln" is not an IANA time zone',
          code: "something_new",
        }),
        t,
      ),
    ).toBe("errors.invalid(errors.codes.unknown)");
  });

  it("names a missing rule, the network, the demo, a missing right, or falls back", () => {
    expect(reportErrorMessage(problem("about:blank", 404), t)).toBe("errors.notFound");
    expect(reportErrorMessage(new NetworkError(null), t)).toBe("errors.network");
    expect(reportErrorMessage(problem("urn:restow:problem:demo-read-only", 403), t)).toBe(
      "common:errors.demoReadOnly",
    );
    expect(reportErrorMessage(problem("about:blank", 403), t)).toBe("common:errors.forbidden");
    expect(reportErrorMessage(problem("about:blank", 409), t)).toBe("common:errors.conflict");
    expect(reportErrorMessage(new Error("?"), t)).toBe("common:errors.generic");
  });
});
