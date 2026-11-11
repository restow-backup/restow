import { isReportEvent, type ReportEvent } from "@restow/core";
import { createI18n, failureVariables, type SupportedLanguage } from "@restow/i18n";

/**
 * Turning an outbox row into what a person reads: the subject, a plain-text
 * body and a small HTML body, in the rule's (or tenant's) language. Every
 * value that came from data (object names, error texts) is escaped for HTML;
 * nothing is fetched from outside and there is no tracking. A branded mail
 * (0.5.0, docs/NOTIFICATIONS.md "Branding") carries its logo as an inline
 * attachment the HTML refers to by Content-ID (`cid:`), its colours only as
 * validated `#rrggbb` values (cssHex), and its footer text escaped.
 */

export interface RenderedMessage {
  subject: string;
  text: string;
  html: string;
}

/** What a mail is branded with (from the effective brand, packages/core reports/branding.ts). */
export interface MailBrand {
  /** The sender name; it also replaces the product name in the texts. */
  readonly senderName: string;
  readonly accentColor: string | null;
  readonly onAccent: "light" | "dark" | null;
  readonly linkColor: string | null;
  readonly footerText: string | null;
  /**
   * The logo: `src` is `cid:<content id>` in a mail (the dispatcher attaches the image) or the
   * public image path in a preview. Width and height are the image's own pixels.
   */
  readonly logo: { readonly src: string; readonly width: number; readonly height: number } | null;
}

export interface AlertInput {
  readonly language: SupportedLanguage;
  readonly tenantName: string;
  readonly ruleName: string;
  readonly payload: Record<string, unknown>;
  /** A test send from the rule editor: marked as such in the subject and body. */
  readonly test?: boolean;
  /** The brand of the mail; absent renders today's unbranded mail, byte for byte. */
  readonly brand?: MailBrand | null;
}

/** A colour for a style attribute: only ever an exact `#rrggbb`, anything else throws. */
export function cssHex(value: string): string {
  if (!/^#[0-9a-f]{6}$/.test(value)) {
    throw new RangeError("not a validated #rrggbb colour");
  }
  return value;
}

/** The Content-ID of a logo: stable per image, so a client may cache it. */
export function logoContentId(sha256: string): string {
  return `brand-logo.${sha256
    .slice(0, 12)
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "0")}@mail.invalid`;
}

