/**
 * Chat formats: the message built from each event, in both languages, and
 * its Discord, Slack and Teams shapes (limits, severity colours, escaping).
 */
import { describe, expect, it } from "vitest";
import {
  type ChatContext,
  type ChatMessage,
  DISCORD_COLORS,
  DISCORD_LIMITS,
  SLACK_EMOJI,
  SLACK_LIMITS,
  TEAMS_STYLES,
  WEBHOOK_FORMATS,
  buildChatMessage,
  escapeDiscord,
  escapeSlack,
  escapeTeams,
  formatDuration,
  isChatFormat,
  linkTo,
  renderChatBody,
  renderDiscord,
  renderSlack,
  renderTeams,
  tenantAddressed,
  truncate,
} from "./webhook-formats.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const AT = "2026-09-23T12:00:00.000Z";

const EN: ChatContext = {
  language: "en",
  tenantName: "Contoso",
  publicUrl: "https://backup.example.com",
  objectName: "anna@contoso.example",
};
const DE: ChatContext = { ...EN, language: "de" };

function envelope(event: string, data: Record<string, unknown>): Record<string, unknown> {
  return { id: "evt-1", event, version: 1, createdAt: AT, tenantId: TENANT, data };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    severity: "error",
    title: "Backup failed: anna@contoso.example",
    text: "quota exceeded",
    fields: [
      { name: "Tenant", value: "Contoso" },
      { name: "Concerns", value: "anna@contoso.example" },
    ],
    timestamp: AT,
    link: { label: "Open in Restow", url: "https://backup.example.com/history/j-1" },
    footer: "Restow · Contoso",
    ...overrides,
  };
}

describe("formats", () => {
  it("are restow plus three chat services", () => {
    expect([...WEBHOOK_FORMATS]).toEqual(["restow", "discord", "slack", "teams"]);
    expect(WEBHOOK_FORMATS.filter(isChatFormat)).toEqual(["discord", "slack", "teams"]);
  });
});

describe("text helpers", () => {
  it("truncate to the limit with an ellipsis, never splitting a surrogate pair", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
    expect(truncate("x".repeat(20), 10)).toHaveLength(10);
    const emoji = `${"a".repeat(8)}😀😀`;
    const cut = truncate(emoji, 10);
    expect(cut.length).toBeLessThanOrEqual(10);
    expect(cut).toBe(`${"a".repeat(8)}…`);
    expect(truncate("abc", 0)).toBe("");
  });

  it("format durations", () => {
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(12 * 60_000)).toBe("12 min");
    expect(formatDuration(125 * 60_000)).toBe("2 h 5 min");
    expect(formatDuration(120 * 60_000)).toBe("2 h");
  });

  it("build links only from an http(s) public URL, by origin", () => {
    expect(linkTo("https://backup.example.com/some/path", "/history/j-1")).toBe(
      "https://backup.example.com/history/j-1",
    );
    expect(linkTo(null, "/history/j-1")).toBeNull();
    // The link names its tenant, so it opens that tenant in the web app (`?forTenant=`).
    expect(tenantAddressed("/history/j-1", "t-1")).toBe("/history/j-1?forTenant=t-1");
    expect(tenantAddressed("/verify?state=red", "t-1")).toBe("/verify?state=red&forTenant=t-1");
    expect(tenantAddressed("/tenants/t-1/integrations", "t-1")).toBe("/tenants/t-1/integrations");
    expect(tenantAddressed("/history/j-1", null)).toBe("/history/j-1");
    expect(linkTo("javascript:alert(1)", "/x")).toBeNull();
    expect(linkTo("not a url", "/x")).toBeNull();
  });
});

