import { isReportEvent, type ReportEvent } from "@restow/core";
import { createI18n, failureVariables, type SupportedLanguage } from "@restow/i18n";

/**
 * Turning an outbox row into what a person reads: the subject, a plain-text
 * body and a small HTML body, in the rule's (or tenant's) language. Every
 * value that came from data (object names, error texts) is escaped for HTML;
 * nothing is fetched from outside and there are no images or tracking.
 */

export interface RenderedMessage {
  subject: string;
  text: string;
  html: string;
}

export interface AlertInput {
  readonly language: SupportedLanguage;
  readonly tenantName: string;
  readonly ruleName: string;
  readonly payload: Record<string, unknown>;
  /** A test send from the rule editor: marked as such in the subject and body. */
  readonly test?: boolean;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function formatWhen(iso: string | null, language: SupportedLanguage): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

/** Bytes as GiB with one decimal, in the reader's number format. */
function formatGib(bytes: number, language: SupportedLanguage): string {
  const value = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(bytes / 1024 ** 3);
  return `${value} GiB`;
}

/** A whole number in the reader's format. */
function formatCount(value: number, language: SupportedLanguage): string {
  return new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
    maximumFractionDigits: 0,
  }).format(value);
}

/** Bytes in the largest unit that keeps a number of at least 1, one decimal. */
function formatBytes(bytes: number, language: SupportedLanguage): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const number = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
  return `${number} ${units[unit]}`;
}

/**
 * The findings of a suspicious restore point (`backup.suspicious`, apps/worker suspicion), one
 * sentence each in the reader's language, the numbers formatted (bytes for the change in bytes).
 */