/** The size a logo is shown at: at most 200 × 60 CSS pixels, its aspect ratio kept. */
export function logoDisplaySize(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    return { width: 200, height: 60 };
  }
  const scale = Math.min(200 / width, 60 / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** A `src` an <img> of a mail may carry: a Content-ID or a path on this instance, nothing else. */
function safeImageSource(src: string): string | null {
  if (/^cid:[A-Za-z0-9._@-]+$/.test(src)) {
    return src;
  }
  if (/^\/api\/v1\/public\/branding\/[A-Za-z0-9_-]+\.(png|jpg)$/.test(src)) {
    return src;
  }
  return null;
}

/** An i18n instance whose `{appName}` is the brand's sender name when the mail is branded. */
function mailI18n(language: SupportedLanguage, brand: MailBrand | null | undefined) {
  return brand
    ? createI18n({ lng: language, appName: brand.senderName })
    : createI18n({ lng: language });
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

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The object with its service (0.5.0), "OneDrive · msp@contoso.example": a person's mailbox and
 * OneDrive share the person's name. The bare name for a kind without a label.
 */
function serviceTarget(
  i18n: ReturnType<typeof createI18n>,
  name: string,
  kind: string | null | undefined,
): string {
  const key = kind ? `verify:kind.${kind}` : null;
  return key && i18n.exists(key) ? `${String(i18n.t(key))} · ${name}` : name;
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

/** A calendar day (an expiry date is midnight UTC), without a time. */
function formatDay(iso: string | null, language: SupportedLanguage): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-GB", {
    dateStyle: "medium",
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

/** The rows of a labelled line list as HTML table rows. */
function htmlRowsOf(rows: readonly [string, string][]): string {
  return rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top">${escapeHtml(label)}</td><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
}

/** The footer text of a brand (imprint): escaped, each line break a <br>. */
function brandFooterHtml(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => escapeHtml(line))
    .join("<br>");
}

/**
 * The branded frame around a mail's content: the logo (inline by Content-ID) and a 4 px rule in
 * the accent colour above the heading, the brand's footer text under the product footer. Every
 * value from data is escaped; colours go through cssHex.
 */
function brandedHtml(brand: MailBrand, content: string, footer: string): string {
  const parts: string[] = [];
  const src = brand.logo ? safeImageSource(brand.logo.src) : null;
  if (brand.logo && src) {
    const size = logoDisplaySize(brand.logo.width, brand.logo.height);
    parts.push(
      `<table role="presentation" style="border-collapse:collapse;margin:0 0 12px"><tr><td style="padding:0"><img src="${escapeHtml(src)}" width="${size.width}" height="${size.height}" alt="${escapeHtml(brand.senderName)}" style="display:block;border:0;width:${size.width}px;height:${size.height}px"></td></tr></table>`,
    );
  }
  if (brand.accentColor) {
    parts.push(
      `<div style="height:4px;line-height:4px;font-size:0;background:${cssHex(brand.accentColor)};margin:0 0 16px">&nbsp;</div>`,
    );
  }
  parts.push(content);
  parts.push(`<p style="margin-top:24px;color:#666;font-size:12px">${escapeHtml(footer)}</p>`);
  if (brand.footerText) {
    parts.push(
      `<p style="margin-top:12px;color:#666;font-size:12px">${brandFooterHtml(brand.footerText)}</p>`,
    );
  }
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;color:#111;max-width:640px">${parts.join("")}</body></html>`;
}

/** The plain-text footer: the product footer, then the brand's footer text. */
function textFooter(footer: string, brand: MailBrand | null | undefined): string[] {
  return brand?.footerText ? ["--", footer, "", brand.footerText] : ["--", footer];
}

/** A labelled line list as text and as an HTML table. */
function layout(
  heading: string,
  intro: string,
  rows: readonly [string, string][],
  footer: string,
  brand?: MailBrand | null,
): { text: string; html: string } {
  const textRows = rows.map(([label, value]) => `${label}: ${value}`).join("\n");
  const htmlRows = htmlRowsOf(rows);
  if (brand) {
    return {
      text: [heading, "", intro, "", textRows, "", ...textFooter(footer, brand)].join("\n"),
      html: brandedHtml(
        brand,
        `<h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(heading)}</h2><p>${escapeHtml(intro)}</p><table style="border-collapse:collapse">${htmlRows}</table>`,
        footer,
      ),
    };
  }
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
  const i18n = mailI18n(input.language, input.brand);
  const t = (key: string, values?: Record<string, unknown>) => String(i18n.t(key, values));
  const event = text(input.payload.event) ?? "";
  const details = (input.payload.details ?? {}) as Record<string, unknown>;
  // A red rating because the newest backup is too old is not a failed restore check.
  // The question "was this IMAP account shut down?" is not "no longer backed up": the account is
  // still active and backed up while its login fails.
  const loginQuestion =
    (event === "object.inactive" || event === "object.inactive_many") &&
    details.question === "login";
  const eventLabel =
    event === "verify.red" && details.redReason === "outdated"
      ? t("reports:mail.verifyRedOutdated")
      : loginQuestion
        ? t(
            event === "object.inactive_many"
              ? "reports:mail.loginQuestionLabelMany"
              : "reports:mail.loginQuestionLabel",
          )
        : isReportEvent(event)
          ? t(`reports:events.${event as ReportEvent}`)
          : event;
  // The service named with the object (0.5.0): a person's mailbox and OneDrive share a name.
  const objectName = text(details.objectName);
  const target = objectName
    ? serviceTarget(i18n, objectName, text(details.objectKind))
    : text(details.queue)
      ? t(`reports:queues.${details.queue as string}`)
      : input.tenantName;

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
    const placeKey: Record<string, string> = {
      database: "reports:mail.diskDatabase",
      repository: "reports:mail.diskRepository",
      system: "reports:mail.diskSystem",
    };
    // One disk that holds several places (0.5.0) names them all in one row.
    const places = (Array.isArray(details.disks) ? details.disks : [disk]).filter(
      (place): place is string => typeof place === "string" && place in placeKey,
    );
    if (places.length > 0) {
      rows.push([
        t("reports:mail.disk"),
        new Intl.ListFormat(input.language === "de" ? "de-DE" : "en-GB", {
          type: "conjunction",
        }).format(places.map((place) => t(placeKey[place] as string))),
      ]);
    }
    if (location) rows.push([t("reports:mail.location"), location]);
    if (free !== null) rows.push([t("reports:mail.free"), formatGib(free, input.language)]);
    if (total !== null) rows.push([t("reports:mail.total"), formatGib(total, input.language)]);
    // The emergency disk reserve (#98): where it is and how it is freed by hand.
    const reservePath = text(details.reservePath);
    if (reservePath && details.reserveState === "present") {
      rows.push([
        t("reports:mail.reserve"),
        t("reports:mail.reserveLine", {
          size: formatGib(numberOr(details.reserveBytes), input.language),
          path: reservePath,
          floor: formatGib(numberOr(details.reserveFloorBytes), input.language),
          command: text(details.reserveCommand),
        }),
      ]);
    }
  }
  if (
    event === "installation.disk_reserve_released" ||
    event === "installation.disk_reserve_restored"
  ) {
    // The emergency disk reserve (#98): where it is, how much the disk has now, what to do.
    const path = text(details.path);
    if (path) rows.push([t("reports:mail.location"), path]);
    if (typeof details.freeBytes === "number") {
      rows.push([t("reports:mail.free"), formatGib(details.freeBytes, input.language)]);
    }
    if (typeof details.totalBytes === "number") {
      rows.push([t("reports:mail.total"), formatGib(details.totalBytes, input.language)]);
    }
    if (event === "installation.disk_reserve_released") {
      rows.push([t("reports:mail.todo"), t("reports:mail.reserveTodo")]);
    }
  }
  if (event === "backup.unusually_large") {
    // A run the size and space guard held (#99): how large it got, what is usual, what to do.
    if (typeof details.bytes === "number") {
      rows.push([t("reports:mail.runSize"), formatGib(details.bytes, input.language)]);
    }
    if (typeof details.medianBytes === "number") {
      rows.push([t("reports:mail.usualSize"), formatGib(details.medianBytes, input.language)]);
    }
    if (typeof details.limitBytes === "number") {
      rows.push([t("reports:mail.sizeLimit"), formatGib(details.limitBytes, input.language)]);
    }
    if (typeof details.freeBytes === "number") {
      rows.push([t("reports:mail.free"), formatGib(details.freeBytes, input.language)]);
    }
    rows.push([t("reports:mail.todo"), t("reports:mail.runHeldTodo")]);
  }
  if (event === "installation.restore_mode") {
    // Restore mode came on by itself (a database dump was restored): what to do now.
    const targetId = text(details.targetId);
    if (targetId) rows.push([t("reports:mail.storageTarget"), targetId]);
    rows.push([t("reports:mail.todo"), t("reports:mail.restoreModeTodo")]);
  }
  if (event === "installation.key_mirror_conflict") {
    const targetId = text(details.targetId);
    if (typeof details.keyVersion === "number") {
      rows.push([t("reports:mail.keyVersion"), String(details.keyVersion)]);
    }
    if (targetId) rows.push([t("reports:mail.storageTarget"), targetId]);
    rows.push([t("reports:mail.todo"), t("reports:mail.keyMirrorTodo")]);
  }
  if (event === "installation.app_secret_expiring" || event === "source.app_secret_expiring") {
    // The expiry reminder of an app credential (the central app: features/updates/secret-watch.ts;
    // a source's own app: apps/worker source-app-expiry.ts): when it runs out, how long is left,
    // which app, and how to renew it without a gap.
    const expiresAt = formatDay(text(details.expiresAt), input.language);
    const clientId = text(details.clientId);
    const kind = text(details.credentialKind);
    if (expiresAt) rows.push([t("reports:mail.expiresAt"), expiresAt]);
    if (details.stage === "expired") {
      rows.push([t("reports:mail.daysLeft"), t("reports:mail.secretExpired")]);
    } else if (typeof details.days === "number") {
      rows.push([
        t("reports:mail.daysLeft"),
        formatCount(Math.max(0, details.days), input.language),
      ]);
    }
    if (kind === "secret" || kind === "certificate") {
      rows.push([
        t("reports:mail.credential"),
        t(
          kind === "secret"
            ? "reports:mail.credentialSecret"
            : "reports:mail.credentialCertificate",
        ),
      ]);
    }
    if (clientId) rows.push([t("reports:mail.clientId"), clientId]);
    rows.push([
      t("reports:mail.todo"),
      t(
        event === "source.app_secret_expiring"
          ? "reports:mail.secretRenewSource"
          : "reports:mail.secretRenewCentral",
      ),
    ]);
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
  if (event === "object.inactive" || event === "object.inactive_many") {
    // Restow stopped backing up objects (apps/worker inactive-notices.ts): why, since when, how
    // many, and that an admin confirms it under Protection ("Yes, intended").
    // The question has no reason row: nobody confirmed anything yet, the account is still active.
    const reason = text(details.reason);
    if (
      !loginQuestion &&
      (reason === "account_disabled" ||
        reason === "no_license" ||
        reason === "locked" ||
        reason === "login_refused" ||
        reason === "removed")
    ) {
      rows.push([t("reports:mail.inactiveReason"), t(`reports:mail.inactiveReasons.${reason}`)]);
    }
    // The login question of an IMAP account (`question: "login"`): since when the login is
    // refused, and what to do: answer under Protection, after checking the source's password
    // when it fails for the whole source.
    const since = formatWhen(
      text(loginQuestion ? details.failedSince : details.inactiveSince),
      input.language,
    );
    if (since) {
      rows.push([
        t(loginQuestion ? "reports:mail.loginRefusedSince" : "reports:mail.inactiveSince"),
        `${since} UTC`,
      ]);
    }
    if (typeof details.count === "number") {
      rows.push([t("reports:mail.inactiveCount"), formatCount(details.count, input.language)]);
    }
    rows.push([
      t("reports:mail.todo"),
      t(
        loginQuestion
          ? details.scope === "source" || event === "object.inactive_many"
            ? "reports:mail.loginQuestionSourceFirst"
            : "reports:mail.loginQuestionConfirm"
          : "reports:mail.inactiveConfirm",
      ),
    ]);
  }
  if (event === "archive.failed") {
    // An alert of the archive capture (apps/worker archive-capture/alerts.ts): what stopped,
    // since when, and when something last arrived.
    const reason = text(details.reason);
    if (
      reason === "capture_error" ||
      reason === "forward_stale" ||
      reason === "journal_stale" ||
      reason === "backfill_stalled" ||
      reason === "capture_gap"
    ) {
      rows.push([t("reports:mail.archiveProblem"), t(`reports:mail.archiveReason.${reason}`)]);
    }
    const since = formatWhen(
      text(details.errorSince) ?? text(details.activatedAt) ?? text(details.openedAt),
      input.language,
    );
    if (since) rows.push([t("reports:mail.archiveSince"), `${since} UTC`]);
    const last = formatWhen(text(details.lastCopyAt) ?? text(details.lastReportAt), input.language);
    if (last) rows.push([t("reports:mail.archiveLast"), `${last} UTC`]);
  }
  if (event === "notification.delivery_failed") {
    rows.push(...renderDeliveryFailureRows(details, input.language, i18n.exists.bind(i18n), t));
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
    input.brand,
  );
  return { subject: `[${input.tenantName}] ${heading}`, text: body, html };
}

/**
 * The rows of a `notification.delivery_failed` alert: which channel failed, for whom or which
 * webhook, why (the same texts the settings and the webhook log use), since when and how many
 * deliveries.
 */
export function renderDeliveryFailureRows(
  details: Record<string, unknown>,
  language: SupportedLanguage,
  exists: (key: string) => boolean,
  t: (key: string, values?: Record<string, unknown>) => string,
): [string, string][] {
  const rows: [string, string][] = [];
  const channel = details.channel === "webhook" ? "webhook" : "email";
  rows.push([
    t("reports:mail.deliveryFailed.channel"),
    t(
      channel === "webhook"
        ? "reports:mail.deliveryFailed.webhook"
        : "reports:mail.deliveryFailed.email",
    ),
  ]);
  if (channel === "webhook") {
    const name = text(details.webhookName) ?? text(details.host);
    if (name) rows.push([t("reports:mail.deliveryFailed.webhookName"), name]);
  } else if (details.scope === "transport") {
    rows.push([
      t("reports:mail.deliveryFailed.recipient"),
      t("reports:mail.deliveryFailed.transport"),
    ]);
  } else {
    const recipient = text(details.recipient);
    if (recipient) rows.push([t("reports:mail.deliveryFailed.recipient"), recipient]);
  }
  const reason = text(details.reason);
  if (reason) {
    const key =
      channel === "webhook"
        ? `integrations:deliveries.errors.${reason}`
        : `settings:mail.test.reasons.${reason}`;
    const status = typeof details.httpStatus === "number" ? details.httpStatus : "";
    rows.push([t("reports:mail.deliveryFailed.reason"), exists(key) ? t(key, { status }) : reason]);
  }
  const detail = text(details.detail);
  if (detail) rows.push([t("reports:mail.error"), detail.slice(0, 300)]);
  const since = formatWhen(text(details.since), language);
  if (since) rows.push([t("reports:mail.deliveryFailed.since"), `${since} UTC`]);
  if (typeof details.failedDeliveries === "number") {
    rows.push([
      t("reports:mail.deliveryFailed.count"),
      formatCount(details.failedDeliveries, language),
    ]);
  }
  const ruleName = text(details.ruleName);
  if (ruleName) rows.push([t("reports:mail.deliveryFailed.rule"), ruleName]);
  return rows;
}

/** A summary report as rendered by the extension that renders them (see hooks.ts). */
export interface SummaryInput {
  readonly language: SupportedLanguage;
  readonly tenantName: string;
  readonly ruleName: string;
  readonly payload: Record<string, unknown>;
  readonly test?: boolean;
  /** The brand of the mail; absent renders the unbranded frame. */
  readonly brand?: MailBrand | null;
}

/** Shared frame for summary reports, so the renderer only supplies the rows. */
export function renderSummaryFrame(
  input: SummaryInput,
  rows: readonly [string, string][],
): RenderedMessage {
  const i18n = mailI18n(input.language, input.brand);
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
    input.brand,
  );
  return { subject: `[${input.tenantName}] ${heading}`, text: body, html };
}

/** One alert in a digest. */
export interface DigestItem {
  /** The tenant the alert is about; null for an installation event. */
  readonly tenantName: string | null;
  readonly event: string;
  readonly level: "info" | "warning" | "error";
  readonly occurredAt: string | null;
  /** What it is about (object, queue), as the alert mail names it. */
  readonly target: string | null;
  /**
   * What kind of protected object `target` is (`details.objectKind`, 0.5.0): the line names the
   * service with it, as the alert mail does. Absent for a queue or another target.
   */
  readonly objectKind?: string | null;
}

export interface DigestInput {
  readonly language: SupportedLanguage;
  readonly audience: "tenant" | "provider";
  /** The tenant of a tenant digest (its name goes into the subject). */
  readonly tenantName?: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string;
  readonly window: "hourly" | "daily";
  readonly items: readonly DigestItem[];
  readonly brand?: MailBrand | null;
  readonly test?: boolean;
}

/** At most this many lines in one digest; the rest is counted. */
export const DIGEST_MAX_LINES = 200;

const LEVEL_ORDER: readonly DigestItem["level"][] = ["error", "warning", "info"];

/**
 * One mail for the alerts a recipient collects in a digest: grouped by tenant (installation
 * events under the installation's own heading), then by severity, oldest first, at most
 * {@link DIGEST_MAX_LINES} lines and "and N more". Every value is escaped.
 */
export function renderDigest(input: DigestInput): RenderedMessage {
  const i18n = mailI18n(input.language, input.brand);
  const t = (key: string, values?: Record<string, unknown>) => String(i18n.t(key, values));
  const installation = t("reports:mail.installation");
  const groups = new Map<string, DigestItem[]>();
  for (const item of input.items) {
    const key = item.tenantName ?? installation;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const tenantNames = [...groups.keys()].sort((a, b) =>
    a === installation ? -1 : b === installation ? 1 : a.localeCompare(b, input.language),
  );
  let shown = 0;
  const textParts: string[] = [];
  const htmlParts: string[] = [];
  for (const tenant of tenantNames) {
    if (shown >= DIGEST_MAX_LINES) break;
    const items = [...(groups.get(tenant) ?? [])].sort(
      (a, b) =>
        LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) ||
        (a.occurredAt ?? "").localeCompare(b.occurredAt ?? ""),
    );
    const lines: { label: string; when: string; target: string }[] = [];
    for (const item of items) {
      if (shown >= DIGEST_MAX_LINES) break;
      const label = isReportEvent(item.event)
        ? t(`reports:events.${item.event as ReportEvent}`)
        : item.event;
      const when = formatWhen(item.occurredAt, input.language);
      lines.push({
        label: `${t(`reports:digest.level.${item.level}`)}: ${label}`,
        when: when ? `${when} UTC` : "",
        target: item.target ? serviceTarget(i18n, item.target, item.objectKind) : "",
      });
      shown++;
    }
    const heading =
      input.audience === "provider" || groups.size > 1
        ? t("reports:digest.tenantHeading", { tenant })
        : null;
    if (heading) {
      textParts.push("", heading);
      htmlParts.push(`<h3 style="font-size:15px;margin:16px 0 6px">${escapeHtml(heading)}</h3>`);
    }
    textParts.push(
      ...lines.map((line) =>
        [line.label, line.target, line.when].filter((part) => part.length > 0).join(" · "),
      ),
    );
    htmlParts.push(
      `<table style="border-collapse:collapse">${lines
        .map(
          (line) =>
            `<tr><td style="padding:3px 12px 3px 0;vertical-align:top">${escapeHtml(line.label)}</td><td style="padding:3px 12px 3px 0;vertical-align:top">${escapeHtml(line.target)}</td><td style="padding:3px 0;color:#555;white-space:nowrap">${escapeHtml(line.when)}</td></tr>`,
        )
        .join("")}</table>`,
    );
  }
  const more = input.items.length - shown;
  if (more > 0) {
    const line = t("reports:digest.more", { count: more });
    textParts.push("", line);
    htmlParts.push(`<p>${escapeHtml(line)}</p>`);
  }
  const from = formatWhen(input.windowStart, input.language) ?? "";
  const to = formatWhen(input.windowEnd, input.language) ?? "";
  const prefix = input.test ? t("reports:mail.testPrefix") : "";
  const heading = `${prefix}${t(
    input.window === "hourly" ? "reports:digest.hourly" : "reports:digest.daily",
  )}`;
  const intro = t("reports:digest.intro", { count: input.items.length, from, to });
  const subject =
    input.audience === "provider" || !input.tenantName
      ? `${prefix}${t("reports:digest.subjectProvider", { count: input.items.length })}`
      : `[${input.tenantName}] ${prefix}${t("reports:digest.subject", { count: input.items.length })}`;
  const footer = t("reports:digest.footer");
  const content = `<h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(heading)}</h2><p>${escapeHtml(intro)}</p>${htmlParts.join("")}`;
  const html = input.brand
    ? brandedHtml(input.brand, content, footer)
    : `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;color:#111;max-width:640px">${content}<p style="margin-top:24px;color:#666;font-size:12px">${escapeHtml(footer)}</p></body></html>`;
  return {
    subject,
    text: [heading, "", intro, ...textParts, "", ...textFooter(footer, input.brand)].join("\n"),
    html,
  };
}
