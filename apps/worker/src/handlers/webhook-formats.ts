/**
 * Chat formats of webhooks (docs/ARCHITECTURE.md, "API"): what a delivery to a
 * webhook in the `discord`, `slack` or `teams` format carries instead of the
 * signed `restow` envelope.
 *
 * The envelope stays what is stored in `webhook_deliveries.payload` (the log
 * shows it, a redelivery sends it again); the chat body is rendered from it at
 * delivery time, in two steps:
 *
 * 1. {@link buildChatMessage} turns an envelope into a neutral message (title,
 *    text, fields, severity, link) in the tenant's language, with the same
 *    texts the alert mails use (job and cause titles, the steps to take).
 * 2. {@link renderDiscord}, {@link renderSlack} and {@link renderTeams} shape
 *    it for the service: each escapes what came from data (object names,
 *    error messages) for its markup and cuts every part to the service's
 *    limits, so a long error never turns into a 400 answer.
 *
 * Nothing here talks to the network or the database.
 */
import { guidanceFor } from "@restow/core";
import { type SupportedLanguage, createI18n, failureVariables } from "@restow/i18n";

/** Mirrors the `webhook_format` enum and the API's list. */
export const WEBHOOK_FORMATS = ["restow", "discord", "slack", "teams"] as const;

export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export type ChatFormat = Exclude<WebhookFormat, "restow">;

export function isChatFormat(format: string): format is ChatFormat {
  return format === "discord" || format === "slack" || format === "teams";
}

export type ChatSeverity = "success" | "info" | "warning" | "error";

export interface ChatField {
  name: string;
  value: string;
}

/** A message before it is shaped for one service. Every text is plain (not yet escaped). */
export interface ChatMessage {
  severity: ChatSeverity;
  title: string;
  text: string | null;
  fields: ChatField[];
  /** When the event happened (ISO 8601). */
  timestamp: string | null;
  link: { label: string; url: string } | null;
  footer: string;
}

