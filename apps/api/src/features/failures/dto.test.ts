import { classifyFailure, toFailureRecord } from "@restow/core";
import { describe, expect, it } from "vitest";
import { causeToFailureDto, causeToRecord, failureDto } from "./dto.js";

const DOCS = "https://docs.example.test/troubleshooting/";
const AT = new Date("2026-09-29T10:00:00.000Z");

describe("failureDto", () => {
  it("adds the steps, the retry advice and the docs page to a stored record", () => {
    const record = toFailureRecord(
      {
        code: "graph.permission_missing",
        transient: false,
        params: { permission: "Mail.ReadWrite", httpStatus: 403 },
        technical: { requestId: "abc", endpoint: "GET /v1.0/users/a@b.de/mailFolders" },
      },
      {
        now: AT,
        step: "enumerate",
        retry: { attempt: 2, limit: 6, nextAttemptAt: "2026-09-29T10:04:00.000Z" },
      },
    );
    const dto = failureDto(JSON.parse(JSON.stringify(record)), DOCS);
    expect(dto).toMatchObject({
      code: "graph.permission_missing",
      category: "microsoft",
      transient: false,
      retryable: true,
      params: { permission: "Mail.ReadWrite", httpStatus: 403 },
      technical: { requestId: "abc" },
      occurredAt: "2026-09-29T10:00:00.000Z",
      step: "enumerate",
      retry: { attempt: 2, limit: 6, nextAttemptAt: "2026-09-29T10:04:00.000Z" },
      docsUrl: DOCS,
    });
    expect(dto?.steps.map((step) => step.id)).toEqual(["grant_permission", "verify_permissions"]);
    expect(dto?.steps[0]?.target).toBe("source");
  });

  it("is null for rows without a usable record, so old rows fall back to their text", () => {
    expect(failureDto(null, DOCS)).toBeNull();
    expect(failureDto(undefined, DOCS)).toBeNull();
    expect(failureDto("boom", DOCS)).toBeNull();
    expect(failureDto({ nothing: true }, DOCS)).toBeNull();
  });

  it("keeps a code from a newer version and explains it generically", () => {
    const dto = failureDto(
      { v: 1, code: "future.thing", transient: true, params: {}, technical: { message: "x" } },
      DOCS,
    );
    expect(dto).toMatchObject({ code: "future.thing", category: null, steps: [], retryable: true });
  });

  it("uses the configured docs page by default", () => {
    expect(failureDto({ code: "unknown", transient: false })?.docsUrl).toMatch(/^https:\/\//);
  });
});

describe("derived causes", () => {
  it("dates a derived cause and shapes it for storage in a jsonb column", () => {
    const cause = classifyFailure(new Error("boom"));
    expect(causeToFailureDto(cause, AT, DOCS)).toMatchObject({
      code: "unknown",
      occurredAt: "2026-09-29T10:00:00.000Z",
    });
    const stored = causeToRecord(cause, AT);
    expect(stored).toMatchObject({ v: 1, code: "unknown", occurredAt: "2026-09-29T10:00:00.000Z" });
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
    expect(causeToRecord(null, AT)).toBeNull();
  });
});
