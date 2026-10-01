import { describe, expect, it } from "vitest";

import type { JournalSetup } from "./api";
import {
  GUIDE_STEPS,
  STATUS_TONE,
  checklistItems,
  guideOpenByDefault,
  isNotSetUp,
} from "./presenters";

function setup(overrides: Partial<JournalSetup["requirements"]> = {}): JournalSetup {
  return {
    address: "journal+abc@archive.example.test",
    localPart: "journal+abc",
    hostname: "archive.example.test",
    hostnameIssue: null,
    status: "no_reports",
    receiver: { listening: true, reason: null },
    lastReportAt: null,
    counts: { last24Hours: 0, last7Days: 0 },
    requirements: {
      dnsName: "archive.example.test",
      smtpPort: 25,
      exchangePort: 25,
      portMismatch: false,
      tlsConfigured: true,
      maxMessageMegabytes: 150,
      ...overrides,
    },
    docsUrl: null,
  };
}

describe("STATUS_TONE", () => {
  it("never shows a missing receiver or a silent one as healthy", () => {
    // Reports arriving is running work (Lapis, live), not a passed restore check: never green.
    expect(STATUS_TONE).toEqual({
      receiving: "info",
      stale: "warning",
      no_reports: "muted",
      receiver_down: "destructive",
      not_configured: "muted",
    });
  });

  it("keeps red for a receiver that is down and never for one that is not set up", () => {
    expect(STATUS_TONE.not_configured).not.toBe(STATUS_TONE.receiver_down);
    expect(STATUS_TONE.not_configured).toBe("muted");
  });
});

describe("checklistItems", () => {
  it("lists what Exchange Online needs, with only the configured items marked as met", () => {
    const items = checklistItems(setup());
    expect(items.map((item) => [item.id, item.key, item.state])).toEqual([
      ["dns", "dns", "todo"],
      ["port", "portOk", "todo"],
      ["tls", "tlsOk", "ok"],
      ["size", "size", "ok"],
    ]);
    expect(items[0]?.params).toEqual({ host: "archive.example.test" });
    expect(items[3]?.params).toEqual({ size: 150 });
  });

  it("warns when the port is not the one Exchange Online uses", () => {
    const port = checklistItems(setup({ smtpPort: 2525, portMismatch: true })).find(
      (item) => item.id === "port",
    );
    expect(port).toMatchObject({ key: "portForward", state: "warn", params: { port: 2525 } });
  });

  it("warns when no port is configured, and when TLS is missing", () => {
    const items = checklistItems(setup({ smtpPort: null, tlsConfigured: false }));
    expect(items.find((item) => item.id === "port")).toMatchObject({
      key: "portUnset",
      state: "warn",
    });
    expect(items.find((item) => item.id === "tls")).toMatchObject({
      key: "tlsMissing",
      state: "warn",
    });
  });

  it("lists the missing port and certificate as things to do, not warnings, before journaling is set up", () => {
    const items = checklistItems({
      ...setup({ smtpPort: null, tlsConfigured: false }),
      status: "not_configured",
      receiver: { listening: false, reason: "port_not_configured" },
    });
    expect(items.map((item) => [item.id, item.key, item.state])).toEqual([
      ["dns", "dns", "todo"],
      ["port", "portUnset", "todo"],
      ["tls", "tlsNeeded", "todo"],
      ["size", "size", "ok"],
    ]);
    expect(items.some((item) => item.state === "warn")).toBe(false);
  });

  it("still warns about a missing certificate once the receiver is configured", () => {
    const items = checklistItems({
      ...setup({ tlsConfigured: false }),
      status: "receiver_down",
      receiver: { listening: false, reason: "tls_not_configured" },
    });
    expect(items.find((item) => item.id === "tls")).toMatchObject({
      key: "tlsMissing",
      state: "warn",
    });
  });

  it("asks for a DNS name to be published later while no host is configured", () => {
    expect(checklistItems(setup({ dnsName: null }))[0]).toMatchObject({
      key: "dnsUnset",
      state: "todo",
    });
  });
});

describe("isNotSetUp", () => {
  it("is true only for a receiver that was never configured", () => {
    expect(isNotSetUp("not_configured")).toBe(true);
    for (const status of ["receiving", "stale", "no_reports", "receiver_down"] as const) {
      expect(isNotSetUp(status)).toBe(false);
    }
  });
});

describe("guide", () => {
  it("has the six steps in order", () => {
    expect([...GUIDE_STEPS]).toEqual([
      "connector",
      "routing",
      "validate",
      "undeliverable",
      "rule",
      "verify",
    ]);
  });

  it("starts open until reports arrive", () => {
    expect(guideOpenByDefault("no_reports")).toBe(true);
    expect(guideOpenByDefault("receiver_down")).toBe(true);
    expect(guideOpenByDefault("stale")).toBe(true);
    expect(guideOpenByDefault("receiving")).toBe(false);
  });

  it("stays folded while journaling is not set up at all", () => {
    expect(guideOpenByDefault("not_configured")).toBe(false);
  });
});
