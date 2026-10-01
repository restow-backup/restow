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

  it("names the refused field, a missing rule, the network, or falls back", () => {
    expect(
      reportErrorMessage(
        problem("urn:restow:problem:invalid-report-rule", 422, { detail: "cron" }),
        t,
      ),
    ).toBe("errors.invalid(cron)");
    expect(reportErrorMessage(problem("about:blank", 404), t)).toBe("errors.notFound");
    expect(reportErrorMessage(new NetworkError(null), t)).toBe("errors.network");
    expect(reportErrorMessage(new Error("?"), t)).toBe("errors.generic");
  });
});
