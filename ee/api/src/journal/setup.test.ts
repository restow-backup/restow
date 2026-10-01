import { describe, expect, it } from "vitest";
import {
  EXCHANGE_SMTP_PORT,
  journalAddress,
  journalDocsUrl,
  journalStatus,
  normalizeJournalHostname,
  receiverReason,
  tokenFingerprint,
} from "./setup.js";

describe("normalizeJournalHostname", () => {
  it("returns a bare lowercase host name", () => {
    expect(normalizeJournalHostname("Archive.Example.COM")).toEqual({
      hostname: "archive.example.com",
      issue: null,
    });
    expect(normalizeJournalHostname("  archive.example.com.  ")).toEqual({
      hostname: "archive.example.com",
      issue: null,
    });
  });

  it("reports an unset or empty host as missing", () => {
    expect(normalizeJournalHostname(undefined)).toEqual({ hostname: null, issue: "missing" });
    expect(normalizeJournalHostname("   ")).toEqual({ hostname: null, issue: "missing" });
  });

  it("reports anything that is not a host name as invalid", () => {
    for (const value of [
      "https://archive.example.com",
      "archive.example.com/path",
      "journal@archive.example.com",
      "archive example.com",
      "-archive.example.com",
      "archive..example.com",
      "archive.example.com:25",
    ]) {
      expect(normalizeJournalHostname(value)).toEqual({ hostname: null, issue: "invalid" });
    }
  });
});

describe("journalAddress", () => {
  it("is journal+<token>@<host>", () => {
    expect(journalAddress("abc234", "archive.example.com")).toBe(
      "journal+abc234@archive.example.com",
    );
  });
});

describe("receiverReason", () => {
  it("names the first thing that keeps the receiver from listening", () => {
    expect(receiverReason({ phase: "listening", port: 25 }, undefined)).toBe("port_not_configured");
    expect(receiverReason({ phase: "unstarted" }, 25)).toBe("not_started");
    expect(receiverReason({ phase: "stopped" }, 25)).toBe("not_started");
    expect(receiverReason({ phase: "port_not_configured" }, 25)).toBe("not_started");
    expect(receiverReason({ phase: "edition_not_licensed" }, 25)).toBe("restart_required");
    expect(receiverReason({ phase: "failed", message: "listen EADDRINUSE" }, 25)).toBe(
      "listen_failed",
    );
  });

  it("names the TLS problem that kept the listener from starting, or took its certificate away", () => {
    expect(receiverReason({ phase: "tls_not_configured" }, 25)).toBe("tls_not_configured");
    expect(
      receiverReason(
        { phase: "tls_invalid", message: "the certificate file /x cannot be read" },
        25,
      ),
    ).toBe("tls_invalid");
    expect(receiverReason({ phase: "tls_expired", message: "expired on 2026-01-01" }, 25)).toBe(
      "tls_expired",
    );
  });

  it("puts a missing port before any TLS state: there is no receiver to configure yet", () => {
    expect(receiverReason({ phase: "tls_not_configured" }, undefined)).toBe("port_not_configured");
  });

  it("is null while the listener is up", () => {
    expect(receiverReason({ phase: "listening", port: 25 }, 25)).toBeNull();
  });
});

describe("journalStatus", () => {
  const now = new Date("2026-09-30T12:00:00Z");

  it("is receiver_down whenever the receiver cannot listen, whatever arrived earlier", () => {
    for (const reason of [
      "listen_failed",
      "tls_not_configured",
      "tls_invalid",
      "tls_expired",
    ] as const) {
      expect(journalStatus({ reason, lastReportAt: now, now })).toBe("receiver_down");
    }
  });

  it("is not_configured, not receiver_down, while JOURNAL_SMTP_PORT is not set", () => {
    // An installation that does not use journaling has nothing broken; whatever
    // arrived earlier or whatever state the listener recorded does not change that.
    expect(journalStatus({ reason: "port_not_configured", lastReportAt: null, now })).toBe(
      "not_configured",
    );
    expect(journalStatus({ reason: "port_not_configured", lastReportAt: now, now })).toBe(
      "not_configured",
    );
  });

  it("keeps receiver_down for a receiver that is configured but cannot run", () => {
    for (const reason of ["restart_required", "not_started"] as const) {
      expect(journalStatus({ reason, lastReportAt: null, now })).toBe("receiver_down");
    }
  });

  it("is no_reports until the first report", () => {
    expect(journalStatus({ reason: null, lastReportAt: null, now })).toBe("no_reports");
  });

  it("is receiving within 24 hours of the last report and stale after", () => {
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
    expect(journalStatus({ reason: null, lastReportAt: hoursAgo(1), now })).toBe("receiving");
    expect(journalStatus({ reason: null, lastReportAt: hoursAgo(24), now })).toBe("receiving");
    expect(journalStatus({ reason: null, lastReportAt: hoursAgo(25), now })).toBe("stale");
  });
});

describe("journalDocsUrl", () => {
  it("sits next to the public troubleshooting page", () => {
    expect(journalDocsUrl("https://docs.example.test/administrators/troubleshooting/")).toBe(
      "https://docs.example.test/administrators/exchange-journaling/",
    );
  });

  it("gives no link when the operator pointed the docs at their own runbook", () => {
    expect(journalDocsUrl("https://wiki.example.test/restow/")).toBeNull();
    expect(journalDocsUrl("not a url")).toBeNull();
  });
});

describe("tokenFingerprint", () => {
  it("is a short stable mark that does not contain the token", () => {
    const token = "abcdefghijklmnopqrstuvwxyz234567";
    expect(tokenFingerprint(token)).toMatch(/^[0-9a-f]{12}$/);
    expect(tokenFingerprint(token)).toBe(tokenFingerprint(token));
    expect(tokenFingerprint(token)).not.toBe(tokenFingerprint(`${token}x`));
  });
});

describe("Exchange Online's port", () => {
  it("is 25", () => {
    expect(EXCHANGE_SMTP_PORT).toBe(25);
  });
});