describe("buildChatMessage", () => {
  it("describes a failed job with cause, steps, error and a link to the run", () => {
    const msg = buildChatMessage(
      "job.failed",
      envelope("job.failed", {
        job: {
          id: "j-1",
          queue: "backup",
          status: "failed",
          protectedObjectId: null,
          completedAt: "2026-09-23T11:59:00.000Z",
          durationMs: 125_000,
          errorMessage: "Consent missing",
          failure: { code: "graph.consent_missing", transient: false, params: {} },
        },
      }),
      EN,
    );
    expect(msg).toMatchObject({
      severity: "error",
      title: "Backup failed: anna@contoso.example",
      text: "Consent missing",
      timestamp: "2026-09-23T11:59:00.000Z",
      link: {
        label: "Open in Restow",
        url: "https://backup.example.com/history/j-1?forTenant=11111111-1111-4111-8111-111111111111",
      },
      footer: "Restow · Contoso",
    });
    const names = msg.fields.map((field) => field.name);
    expect(names).toEqual(["Tenant", "Concerns", "Duration", "Cause", "What to do"]);
    expect(msg.fields.find((field) => field.name === "Duration")?.value).toBe("2 min");
    // The steps follow from the cause code, as in the alert mails.
    expect(msg.fields.find((field) => field.name === "What to do")?.value).toContain("consent");
  });

  it("names the machine of an endpoint run, in German with the formal terms", () => {
    const msg = buildChatMessage(
      "job.failed",
      envelope("job.failed", {
        job: { id: "r-1", queue: "endpoint_backup", status: "failed", errorMessage: null },
        endpoint: { id: "e-1", hostname: "srv-01", displayName: "Fileserver", profile: "server" },
      }),
      DE,
    );
    expect(msg.title).toBe("Sicherung eines Rechners fehlgeschlagen: Fileserver");
    expect(msg.fields[0]).toEqual({ name: "Mandant", value: "Contoso" });
    expect(msg.link?.label).toBe("In Restow öffnen");
    expect(msg.text).toBeNull();
  });

  it("names the file share of a share run and links its page", () => {
    const msg = buildChatMessage(
      "job.failed",
      envelope("job.failed", {
        job: { id: "r-9", queue: "file-share-backup", status: "failed", errorMessage: null },
        fileShare: { id: "s-1", name: "Finance", protocol: "smb" },
        failure: null,
      }),
      DE,
    );
    expect(msg.title).toBe("Sicherung der Freigabe fehlgeschlagen: Finance");
    expect(msg.link?.url).toContain("/file-shares/s-1");
  });

  it("reports a completed run as success and an unknown queue as a run", () => {
    const msg = buildChatMessage(
      "job.completed",
      envelope("job.completed", {
        job: { id: "j-2", queue: "something_new", status: "completed" },
      }),
      { ...EN, objectName: null },
    );
    expect(msg.severity).toBe("success");
    expect(msg.title).toBe("Run completed: Contoso");
  });

  it("colours a restore check by its rating and links its report", () => {
    const base = {
      reportId: "rep-1",
      snapshotId: "snap-1",
      checked: 1,
      mismatched: 0,
      missing: 0,
      objectName: "Fileserver",
      reasons: [],
      completedAt: AT,
    };
    const green = buildChatMessage(
      "verify.completed",
      envelope("verify.completed", { ...base, readiness: "green" }),
      EN,
    );
    expect(green).toMatchObject({
      severity: "success",
      title: "Restore check passed: Fileserver",
      text: "1 item checked, 0 with differences, 0 missing.",
      link: {
        url: "https://backup.example.com/verify/reports/rep-1?forTenant=11111111-1111-4111-8111-111111111111",
      },
    });
    expect(
      buildChatMessage(
        "verify.completed",
        envelope("verify.completed", { ...base, readiness: "yellow" }),
        EN,
      ).severity,
    ).toBe("warning");
    const red = buildChatMessage(
      "verify.completed",
      envelope("verify.completed", { ...base, readiness: "red", reasons: ["mismatch"] }),
      DE,
    );
    expect(red.severity).toBe("error");
    expect(red.title).toBe("Restore-Prüfung nicht bestanden: Fileserver");
    expect(red.fields).toContainEqual({ name: "Sicherungsstand", value: "snap-1" });
    expect(red.fields).toContainEqual({ name: "Gründe", value: "mismatch" });
  });

  it("builds the test message with a link to the webhook", () => {
    const msg = buildChatMessage(
      "webhook.test",
      envelope("webhook.test", { webhookId: "w-1", webhookName: "Ops", test: true }),
      EN,
    );
    expect(msg).toMatchObject({
      severity: "info",
      title: "Test message from Restow",
      link: { url: `https://backup.example.com/tenants/${TENANT}/integrations/webhooks/w-1` },
    });
    expect(msg.text).toContain("Restow can post to this channel");
  });

  it("uses the rendered alert of a rule without repeating its heading and footer", () => {
    const msg = buildChatMessage(
      "report.alert",
      envelope("report.alert", {
        rule: { id: "r-1", name: "Failed backups" },
        subject: "[Contoso] Backup failed: anna",
        text: "Backup failed: anna\n\nBackup failed: anna (Contoso).\n\nTenant: Contoso\n\n--\nYou receive this message because of the rule.",
        event: "backup.failed",
        level: "error",
        details: { jobId: "j-9" },
        occurredAt: AT,
      }),
      EN,
    );
    expect(msg).toMatchObject({
      severity: "error",
      title: "[Contoso] Backup failed: anna",
      text: "Backup failed: anna (Contoso).\n\nTenant: Contoso",
      fields: [{ name: "Rule", value: "Failed backups" }],
      link: {
        url: "https://backup.example.com/history/j-9?forTenant=11111111-1111-4111-8111-111111111111",
      },
    });
    const recovered = buildChatMessage(
      "report.alert",
      envelope("report.alert", { subject: "x", event: "verify.recovered", level: "info" }),
      EN,
    );
    expect(recovered.severity).toBe("success");
    expect(recovered.link?.url).toBe(
      "https://backup.example.com/alerts?forTenant=11111111-1111-4111-8111-111111111111",
    );
  });

  it("leaves the link out without a public URL and survives unknown events", () => {
    const msg = buildChatMessage("job.started", envelope("job.started", {}), {
      ...EN,
      publicUrl: null,
    });
    expect(msg).toMatchObject({ severity: "info", title: "Restow event: job.started", link: null });
  });
});

