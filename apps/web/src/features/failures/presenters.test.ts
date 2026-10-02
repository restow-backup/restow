import { describe, expect, it } from "vitest";

import type { Failure } from "./api";
import { stepLink } from "./paths";
import { failureTone, supportText, technicalRows, textVariables } from "./presenters";

const base: Failure = {
  code: "graph.access_denied",
  category: "microsoft",
  transient: false,
  retryable: true,
  params: {},
  technical: {},
  occurredAt: "2026-09-29T10:00:00.000Z",
  step: null,
  retry: null,
  steps: [],
  docsUrl: "https://docs.example.test/troubleshooting/",
};

describe("technicalRows", () => {
  it("lists the ids a support case asks for first, in a fixed order", () => {
    const rows = technicalRows({
      technical: {
        message: "Access is denied.",
        clientRequestId: "c-1",
        zzz: "unknown to the UI",
        endpoint: "GET /v1.0/users",
        httpStatus: 403,
        requestId: "r-1",
        errorCode: "ErrorAccessDenied",
      },
    });
    expect(rows.map((row) => row.key)).toEqual([
      "httpStatus",
      "errorCode",
      "requestId",
      "clientRequestId",
      "endpoint",
      "message",
      "zzz",
    ]);
    expect(rows[0]).toEqual({ key: "httpStatus", value: "403" });
  });

  it("is empty without details", () => {
    expect(technicalRows({ technical: {} })).toEqual([]);
  });
});

describe("supportText", () => {
  it("is a plain block with the code, the time and the details", () => {
    const failure = { ...base, step: "download", technical: { requestId: "r-1", httpStatus: 403 } };
    expect(supportText(failure, technicalRows(failure))).toBe(
      [
        "code: graph.access_denied",
        "time: 2026-09-29T10:00:00.000Z",
        "step: download",
        "httpStatus: 403",
        "requestId: r-1",
      ].join("\n"),
    );
  });
});

describe("textVariables", () => {
  it("supplies every variable the texts use, with defaults and presence flags", () => {
    const variables = textVariables({
      params: { permission: "Mail.ReadWrite", port: 993, host: null },
    });
    expect(variables).toMatchObject({
      permission: "Mail.ReadWrite",
      has_permission: "yes",
      port: 993,
      has_port: "yes",
      host: "",
      has_host: "no",
      role: "other",
      reason: "other",
    });
  });
});

describe("failureTone", () => {
  it("is a warning only while Restow is retrying a transient failure by itself", () => {
    expect(failureTone({ transient: true, retry: null }, { willRetry: true })).toBe("warning");
    expect(failureTone({ transient: true, retry: null }, { willRetry: false })).toBe("destructive");
    expect(failureTone({ transient: false, retry: null }, { willRetry: true })).toBe("destructive");
    expect(failureTone(null, { willRetry: true })).toBe("destructive");
  });
});

describe("stepLink", () => {
  it("sends each target to its page", () => {
    expect(stepLink({ id: "x", target: "settings_microsoft" })).toEqual({
      to: "/installation/microsoft-app",
    });
    expect(stepLink({ id: "x", target: "sources" })?.to).toBe("/sources");
    expect(stepLink({ id: "x", target: "directory" })?.to).toBe("/protected-objects");
    expect(stepLink({ id: "x", target: "storage" })?.to).toBe("/repositories");
    expect(stepLink({ id: "x", target: "verify" })?.to).toBe("/verify");
    expect(stepLink({ id: "x", target: "jobs" })?.to).toBe("/backup");
  });

  it("links to the very source when it is known, to the list otherwise", () => {
    expect(stepLink({ id: "x", target: "source" }, { sourceId: "a b" })?.to).toBe("/sources/a%20b");
    expect(stepLink({ id: "x", target: "source" })?.to).toBe("/sources");
  });

  it("links nowhere for a step without a place or one this version does not know", () => {
    expect(stepLink({ id: "x", target: null })).toBeNull();
    expect(stepLink({ id: "x", target: "from-the-future" })).toBeNull();
  });
});
