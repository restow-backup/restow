import { configureProductName } from "@restow/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { renderAlert } from "./render.js";

afterEach(() => {
  configureProductName(null);
});

function alert(details: Record<string, unknown>, language: "en" | "de" = "en") {
  return renderAlert({
    language,
    tenantName: "Contoso",
    ruleName: "Failed backups",
    payload: {
      event: "backup.failed",
      occurredAt: "2026-09-29T10:00:00.000Z",
      details: { objectName: "Alice", ...details },
    },
  });
}

describe("renderAlert", () => {
  it("names the disk and what is left on it for the low disk space warning", () => {
    const disk = (language: "en" | "de") =>
      renderAlert({
        language,
        tenantName: "Contoso",
        ruleName: "Disks",
        payload: {
          event: "installation.disk_low",
          occurredAt: "2026-09-29T10:00:00.000Z",
          details: {
            disk: "database",
            location: "restow_pgdata",
            freeBytes: 4 * 1024 ** 3,
            totalBytes: 38 * 1024 ** 3,
            objectName: "restow_pgdata",
          },
        },
      });
    const english = disk("en");
    expect(english.subject).toBe("[Contoso] Low disk space: restow_pgdata");
    expect(english.text).toContain("Disk: Under the database");
    expect(english.text).toContain("Free: 4.0 GiB");
    expect(english.text).toContain("Size: 38.0 GiB");
    const german = disk("de");
    expect(german.subject).toBe("[Contoso] Wenig Speicherplatz: restow_pgdata");
    expect(german.text).toContain("Datenträger: Unter der Datenbank");
    expect(german.text).toContain("Frei: 4,0 GiB");
  });

  it("names the restore point and every finding of a suspicious backup", () => {
    const suspicious = (language: "en" | "de") =>
      renderAlert({
        language,
        tenantName: "Contoso",
        ruleName: "Ransomware",
        payload: {
          event: "backup.suspicious",
          occurredAt: "2026-09-29T10:00:00.000Z",
          details: {
            objectName: "fs01",
            restorePointAt: "2026-09-29T09:30:00.000Z",
            findings: [
              { code: "ransom_notes", value: 37, threshold: 2, examples: ["HOW_TO_DECRYPT.txt"] },
              {
                code: "change_rate_bytes",
                value: 30 * 1024 ** 3,
                threshold: 2 * 1024 ** 3,
                baseline: 200 * 1024 ** 2,
              },
              { code: "mass_deletions", value: 3000, threshold: 1000, share: 0.6 },
              {
                code: "incompressible_data",
                value: 0.998,
                threshold: 0.95,
                baseline: 0.45,
                bytes: 4 * 1024 ** 3,
              },
              { code: "dedup_collapse", value: 0.99, threshold: 0.8, baseline: 0.4 },
              { code: "from_a_newer_worker", value: 1, threshold: 1 },
            ],
            retentionHeld: true,
          },
        },
      });
    const english = suspicious("en");
    expect(english.subject).toBe("[Contoso] Suspicious backup (signs of ransomware): fs01");
    expect(english.text).toContain("Restore point: 29 Sept 2026, 09:30 UTC");
    expect(english.text).toContain("37 files named like a ransom note (HOW_TO_DECRYPT.txt)");
    expect(english.text).toContain("30 GiB added, usually about 200 MiB (alert above 2 GiB)");
    expect(english.text).toContain("3,000 files deleted, 60% of the files before");
    expect(english.text).toContain(
      "4 GiB of new data barely compress: stored at 99.8% of their size, usually 45% (alert from 95%)",
    );
    expect(english.text).toContain(
      "99% of the data read was new, nothing deduplicated; usually 40% (alert from 80%)",
    );
    expect(english.text).toContain("Another finding (1)");
    expect(english.text).toContain("Retention: Paused: no restore point of this object is deleted");
    const german = suspicious("de");
    expect(german.subject).toBe("[Contoso] Verdächtige Sicherung (Anzeichen von Ransomware): fs01");
    expect(german.text).toContain("Befunde: 37 Dateien mit dem Namen einer Lösegeldforderung");
    // German puts a no-break space before the percent sign.
    expect(german.text).toMatch(/3\.000 Dateien gelöscht, 60\s% der vorherigen Dateien/);
    expect(german.text).toContain("Aufbewahrung: Angehalten");
  });

  it("says what stopped in the archive capture, since when and what arrived last", () => {
    const alert = (language: "en" | "de", details: Record<string, unknown>) =>
      renderAlert({
        language,
        tenantName: "Contoso",
        ruleName: "Archive",
        payload: { event: "archive.failed", occurredAt: "2026-10-13T10:00:00.000Z", details },
      });
    const failing = alert("en", {
      reason: "capture_error",
      queue: "archive",
      objectName: "alice@contoso.example",
      errorSince: "2026-10-13T08:30:00.000Z",
    });
    expect(failing.subject).toBe("[Contoso] Archive sync failed: alice@contoso.example");
    expect(failing.text).toContain("Archive capture from this mailbox has been failing");
    expect(failing.text).toContain("Since: 13 Oct 2026, 08:30 UTC");
    const journal = alert("de", {
      reason: "journal_stale",
      queue: "archive",
      lastReportAt: "2026-10-12T07:00:00.000Z",
    });
    expect(journal.subject).toBe("[Contoso] Archiv-Abgleich fehlgeschlagen: Archiv-Abgleich");
    expect(journal.text).toContain("Seit mehr als 24 Stunden ist kein Journal-Report angekommen");
    expect(journal.text).toContain("Zuletzt angekommen: 12.10.2026");
  });

  it("says since when retention of a held object is paused", () => {
    const reminder = (language: "en" | "de") =>
      renderAlert({
        language,
        tenantName: "Contoso",
        ruleName: "Ransomware",
        payload: {
          event: "backup.suspicious_hold",
          occurredAt: "2026-10-13T10:00:00.000Z",
          details: {
            objectName: "fs01",
            heldSince: "2026-09-29T09:30:00.000Z",
            heldDays: 14,
            restorePoints: 3,
          },
        },
      });
    const english = reminder("en");
    expect(english.subject).toBe(
      "[Contoso] Retention still paused after a suspicious backup: fs01",
    );
    expect(english.text).toContain("Paused since: 29 Sept 2026, 09:30 UTC");
    expect(english.text).toContain("Restore points on hold: 3");
    const german = reminder("de");
    expect(german.text).toContain("Angehalten seit: 29.09.2026");
  });

  it("calls a red rating for a backup that is too old what it is, not a failed restore check", () => {
    const red = (redReason: string, language: "en" | "de" = "en") =>
      renderAlert({
        language,
        tenantName: "Contoso",
        ruleName: "Readiness",
        payload: {
          event: "verify.red",
          occurredAt: "2026-09-29T10:00:00.000Z",
          details: { objectName: "Alice", redReason, reasons: ["snapshot_outdated"] },
        },
      });
    expect(red("outdated").subject).toBe("[Contoso] Backup too old: Alice");
    expect(red("outdated", "de").subject).toBe("[Contoso] Sicherung zu alt: Alice");
    expect(red("damaged").subject).toBe("[Contoso] Restore check failed: Alice");
  });

  it("says why a job failed and what to do, in the recipient's language", () => {
    const message = alert({
      errorMessage: "GraphError: Graph GET failed with 403 (ErrorAccessDenied)",
      failure: {
        code: "graph.permission_missing",
        transient: false,
        params: { permission: "Mail.ReadWrite" },
        steps: ["grant_permission", "verify_permissions"],
      },
    });
    expect(message.text).toContain("Cause");
    expect(message.text).toContain("The Restow app is missing a Microsoft 365 permission");
    expect(message.text).toContain("What to do");
    expect(message.text).toContain("Add the application permission Mail.ReadWrite");
    expect(message.text).toContain('Run "Verify permissions" on the source');
    // The raw message stays, after the explanation.
    expect(message.text).toContain("GraphError: Graph GET failed with 403");
    expect(message.html).toContain("Mail.ReadWrite");

    const german = alert(
      {
        failure: {
          code: "graph.throttled",
          params: { retryAfterSeconds: 32 },
          steps: ["wait_throttled"],
        },
      },
      "de",
    );
    expect(german.text).toContain("Ursache");
    expect(german.text).toContain("Microsoft bremst Restow aus (Drosselung)");
    expect(german.text).toContain("Was zu tun ist");
  });

  it("names the product the installation is branded with, in the text, the footer and the HTML", () => {
    configureProductName("Acme Backup");
    const message = alert({
      failure: { code: "graph.permission_missing", params: {}, steps: [] },
    });
    expect(message.text).toContain("The Acme Backup app is missing a Microsoft 365 permission");
    expect(message.text).toMatch(/in Acme Backup\./);
    expect(message.html).toContain("in Acme Backup.");
    expect(message.text).not.toContain("Restow");
    expect(message.html).not.toContain("Restow");
  });

  it("renders alerts without a cause exactly as before, and copes with a code it does not know", () => {
    const old = alert({ errorMessage: "boom" });
    expect(old.text).not.toContain("Cause");
    expect(old.text).toContain("boom");

    const future = alert({
      failure: { code: "future.thing", params: {}, steps: ["from_the_future"] },
    });
    expect(future.text).toContain("The cause could not be identified");
    expect(future.text).not.toContain("failures:");
    expect(alert({ failure: "nonsense" }).text).not.toContain("Cause");
    expect(alert({ failure: { code: 7 } }).text).not.toContain("Cause");
  });
});