describe("renderDiscord", () => {
  it("sends content and one embed with the severity colour, fields, timestamp and link", () => {
    const body = renderDiscord(message());
    expect(body.content).toBe("Backup failed: anna@contoso.example");
    expect(body.allowed_mentions).toEqual({ parse: [] });
    const [embed] = body.embeds as Record<string, unknown>[];
    expect(embed).toMatchObject({
      title: "Backup failed: anna@contoso.example",
      color: DISCORD_COLORS.error,
      url: "https://backup.example.com/history/j-1",
      timestamp: AT,
      footer: { text: "Restow · Contoso" },
    });
    expect(embed?.description).toBe(
      "quota exceeded\n\n[Open in Restow](https://backup.example.com/history/j-1)",
    );
    expect(embed?.fields).toEqual([
      { name: "Tenant", value: "Contoso", inline: true },
      { name: "Concerns", value: "anna@contoso.example", inline: true },
    ]);
  });

  it("has a distinct colour per severity", () => {
    const colours = (["success", "info", "warning", "error"] as const).map(
      (severity) =>
        (renderDiscord(message({ severity })).embeds as Record<string, unknown>[])[0]?.color,
    );
    expect(new Set(colours).size).toBe(4);
    expect(colours).toEqual([
      DISCORD_COLORS.success,
      DISCORD_COLORS.info,
      DISCORD_COLORS.warning,
      DISCORD_COLORS.error,
    ]);
  });

  it("keeps every part within Discord's limits", () => {
    const long = "y".repeat(10_000);
    const body = renderDiscord(
      message({
        title: long,
        text: long,
        fields: Array.from({ length: 40 }, (_, index) => ({
          name: long,
          value: `${index}${long}`,
        })),
        footer: long,
      }),
    );
    expect((body.content as string).length).toBeLessThanOrEqual(DISCORD_LIMITS.content);
    const embed = (body.embeds as Record<string, unknown>[])[0] as {
      title: string;
      description?: string;
      fields: { name: string; value: string }[];
      footer: { text: string };
    };
    expect(embed.title.length).toBe(DISCORD_LIMITS.title);
    // Fields stop where the 6000-character budget would be exceeded.
    expect(embed.fields.length).toBeGreaterThan(0);
    expect(embed.fields.length).toBeLessThan(DISCORD_LIMITS.fields);
    for (const field of embed.fields) {
      expect(field.name.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldName);
      expect(field.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldValue);
    }
    expect(embed.footer.text.length).toBeLessThanOrEqual(DISCORD_LIMITS.footer);
    expect((embed.description ?? "").length).toBeLessThanOrEqual(DISCORD_LIMITS.description);
    const total =
      embed.title.length +
      (embed.description ?? "").length +
      embed.footer.text.length +
      embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
    expect(total).toBeLessThanOrEqual(DISCORD_LIMITS.embedTotal);
  });

  it("sends at most 25 fields", () => {
    const body = renderDiscord(
      message({
        fields: Array.from({ length: 40 }, (_, index) => ({ name: `F${index}`, value: "v" })),
      }),
    );
    expect((body.embeds as { fields: unknown[] }[])[0]?.fields).toHaveLength(DISCORD_LIMITS.fields);
  });

  it("cuts a long description and keeps the link line", () => {
    const body = renderDiscord(message({ text: "z".repeat(5000), fields: [] }));
    const embed = (body.embeds as { description: string }[])[0];
    expect(embed?.description.length).toBeLessThanOrEqual(DISCORD_LIMITS.description);
    expect(embed?.description.endsWith("(https://backup.example.com/history/j-1)")).toBe(true);
    expect(embed?.description).toContain("…");
  });

  it("escapes Markdown and mentions from data", () => {
    expect(escapeDiscord("**bold** _x_ `code` ||spoiler|| ~~s~~ [a](b) <@123> @everyone")).toBe(
      "\\*\\*bold\\*\\* \\_x\\_ \\`code\\` \\|\\|spoiler\\|\\| \\~\\~s\\~\\~ \\[a\\](b) \\<@123> @everyone",
    );
    // Headings, quotes and lists only matter at the start of a line.
    expect(escapeDiscord("# big\n> quote\n- item\na-b #1 > 2")).toBe(
      "\\# big\n\\> quote\n\\- item\na-b #1 > 2",
    );
    // Plain text stays readable.
    expect(escapeDiscord("connect ECONNREFUSED 10.0.0.1:443 (retry)")).toBe(
      "connect ECONNREFUSED 10.0.0.1:443 (retry)",
    );
    const body = renderDiscord(message({ text: "[click](https://evil.example)" }));
    const embed = (body.embeds as { description: string }[])[0];
    expect(embed?.description).toContain("\\[click\\](https://evil.example)");
    // The mention stays text: allowed_mentions parses none.
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });
});

