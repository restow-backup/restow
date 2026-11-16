import { describe, expect, it } from "vitest";
import {
  cssHex,
  DIGEST_MAX_LINES,
  type DigestItem,
  logoContentId,
  logoDisplaySize,
  type MailBrand,
  renderAlert,
  renderDigest,
  renderSummaryFrame,
} from "./render.js";
import unbranded from "./testing/unbranded-0.4.json" with { type: "json" };

/**
 * The mails of 0.5.0: branded (logo inline by Content-ID, accent rule, footer text), the digest,
 * the delivery failure alert, and the unbranded mail byte for byte as 0.4 rendered it
 * (testing/unbranded-0.4.json was rendered with the 0.4 render.ts).
 */

const alertInput = {
  language: "en" as const,
  tenantName: "Contoso <&>",
  ruleName: "Failed runs",
  payload: {
    event: "backup.failed",
    level: "error",
    occurredAt: "2026-09-30T10:00:00.000Z",
    details: { objectName: 'Mailbox "x"', errorMessage: "<script>alert(1)</script>" },
  },
};

const summaryInput = {
  language: "de" as const,
  tenantName: "Contoso",
  ruleName: "Wochenbericht",
  payload: { periodStart: "2026-09-21T00:00:00.000Z", periodEnd: "2026-09-28T00:00:00.000Z" },
};

const brand: MailBrand = {
  senderName: 'MSP <b>"IT"</b>',
  accentColor: "#1d4ed8",
  onAccent: "light",
  linkColor: "#1d4ed8",
  footerText: "MSP GmbH\nMain St 1 <script>\nHRB 123",
  logo: { src: `cid:${logoContentId("a".repeat(64))}`, width: 400, height: 100 },
};

describe("unbranded mails", () => {
  it("are byte for byte what 0.4 sent", () => {
    expect(renderAlert(alertInput)).toEqual(unbranded.alert);
    expect(renderSummaryFrame(summaryInput, [["Erfolgsquote", "99 %"]])).toEqual(unbranded.summary);
    expect(renderAlert({ ...alertInput, brand: null })).toEqual(unbranded.alert);
  });
});