export function suspicionFindingLines(
  findings: unknown,
  language: SupportedLanguage,
  t: (key: string, values?: Record<string, unknown>) => string,
): string[] {
  if (!Array.isArray(findings)) {
    return [];
  }
  const lines: string[] = [];
  for (const entry of findings.slice(0, 7)) {
    if (entry === null || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const code = typeof raw.code === "string" ? raw.code : "";
    const number = (value: unknown) => (typeof value === "number" ? value : 0);
    const percent = (value: unknown) =>
      new Intl.NumberFormat(language === "de" ? "de-DE" : "en-GB", {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(number(value));
    // Compression and deduplication findings carry ratios (0 to about 1), shown as percent.
    const ratio = code === "incompressible_data" || code === "dedup_collapse";
    const amount = (value: unknown) =>
      code === "change_rate_bytes"
        ? formatBytes(number(value), language)
        : ratio
          ? percent(value)
          : formatCount(number(value), language);
    const examples = Array.isArray(raw.examples)
      ? raw.examples
          .filter((example): example is string => typeof example === "string")
          .slice(0, 3)
          .map((example) => example.slice(0, 120))
          .join(", ")
      : "";
    lines.push(
      t(code ? `suspicion:findings.${code}` : "suspicion:findings.unknown", {
        value: amount(raw.value),
        baseline: amount(raw.baseline),
        threshold: amount(raw.threshold),
        share: percent(raw.share),
        bytes: formatBytes(number(raw.bytes), language),
        examples,
      }),
    );
  }
  return lines;
}

/** A labelled line list as text and as an HTML table. */
function layout(
  heading: string,
  intro: string,
  rows: readonly [string, string][],
  footer: string,
): { text: string; html: string } {
  const textRows = rows.map(([label, value]) => `${label}: ${value}`).join("\n");
  const htmlRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top">${escapeHtml(label)}</td><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  return {
    text: [heading, "", intro, "", textRows, "", "--", footer].join("\n"),
    html: `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;color:#111;max-width:640px"><h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(heading)}</h2><p>${escapeHtml(intro)}</p><table style="border-collapse:collapse">${htmlRows}</table><p style="margin-top:24px;color:#666;font-size:12px">${escapeHtml(footer)}</p></body></html>`,
  };
}

interface AlertFailure {
  code: string;
  params: Record<string, string | number | boolean | null>;
  steps: string[];
}

/** The cause an alert carries (worker/src/reporting.ts), or null when there is none or it is unusable. */
function alertFailure(value: unknown): AlertFailure | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const raw = value as { code?: unknown; params?: unknown; steps?: unknown };
  if (typeof raw.code !== "string" || raw.code.length === 0) {
    return null;
  }
  const params =
    raw.params !== null && typeof raw.params === "object"
      ? (raw.params as AlertFailure["params"])
      : {};
  const steps = Array.isArray(raw.steps)
    ? raw.steps.filter((id): id is string => typeof id === "string")
    : [];
  return { code: raw.code, params, steps };
}

/** An alert for one event. Unknown events render with their raw name, never fail. */
export function renderAlert(input: AlertInput): RenderedMessage {
  const i18n = createI18n({ lng: input.language });
  const t = (key: string, values?: Record<string, unknown>) => String(i18n.t(key, values));
  const event = text(input.payload.event) ?? "";
  const details = (input.payload.details ?? {}) as Record<string, unknown>;
  // A red rating because the newest backup is too old is not a failed restore check.
  const eventLabel =
    event === "verify.red" && details.redReason === "outdated"
      ? t("reports:mail.verifyRedOutdated")
      : isReportEvent(event)
        ? t(`reports:events.${event as ReportEvent}`)
        : event;
  const target =
    text(details.objectName) ??
    (text(details.queue) ? t(`reports:queues.${details.queue as string}`) : input.tenantName);

  const rows: [string, string][] = [
    [t("reports:mail.tenant"), input.tenantName],
    [t("reports:mail.target"), target],
  ];
  const when = formatWhen(text(input.payload.occurredAt), input.language);
  if (when) rows.push([t("reports:mail.when"), `${when} UTC`]);
  if (event === "update.available") {
    // An installation event: it names the version, not a mailbox or a job.
    const version = text(details.version);
    const running = text(details.running);
    const url = text(details.url);
    if (version) rows.push([t("reports:mail.version"), version]);
    if (running) rows.push([t("reports:mail.running"), running]);
    if (url) rows.push([t("reports:mail.releaseNotes"), url]);
  }
  if (event === "installation.disk_low") {
    // An installation event: it names the disk and how much is left on it.
    const disk = text(details.disk);
    const location = text(details.location);
    const free = typeof details.freeBytes === "number" ? details.freeBytes : null;
    const total = typeof details.totalBytes === "number" ? details.totalBytes : null;
    if (disk === "database" || disk === "repository") {
      rows.push([
        t("reports:mail.disk"),
        t(disk === "database" ? "reports:mail.diskDatabase" : "reports:mail.diskRepository"),
      ]);
    }
    if (location) rows.push([t("reports:mail.location"), location]);
    if (free !== null) rows.push([t("reports:mail.free"), formatGib(free, input.language)]);
    if (total !== null) rows.push([t("reports:mail.total"), formatGib(total, input.language)]);
  }
  if (event === "backup.suspicious") {
    // Which restore point, and why it looks like ransomware at work: one line per finding.
    const at = formatWhen(text(details.restorePointAt), input.language);
    if (at) rows.push([t("reports:mail.restorePoint"), `${at} UTC`]);
    const lines = suspicionFindingLines(details.findings, input.language, (key, values) =>
      i18n.exists(key) ? t(key, values) : t("suspicion:findings.unknown", values),
    );
    if (lines.length > 0) rows.push([t("reports:mail.findings"), lines.join("; ")]);
    if (details.retentionHeld === true) {
      rows.push([t("reports:mail.retention"), t("reports:mail.retentionPaused")]);
    }
  }
  if (event === "backup.suspicious_hold") {
    // How long retention has been paused, and for how many suspicious restore points.
    const since = formatWhen(text(details.heldSince), input.language);
    if (since) rows.push([t("reports:mail.heldSince"), `${since} UTC`]);
    if (typeof details.restorePoints === "number") {
      rows.push([t("reports:mail.heldRestorePoints"), String(details.restorePoints)]);
    }
    rows.push([t("reports:mail.retention"), t("reports:mail.retentionPaused")]);
  }
  // A failed job says why and what to do, in the recipient's language; the raw message follows.
  const failure = alertFailure(details.failure);
  if (failure) {
    const variables = failureVariables(failure.params);
    const known = i18n.exists(`failures:cause.${failure.code}.title`);
    rows.push([
      t("reports:mail.cause"),
      t(`failures:cause.${known ? failure.code : "unknown"}.title`, variables),
    ]);
    const steps = failure.steps.filter((id) => i18n.exists(`failures:steps.${id}`)).slice(0, 3);
    if (steps.length > 0) {
      rows.push([
        t("reports:mail.todo"),
        steps.map((id) => t(`failures:steps.${id}`, variables)).join(" "),
      ]);
    }
  }
  const error = text(details.errorMessage);
  if (error) rows.push([t("reports:mail.error"), error.slice(0, 500)]);
  const reasons = Array.isArray(details.reasons)
    ? details.reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  if (reasons.length > 0) rows.push([t("reports:mail.reasons"), reasons.slice(0, 5).join("; ")]);

  const prefix = input.test ? t("reports:mail.testPrefix") : "";
  const heading = `${prefix}${eventLabel}: ${target}`;
  const { text: body, html } = layout(
    heading,
    t("reports:mail.alertIntro", { event: eventLabel, target, tenant: input.tenantName }),
    rows,
    t("reports:mail.footer", { rule: input.ruleName }),
  );
  return { subject: `[${input.tenantName}] ${heading}`, text: body, html };
}

/** A summary report as rendered by the extension that renders them (see hooks.ts). */
export interface SummaryInput {
  readonly language: SupportedLanguage;
  readonly tenantName: string;
  readonly ruleName: string;
  readonly payload: Record<string, unknown>;
  readonly test?: boolean;
}

/** Shared frame for summary reports, so the renderer only supplies the rows. */
export function renderSummaryFrame(
  input: SummaryInput,
  rows: readonly [string, string][],
): RenderedMessage {
  const i18n = createI18n({ lng: input.language });
  const t = (key: string, values?: Record<string, unknown>) => String(i18n.t(key, values));
  const from = formatWhen(text(input.payload.periodStart), input.language) ?? "";
  const to = formatWhen(text(input.payload.periodEnd), input.language) ?? "";
  const prefix = input.test ? t("reports:mail.testPrefix") : "";
  const heading = `${prefix}${input.ruleName}`;
  const { text: body, html } = layout(
    heading,
    t("reports:mail.summaryIntro", { tenant: input.tenantName, from, to }),
    rows,
    t("reports:mail.footer", { rule: input.ruleName }),
  );
  return { subject: `[${input.tenantName}] ${heading}`, text: body, html };
}
