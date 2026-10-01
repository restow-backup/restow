import { type ReportEvent, isReportEvent } from "@restow/core";
import { type SupportedLanguage, createI18n, failureVariables } from "@restow/i18n";

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