describe("renderSlack", () => {
  it("sends a text fallback and header, section and context blocks", () => {
    const body = renderSlack(message());
    expect(body.text).toBe("Backup failed: anna@contoso.example\nquota exceeded");
    const blocks = body.blocks as Record<string, unknown>[];
    expect(blocks.map((block) => block.type)).toEqual(["header", "section", "section", "context"]);
    expect(blocks[0]).toEqual({
      type: "header",
      text: {
        type: "plain_text",
        text: `${SLACK_EMOJI.error} Backup failed: anna@contoso.example`,
        emoji: true,
      },
    });
    expect(blocks[2]).toEqual({
      type: "section",
      fields: [
        { type: "mrkdwn", text: "*Tenant*\nContoso" },
        { type: "mrkdwn", text: "*Concerns*\nanna@contoso.example" },
      ],
    });
    const context = (blocks[3]?.elements as { text: string }[])[0]?.text ?? "";
    expect(context).toContain("<https://backup.example.com/history/j-1|Open in Restow>");
    expect(context).toContain(`<!date^${Date.parse(AT) / 1000}^`);
    expect(context).toContain("Restow · Contoso");
  });

  it("marks each severity with its own emoji", () => {
    const headers = (["success", "info", "warning", "error"] as const).map(
      (severity) =>
        (
          (renderSlack(message({ severity })).blocks as { text?: { text: string } }[])[0]?.text
            ?.text ?? ""
        ).split(" ")[0],
    );
    expect(headers).toEqual([
      SLACK_EMOJI.success,
      SLACK_EMOJI.info,
      SLACK_EMOJI.warning,
      SLACK_EMOJI.error,
    ]);
  });

  it("escapes &, < and > so data cannot mention a channel or forge a link", () => {
    expect(escapeSlack("<!channel> & <https://evil|x>")).toBe(
      "&lt;!channel&gt; &amp; &lt;https://evil|x&gt;",
    );
    const body = renderSlack(message({ text: "<!here> hi" }));
    expect(JSON.stringify(body)).not.toContain("<!here>");
  });

  it("keeps blocks within Slack's limits", () => {
    const long = "w".repeat(10_000);
    const body = renderSlack(
      message({
        title: long,
        text: long,
        fields: Array.from({ length: 23 }, (_, index) => ({ name: `F${index}`, value: long })),
        footer: long,
      }),
    );
    expect((body.text as string).length).toBeLessThanOrEqual(SLACK_LIMITS.text);
    const blocks = body.blocks as Record<string, unknown>[];
    expect(blocks.length).toBeLessThanOrEqual(SLACK_LIMITS.blocks);
    expect((blocks[0]?.text as { text: string }).text.length).toBeLessThanOrEqual(
      SLACK_LIMITS.header,
    );
    expect((blocks[1]?.text as { text: string }).text.length).toBeLessThanOrEqual(
      SLACK_LIMITS.sectionText,
    );
    const sections = blocks.filter((block) => Array.isArray(block.fields));
    // 23 fields in sections of at most 10.
    expect(sections.map((section) => (section.fields as unknown[]).length)).toEqual([10, 10, 3]);
    for (const section of sections) {
      for (const field of section.fields as { text: string }[]) {
        expect(field.text.length).toBeLessThanOrEqual(SLACK_LIMITS.fieldText);
      }
    }
    const context = blocks.at(-1)?.elements as { text: string }[];
    expect(context[0]?.text.length).toBeLessThanOrEqual(SLACK_LIMITS.contextText);
  });
});