describe("branded mails", () => {
  const branded = renderAlert({ ...alertInput, brand });

  it("show the logo by Content-ID, scaled into 200 × 60 with its name escaped as alt", () => {
    expect(branded.html).toContain(
      `<img src="cid:brand-logo.aaaaaaaaaaaa@mail.invalid" width="200" height="50" alt="MSP &lt;b&gt;&quot;IT&quot;&lt;/b&gt;"`,
    );
    expect(branded.html).not.toMatch(/src="https?:/);
  });

  it("draw the accent rule from the validated colour only", () => {
    expect(branded.html).toContain("background:#1d4ed8");
    expect(() =>
      renderAlert({ ...alertInput, brand: { ...brand, accentColor: "red;x:url(y)" } }),
    ).toThrow(RangeError);
  });

  it("end with the escaped footer text, one line per line", () => {
    expect(branded.html).toContain("MSP GmbH<br>Main St 1 &lt;script&gt;<br>HRB 123");
    expect(branded.text).toContain("MSP GmbH\nMain St 1 <script>\nHRB 123");
    expect(branded.html).not.toContain("<script>");
  });

  it("name the brand instead of the product", () => {
    expect(branded.text).toContain('in MSP <b>"IT"</b>');
    expect(branded.html).toContain("in MSP &lt;b&gt;&quot;IT&quot;&lt;/b&gt;");
  });

  it("leave out a logo whose source is neither a Content-ID nor a branding path", () => {
    const remote = renderAlert({
      ...alertInput,
      brand: { ...brand, logo: { src: "https://tracker.example/pixel.png", width: 1, height: 1 } },
    });
    expect(remote.html).not.toContain("<img");
    const preview = renderAlert({
      ...alertInput,
      brand: {
        ...brand,
        logo: { src: `/api/v1/public/branding/${"t".repeat(43)}.png`, width: 100, height: 30 },
      },
    });
    expect(preview.html).toContain(`src="/api/v1/public/branding/${"t".repeat(43)}.png"`);
  });

  it("brand the summary frame as well", () => {
    const summary = renderSummaryFrame({ ...summaryInput, brand }, [["Erfolgsquote", "99 %"]]);
    expect(summary.html).toContain("cid:brand-logo.");
    expect(summary.html).toContain("Erfolgsquote");
  });
});

describe("cssHex and the logo helpers", () => {
  it("accepts #rrggbb only", () => {
    expect(cssHex("#00ff00")).toBe("#00ff00");
    for (const bad of ["#0f0", "#00FF00", "red", "#00ff00;", "expression(1)"]) {
      expect(() => cssHex(bad)).toThrow(RangeError);
    }
  });

  it("derive a stable Content-ID and keep the aspect ratio", () => {
    expect(logoContentId("ABCDEF0123456789")).toBe("brand-logo.abcdef012345@mail.invalid");
    expect(logoDisplaySize(400, 100)).toEqual({ width: 200, height: 50 });
    expect(logoDisplaySize(100, 300)).toEqual({ width: 20, height: 60 });
    expect(logoDisplaySize(50, 20)).toEqual({ width: 50, height: 20 });
  });
});

describe("renderDigest", () => {
  const item = (overrides: Partial<DigestItem>): DigestItem => ({
    tenantName: "Contoso",
    event: "backup.failed",
    level: "error",
    occurredAt: "2026-09-30T10:00:00.000Z",
    target: "Alice",
    ...overrides,
  });

  it("groups by tenant and severity, the installation first, every value escaped", () => {
    const digest = renderDigest({
      language: "en",
      audience: "provider",
      window: "daily",
      windowStart: "2026-09-29T07:00:00.000Z",
      windowEnd: "2026-09-30T07:00:00.000Z",
      items: [
        item({
          tenantName: "Fabrikam",
          level: "warning",
          event: "backup.overdue",
          target: "<b>Bob</b>",
        }),
        item({ tenantName: "Contoso", level: "info", event: "backup.succeeded" }),
        item({ tenantName: "Contoso" }),
        item({ tenantName: null, event: "update.available", level: "info", target: "0.5.1" }),
      ],
    });
    expect(digest.subject).toContain("4 notifications");
    const order = ["Installation", "Contoso", "Fabrikam"].map((name) => digest.text.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Within Contoso the error comes before the notice.
    const contoso = digest.text.slice(digest.text.indexOf("Contoso"));
    expect(contoso.indexOf("Error: Backup failed")).toBeLessThan(contoso.indexOf("Notice: "));
    expect(digest.html).toContain("&lt;b&gt;Bob&lt;/b&gt;");
    expect(digest.html).not.toContain("<b>Bob</b>");
  });

  it("names the tenant in a tenant's digest and caps the lines", () => {
    const items = Array.from({ length: DIGEST_MAX_LINES + 5 }, (_, index) =>
      item({ target: `Object ${index}` }),
    );
    const digest = renderDigest({
      language: "de",
      audience: "tenant",
      tenantName: "Contoso",
      window: "hourly",
      windowStart: null,
      windowEnd: "2026-09-30T11:00:00.000Z",
      items,
    });
    expect(digest.subject.startsWith("[Contoso] ")).toBe(true);
    expect(digest.text).toContain("Und 5 weitere.");
    expect(digest.text).not.toContain(`Object ${DIGEST_MAX_LINES}`);
  });

  it("names the service with the object, as the alert mail does (0.5.0)", () => {
    const digest = renderDigest({
      language: "de",
      audience: "tenant",
      tenantName: "Contoso",
      window: "daily",
      windowStart: null,
      windowEnd: "2026-09-30T07:00:00.000Z",
      items: [
        item({ target: "msp@contoso.example", objectKind: "onedrive" }),
        item({ target: "msp@contoso.example", objectKind: "mailbox", level: "warning" }),
        item({ target: "Contoso", objectKind: "something-new", level: "info" }),
      ],
    });
    expect(digest.text).toContain("OneDrive · msp@contoso.example");
    expect(digest.text).toContain("Postfach · msp@contoso.example");
    expect(digest.html).toContain("Postfach · msp@contoso.example");
    expect(digest.text).not.toContain("something-new");
  });

  it("carries the brand", () => {
    const digest = renderDigest({
      language: "en",
      audience: "tenant",
      tenantName: "Contoso",
      window: "daily",
      windowStart: null,
      windowEnd: "2026-09-30T07:00:00.000Z",
      items: [item({})],
      brand,
    });
    expect(digest.html).toContain("cid:brand-logo.");
    expect(digest.html).toContain("MSP GmbH<br>");
  });
});

describe("the delivery failure alert", () => {
  it("names the channel, the address, the reason and since when", () => {
    const mail = renderAlert({
      language: "en",
      tenantName: "Contoso",
      ruleName: "Errors",
      payload: {
        event: "notification.delivery_failed",
        level: "error",
        occurredAt: "2026-09-30T10:00:00.000Z",
        details: {
          channel: "email",
          scope: "recipient",
          recipient: "gone@contoso.example",
          reason: "recipient_rejected",
          detail: "550 5.1.1 <gone@contoso.example>: user unknown",
          since: "2026-09-30T09:00:00.000Z",
          failedDeliveries: 3,
          objectName: "gone@contoso.example",
          deliveryFailure: true,
        },
      },
    });
    expect(mail.subject).toContain("Notification could not be delivered");
    expect(mail.text).toContain("Channel: E-mail");
    expect(mail.text).toContain("Recipient: gone@contoso.example");
    expect(mail.text).toContain("refused the recipient for good");
    expect(mail.text).toContain("Undelivered notifications: 3");
    expect(mail.html).toContain("&lt;gone@contoso.example&gt;");
  });

  it("explains a failing webhook with the webhook log's words", () => {
    const mail = renderAlert({
      language: "de",
      tenantName: "Contoso",
      ruleName: "Fehler",
      payload: {
        event: "notification.delivery_failed",
        details: {
          channel: "webhook",
          scope: "webhook",
          webhookName: "Teams Ops",
          reason: "http_error",
          httpStatus: 404,
          since: "2026-09-30T09:00:00.000Z",
          failedDeliveries: 4,
        },
      },
    });
    expect(mail.text).toContain("Kanal: Webhook");
    expect(mail.text).toContain("Teams Ops");
    expect(mail.text).toContain("404");
  });

  it("says when the whole mail transport is down", () => {
    const mail = renderAlert({
      language: "en",
      tenantName: "Installation",
      ruleName: "Provider",
      payload: {
        event: "notification.delivery_failed",
        details: { channel: "email", scope: "transport", reason: "smtp_auth_failed" },
      },
    });
    expect(mail.text).toContain("The notification mail as a whole");
    expect(mail.text).toContain("refused the sign-in");
  });
});