/** What rendering needs besides the envelope; loaded by the dispatcher. */
export interface ChatContext {
  language: SupportedLanguage;
  tenantName: string;
  /** Origin of the web interface (Settings or RESTOW_PUBLIC_URL); null leaves out links. */
  publicUrl: string | null;
  /** Display name of the protected object a job event names, when there is one. */
  objectName: string | null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const ELLIPSIS = "…";

/**
 * At most `max` UTF-16 code units (what the services count, or stricter),
 * cut on a code point boundary and marked with an ellipsis.
 */
export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  if (max <= 0) {
    return "";
  }
  let cut = value.slice(0, max - ELLIPSIS.length);
  // Do not leave half a surrogate pair behind.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}${ELLIPSIS}`;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `42 s`, `12 min`, `2 h 5 min`: the same in both languages. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

/**
 * A path that names its tenant (`?forTenant=`, which the web app honours with an access check):
 * the link opens the tenant the message is about, not the one the reader's browser chose last.
 * Paths below `/tenants/<id>` name it already.
 */
export function tenantAddressed(path: string, tenantId: string | null): string {
  if (!tenantId || path.startsWith("/tenants/")) {
    return path;
  }
  return `${path}${path.includes("?") ? "&" : "?"}forTenant=${encodeURIComponent(tenantId)}`;
}

/** `<origin><path>`, or null without a usable public URL. */
export function linkTo(publicUrl: string | null, path: string): string | null {
  if (!publicUrl) {
    return null;
  }
  try {
    const origin = new URL(publicUrl);
    if (origin.protocol !== "https:" && origin.protocol !== "http:") {
      return null;
    }
    return new URL(path, origin.origin).toString();
  } catch {
    return null;
  }
}

const seg = (value: string) => encodeURIComponent(value);

// ---------------------------------------------------------------------------
// Envelope -> message
// ---------------------------------------------------------------------------

type Translate = (key: string, values?: Record<string, unknown>) => string;

interface Envelope {
  event: string;
  tenantId: string;
  createdAt: string | null;
  data: Record<string, unknown>;
}

function readEnvelope(event: string, payload: Record<string, unknown>): Envelope {
  return {
    event: str(payload.event) ?? event,
    tenantId: str(payload.tenantId) ?? "",
    createdAt: str(payload.createdAt),
    data: record(payload.data),
  };
}

/** The label of a job queue (`backup`, `endpoint_backup`, ...); unknown ones read "Job". */
function jobLabel(t: Translate, exists: (key: string) => boolean, queue: string | null): string {
  const key = `notifications:chat.jobs.${queue ?? ""}`;
  return queue && exists(key) ? t(key) : t("notifications:chat.jobs.other");
}

/** Cause title and up to three steps of a failure, in the recipient's language. */
function failureFields(
  t: Translate,
  exists: (key: string) => boolean,
  value: unknown,
): ChatField[] {
  const failure = record(value);
  const code = str(failure.code);
  if (!code) {
    return [];
  }
  const params = record(failure.params) as Record<string, string | number | boolean | null>;
  const variables = failureVariables(params as never);
  const known = exists(`failures:cause.${code}.title`);
  const fields: ChatField[] = [
    {
      name: t("notifications:chat.fields.cause"),
      value: t(`failures:cause.${known ? code : "unknown"}.title`, variables),
    },
  ];
  // The webhook carries the cause without its steps; they follow from code and parameters.
  let steps: string[] = Array.isArray(failure.steps)
    ? failure.steps.filter((id): id is string => typeof id === "string")
    : [];
  if (steps.length === 0) {
    try {
      steps = guidanceFor({
        code: code as never,
        params: params as never,
        transient: failure.transient === true,
      }).steps.map((step) => step.id);
    } catch {
      steps = [];
    }
  }
  const texts = steps
    .filter((id) => exists(`failures:steps.${id}`))
    .slice(0, 3)
    .map((id) => t(`failures:steps.${id}`, variables));
  if (texts.length > 0) {
    fields.push({ name: t("notifications:chat.fields.todo"), value: texts.join(" ") });
  }
  return fields;
}

const SUCCESS_EVENTS: ReadonlySet<string> = new Set([
  "restore.completed",
  "verify.recovered",
  "scrub.repaired",
]);

function severityOfLevel(level: unknown, event: string): ChatSeverity {
  if (level === "error") return "error";
  if (level === "warning") return "warning";
  return SUCCESS_EVENTS.has(event) ? "success" : "info";
}

/** The mail body without its heading and its footer, which the chat message has of its own. */
function reportBody(text: string | null, subject: string | null): string | null {
  if (!text) {
    return null;
  }
  let lines = text.split("\n");
  const footer = lines.lastIndexOf("--");
  if (footer >= 0) {
    lines = lines.slice(0, footer);
  }
  if (subject && lines[0] && subject.includes(lines[0].trim())) {
    lines = lines.slice(1);
  }
  const body = lines.join("\n").trim();
  return body.length > 0 ? body : null;
}

/** Turn a stored envelope into the message the chat formats show. */
export function buildChatMessage(
  event: string,
  payload: Record<string, unknown>,
  context: ChatContext,
): ChatMessage {
  const i18n = createI18n({ lng: context.language });
  const t: Translate = (key, values) => String(i18n.t(key, values));
  const exists = (key: string) => i18n.exists(key);
  const envelope = readEnvelope(event, payload);
  const { data } = envelope;
  const tenant = context.tenantName;
  const base = {
    timestamp: envelope.createdAt,
    footer: t("notifications:chat.footer", { tenant }),
  };
  const tenantField: ChatField = { name: t("notifications:chat.fields.tenant"), value: tenant };
  const link = (path: string | null): ChatMessage["link"] => {
    const url = path ? linkTo(context.publicUrl, tenantAddressed(path, envelope.tenantId)) : null;
    return url ? { label: t("notifications:chat.open"), url } : null;
  };

  switch (envelope.event) {
    case "job.failed":
    case "job.completed": {
      const job = record(data.job);
      const endpoint = record(data.endpoint);
      // A file share run names its share (docs/FILESHARES.md 14).
      const fileShare = record(data.fileShare);
      const failed = envelope.event === "job.failed";
      const target =
        str(endpoint.displayName) ??
        str(endpoint.hostname) ??
        str(fileShare.name) ??
        context.objectName ??
        tenant;
      const label = jobLabel(t, exists, str(job.queue));
      const fields: ChatField[] = [
        tenantField,
        { name: t("notifications:chat.fields.target"), value: target },
      ];
      const duration = num(job.durationMs);
      if (duration !== null) {
        fields.push({
          name: t("notifications:chat.fields.duration"),
          value: formatDuration(duration),
        });
      }
      if (failed) {
        fields.push(...failureFields(t, exists, job.failure));
      }
      const error = failed ? str(job.errorMessage) : null;
      const jobId = str(job.id);
      return {
        ...base,
        severity: failed ? "error" : "success",
        title: t(failed ? "notifications:chat.job.failed" : "notifications:chat.job.completed", {
          job: label,
          target,
        }),
        text: error,
        fields,
        timestamp: str(job.completedAt) ?? base.timestamp,
        link: link(
          str(fileShare.id)
            ? `/file-shares/${seg(str(fileShare.id) as string)}`
            : jobId
              ? `/history/${seg(jobId)}`
              : null,
        ),
      };
    }

    case "verify.completed": {
      const readiness =
        data.readiness === "green" || data.readiness === "yellow" ? data.readiness : "red";
      const target = str(data.objectName) ?? context.objectName ?? tenant;
      const reasons = Array.isArray(data.reasons)
        ? data.reasons.filter((reason): reason is string => typeof reason === "string")
        : [];
      const fields: ChatField[] = [
        tenantField,
        { name: t("notifications:chat.fields.target"), value: target },
      ];
      const snapshot = str(data.snapshotId);
      if (snapshot) {
        fields.push({ name: t("notifications:chat.fields.snapshot"), value: snapshot });
      }
      if (reasons.length > 0) {
        fields.push({
          name: t("notifications:chat.fields.reasons"),
          value: reasons.slice(0, 5).join("; "),
        });
      }
      const reportId = str(data.reportId);
      return {
        ...base,
        severity: readiness === "green" ? "success" : readiness === "yellow" ? "warning" : "error",
        title: t(`notifications:chat.verify.${readiness}`, { target }),
        text: t("notifications:chat.verify.summary", {
          checked: num(data.checked) ?? 0,
          mismatched: num(data.mismatched) ?? 0,
          missing: num(data.missing) ?? 0,
        }),
        fields,
        timestamp: str(data.completedAt) ?? base.timestamp,
        link: link(reportId ? `/verify/reports/${seg(reportId)}` : "/verify"),
      };
    }

    case "webhook.test": {
      const webhookId = str(data.webhookId);
      return {
        ...base,
        severity: "info",
        title: t("notifications:chat.test.title"),
        text: t("notifications:chat.test.body"),
        fields: [tenantField],
        link: link(
          webhookId && envelope.tenantId
            ? `/tenants/${seg(envelope.tenantId)}/integrations/webhooks/${seg(webhookId)}`
            : null,
        ),
      };
    }

    case "report.alert":
    case "report.summary": {
      // Rendered by the API's report dispatcher in the rule's language: subject and mail text.
      const subject = str(data.subject);
      const rule = record(data.rule);
      const details = record(data.details);
      const ruleName = str(rule.name);
      const jobId = str(details.jobId);
      const endpointId = str(details.endpointId);
      const guestId = str(details.pveGuestId);
      const shareId = str(details.fileShareId);
      const reportEvent = str(data.event) ?? "";
      return {
        ...base,
        severity:
          envelope.event === "report.summary" ? "info" : severityOfLevel(data.level, reportEvent),
        title: subject ?? t("notifications:chat.unknown", { event: envelope.event }),
        text: reportBody(str(data.text), subject),
        fields: ruleName ? [{ name: t("notifications:chat.fields.rule"), value: ruleName }] : [],
        timestamp: str(data.occurredAt) ?? base.timestamp,
        link: link(
          jobId
            ? `/history/${seg(jobId)}`
            : endpointId
              ? `/inventory/${seg(endpointId)}`
              : guestId
                ? `/virtualization/${seg(guestId)}`
                : shareId
                  ? `/file-shares/${seg(shareId)}`
                  : "/alerts",
        ),
      };
    }

    default:
      return {
        ...base,
        severity: "info",
        title: t("notifications:chat.unknown", { event: envelope.event }),
        text: null,
        fields: [tenantField],
        link: link("/"),
      };
  }
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

/** Discord's documented limits (https://discord.com/developers/docs/resources/message#embed-object-embed-limits). */
export const DISCORD_LIMITS = {
  content: 2000,
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  /** Sum of every text of the embed. */
  embedTotal: 6000,
} as const;

export const DISCORD_COLORS: Record<ChatSeverity, number> = {
  success: 0x2e7d32,
  info: 0x1e88e5,
  warning: 0xf9a825,
  error: 0xd32f2f,
};

/**
 * Backslash before the Markdown characters Discord interprets (emphasis,
 * code, spoilers, links, mentions and timestamps in angle brackets; headings,
 * lists and quotes at the start of a line), so data reads as typed.
 */
export function escapeDiscord(value: string): string {
  return value.replace(/([\\*_~`|[\]<])/g, "\\$1").replace(/^(\s*)([#>\-+])/gm, "$1\\$2");
}

export function renderDiscord(message: ChatMessage): Record<string, unknown> {
  const title = truncate(escapeDiscord(message.title), DISCORD_LIMITS.title);
  const footer = truncate(message.footer, DISCORD_LIMITS.footer);
  // Every text of the embed counts towards 6000 characters: fields take what they need in
  // order, as long as some room for the description is left, which gets the rest.
  const reserve = message.text || message.link ? 500 : 0;
  let budget = DISCORD_LIMITS.embedTotal - title.length - footer.length;
  const fields: { name: string; value: string; inline: boolean }[] = [];
  for (const field of message.fields.slice(0, DISCORD_LIMITS.fields)) {
    const name = truncate(field.name, DISCORD_LIMITS.fieldName);
    const value = truncate(escapeDiscord(field.value), DISCORD_LIMITS.fieldValue);
    if (name.length === 0 || value.length === 0) {
      continue;
    }
    if (name.length + value.length > budget - reserve) {
      break;
    }
    budget -= name.length + value.length;
    fields.push({ name, value, inline: value.length <= 40 });
  }
  const room = Math.max(0, Math.min(DISCORD_LIMITS.description, budget));
  const linkLine = message.link
    ? `[${escapeDiscord(message.link.label)}](${message.link.url})`
    : null;
  const suffix = linkLine ? `\n\n${linkLine}` : "";
  const text = message.text ? escapeDiscord(message.text) : "";
  let description = "";
  if (text.length > 0 && room > suffix.length) {
    description = `${truncate(text, room - suffix.length)}${suffix}`;
  } else if (linkLine && linkLine.length <= room) {
    description = linkLine;
  }
  const embed: Record<string, unknown> = {
    title,
    color: DISCORD_COLORS[message.severity],
    fields,
    footer: { text: footer },
  };
  if (description.length > 0) {
    embed.description = description;
  }
  if (message.link) {
    embed.url = message.link.url;
  }
  if (message.timestamp && !Number.isNaN(Date.parse(message.timestamp))) {
    embed.timestamp = new Date(message.timestamp).toISOString();
  }
  return {
    content: truncate(escapeDiscord(message.title), DISCORD_LIMITS.content),
    embeds: [embed],
    // Names from data never ping anyone (@everyone, roles, users).
    allowed_mentions: { parse: [] },
  };
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

/** Slack Block Kit limits (https://api.slack.com/reference/block-kit/blocks). */
export const SLACK_LIMITS = {
  /** Fallback `text` of the message (Slack truncates beyond 40,000; notifications show the start). */
  text: 3000,
  header: 150,
  sectionText: 3000,
  sectionFields: 10,
  fieldText: 2000,
  contextText: 2000,
  blocks: 50,
} as const;

export const SLACK_EMOJI: Record<ChatSeverity, string> = {
  success: ":white_check_mark:",
  info: ":information_source:",
  warning: ":warning:",
  error: ":x:",
};

/** The three characters Slack's mrkdwn requires escaped; `<!channel>` and links cannot be smuggled in. */
export function escapeSlack(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A link in Slack's `<url|label>` syntax; the label may not contain `|` or `>`. */
function slackLink(url: string, label: string): string {
  return `<${url.replace(/[<>|]/g, encodeURIComponent)}|${escapeSlack(label).replace(/\|/g, "¦")}>`;
}

export function renderSlack(message: ChatMessage): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: truncate(`${SLACK_EMOJI[message.severity]} ${message.title}`, SLACK_LIMITS.header),
        emoji: true,
      },
    },
  ];
  if (message.text) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(escapeSlack(message.text), SLACK_LIMITS.sectionText) },
    });
  }
  const fields = message.fields.map((field) => ({
    type: "mrkdwn",
    text: truncate(
      `*${escapeSlack(field.name)}*\n${escapeSlack(field.value)}`,
      SLACK_LIMITS.fieldText,
    ),
  }));
  for (let index = 0; index < fields.length; index += SLACK_LIMITS.sectionFields) {
    blocks.push({
      type: "section",
      fields: fields.slice(index, index + SLACK_LIMITS.sectionFields),
    });
  }
  const context: string[] = [];
  if (message.link) {
    context.push(slackLink(message.link.url, message.link.label));
  }
  const at = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
  if (!Number.isNaN(at)) {
    // Shown in the reader's time zone; the fallback is UTC.
    const fallback = new Date(at).toISOString().replace("T", " ").slice(0, 16);
    context.push(`<!date^${Math.floor(at / 1000)}^{date_short_pretty} {time}|${fallback} UTC>`);
  }
  context.push(escapeSlack(message.footer));
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: truncate(context.join(" · "), SLACK_LIMITS.contextText) }],
  });
  const fallback = [message.title, message.text].filter(Boolean).join("\n");
  return {
    text: truncate(escapeSlack(fallback), SLACK_LIMITS.text),
    blocks: blocks.slice(0, SLACK_LIMITS.blocks),
  };
}

// ---------------------------------------------------------------------------
// Microsoft Teams (Adaptive Card via Workflows / Power Automate)
// ---------------------------------------------------------------------------

export const TEAMS_LIMITS = {
  title: 256,
  text: 4000,
  facts: 20,
  factTitle: 100,
  factValue: 1024,
  footer: 512,
} as const;

/** Container style and text colour of each severity. */
export const TEAMS_STYLES: Record<ChatSeverity, { style: string; color: string }> = {
  success: { style: "good", color: "Good" },
  info: { style: "accent", color: "Accent" },
  warning: { style: "warning", color: "Warning" },
  error: { style: "attention", color: "Attention" },
};

/**
 * TextBlocks render a subset of Markdown (bold, italic, links, lists): escape
 * its emphasis and link characters so data reads as typed.
 */
export function escapeTeams(value: string): string {
  return value.replace(/([\\*_`[\]])/g, "\\$1");
}

export function renderTeams(message: ChatMessage): Record<string, unknown> {
  const severity = TEAMS_STYLES[message.severity];
  const body: Record<string, unknown>[] = [
    {
      type: "Container",
      style: severity.style,
      bleed: true,
      items: [
        {
          type: "TextBlock",
          text: truncate(escapeTeams(message.title), TEAMS_LIMITS.title),
          weight: "Bolder",
          size: "Medium",
          color: severity.color,
          wrap: true,
        },
      ],
    },
  ];
  if (message.text) {
    body.push({
      type: "TextBlock",
      text: truncate(escapeTeams(message.text), TEAMS_LIMITS.text),
      wrap: true,
    });
  }
  if (message.fields.length > 0) {
    body.push({
      type: "FactSet",
      facts: message.fields.slice(0, TEAMS_LIMITS.facts).map((field) => ({
        title: truncate(escapeTeams(field.name), TEAMS_LIMITS.factTitle),
        value: truncate(escapeTeams(field.value), TEAMS_LIMITS.factValue),
      })),
    });
  }
  const at = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
  const footer = Number.isNaN(at)
    ? escapeTeams(message.footer)
    : // Adaptive Card date functions show the reader's local time.
      `${escapeTeams(message.footer)} · {{DATE(${new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z")}, SHORT)}} {{TIME(${new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z")})}}`;
  body.push({
    type: "TextBlock",
    text: truncate(footer, TEAMS_LIMITS.footer),
    isSubtle: true,
    size: "Small",
    wrap: true,
  });
  const card: Record<string, unknown> = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    msteams: { width: "Full" },
    body,
  };
  if (message.link) {
    card.actions = [
      {
        type: "Action.OpenUrl",
        title: truncate(message.link.label, 100),
        url: message.link.url,
      },
    ];
  }
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: card,
      },
    ],
  };
}

/** The JSON body of a chat delivery. */
export function renderChatBody(format: ChatFormat, message: ChatMessage): string {
  switch (format) {
    case "discord":
      return JSON.stringify(renderDiscord(message));
    case "slack":
      return JSON.stringify(renderSlack(message));
    case "teams":
      return JSON.stringify(renderTeams(message));
  }
}