describe("renderTeams", () => {
  it("wraps an Adaptive Card in the message envelope Workflows accept", () => {
    const body = renderTeams(message());
    expect(body.type).toBe("message");
    const [attachment] = body.attachments as Record<string, unknown>[];
    expect(attachment?.contentType).toBe("application/vnd.microsoft.card.adaptive");
    const card = attachment?.content as Record<string, unknown>;
    expect(card).toMatchObject({ type: "AdaptiveCard", version: "1.4" });
    const [header, text, facts, footer] = card.body as Record<string, unknown>[];
    expect(header).toMatchObject({
      type: "Container",
      style: TEAMS_STYLES.error.style,
      items: [
        { type: "TextBlock", text: "Backup failed: anna@contoso.example", color: "Attention" },
      ],
    });
    expect(text).toMatchObject({ type: "TextBlock", text: "quota exceeded", wrap: true });
    expect(facts).toEqual({
      type: "FactSet",
      facts: [
        { title: "Tenant", value: "Contoso" },
        { title: "Concerns", value: "anna@contoso.example" },
      ],
    });
    expect(footer?.text).toBe(
      "Restow · Contoso · {{DATE(2026-09-23T12:00:00Z, SHORT)}} {{TIME(2026-09-23T12:00:00Z)}}",
    );
    expect(card.actions).toEqual([
      {
        type: "Action.OpenUrl",
        title: "Open in Restow",
        url: "https://backup.example.com/history/j-1",
      },
    ]);
  });

  it("styles each severity and leaves out what is missing", () => {
    for (const severity of ["success", "info", "warning", "error"] as const) {
      const card = ((
        renderTeams(message({ severity, link: null, text: null, fields: [] })).attachments as {
          content: Record<string, unknown>;
        }[]
      )[0]?.content ?? {}) as {
        body: Record<string, unknown>[];
        actions?: unknown;
      };
      expect(card.body[0]?.style).toBe(TEAMS_STYLES[severity].style);
      expect(card.body).toHaveLength(2);
      expect(card.actions).toBeUndefined();
    }
  });

  it("escapes Markdown from data", () => {
    expect(escapeTeams("**x** [a](b) _y_")).toBe("\\*\\*x\\*\\* \\[a\\](b) \\_y\\_");
  });
});

describe("renderChatBody", () => {
  it("renders valid JSON for every chat format", () => {
    for (const format of ["discord", "slack", "teams"] as const) {
      expect(() => JSON.parse(renderChatBody(format, message()))).not.toThrow();
    }
  });
});
