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
