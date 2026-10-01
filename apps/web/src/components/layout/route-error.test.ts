import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "@/lib/api";

import { technicalDetail } from "./route-error.js";

describe("technicalDetail", () => {
  it("shows the message of an unexpected error for a bug report", () => {
    expect(technicalDetail(new TypeError("items is undefined"))).toBe(
      "TypeError: items is undefined",
    );
    expect(technicalDetail("plain failure")).toBe("plain failure");
  });

  it("adds nothing for API and network failures, whose cause is already explained", () => {
    expect(technicalDetail(new ApiError(500, null, "boom"))).toBeNull();
    expect(technicalDetail(new NetworkError(new Error("refused")))).toBeNull();
    expect(technicalDetail(undefined)).toBeNull();
  });
});
