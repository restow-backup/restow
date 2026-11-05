import { tenants } from "@restow/db";
import { defaultLanguage, type SupportedLanguage } from "@restow/i18n";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import type { DbExecutor } from "../../lib/tenant-context.js";
import type { NotificationMessage, Notifier } from "../../notify.js";
import { ProblemError } from "../../problem.js";
import {
  type MailBrand,
  type RenderedMessage,
  renderAlert,
  renderDigest,
  renderSummaryFrame,
} from "../reports/render.js";
import {
  BRANDING_AUDIT_ACTIONS,
  type BrandingActor,
  effectiveBrand,
  mailBrandOf,
} from "./service.js";

/**
 * The preview and the test mail of the branding page (0.5.0): a sample alert, digest, summary
 * or customer report in the effective brand of the installation or of one tenant. The preview's
 * HTML refers to the logo by its public path (the page shows it in a sandboxed iframe without
 * scripts); the test mail carries it inline, exactly as a real mail does.
 */

export const PREVIEW_KINDS = ["alert", "digest", "summary", "customer"] as const;

export const brandingPreviewQuerySchema = z.object({
  kind: z.enum(PREVIEW_KINDS).default("alert"),
  tenantId: z.uuid().optional(),
  lang: z.enum(["de", "en"]).optional(),
});

export const brandingTestSchema = z
  .object({ tenantId: z.uuid().optional(), kind: z.enum(PREVIEW_KINDS).optional() })
  .strict();

async function tenantNameOf(providerDb: DbExecutor, tenantId: string | undefined) {
  if (!tenantId) {
    return null;
  }
  const [row] = await providerDb
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) {
    throw new ProblemError(404, "Tenant not found");
  }
  return row.name;
}

/** A sample message of `kind` in `brand`. */
export function sampleMessage(
  kind: (typeof PREVIEW_KINDS)[number],
  language: SupportedLanguage,
  tenantName: string,
  brand: MailBrand | null,
  now: Date,
  test = false,
): RenderedMessage {
  const occurredAt = now.toISOString();
  if (kind === "digest") {
    return renderDigest({
      language,
      audience: "tenant",
      tenantName,
      window: "daily",
      windowStart: new Date(now.getTime() - 24 * 60 * 60_000).toISOString(),
      windowEnd: occurredAt,
      items: [
        { tenantName, event: "backup.failed", level: "error", occurredAt, target: "Mailbox" },
        { tenantName, event: "backup.overdue", level: "warning", occurredAt, target: "OneDrive" },
      ],
      brand,
      test,
    });
  }
  if (kind === "summary" || kind === "customer") {
    return renderSummaryFrame(
      {
        language,
        tenantName,
        ruleName: language === "de" ? "Monatsbericht" : "Monthly report",
        payload: {
          periodStart: new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString(),
          periodEnd: occurredAt,
        },
        brand,
        test,
      },
      [
        [language === "de" ? "Erfolgsquote der Sicherungen" : "Backup success rate", "99.2 %"],
        [language === "de" ? "Geprüfte Objekte" : "Verified objects", "87 %"],
      ],
    );
  }
  return renderAlert({
    language,
    tenantName,
    ruleName: language === "de" ? "Fehlgeschlagene Läufe" : "Failed runs",
    payload: {
      event: "backup.failed",
      level: "error",
      occurredAt,
      details: { objectName: "Mailbox", errorMessage: "Sample error" },
    },
    brand,
    test,
  });
}

/** GET /settings/branding/preview: subject, HTML and text of a sample in the effective brand. */
export async function brandingPreview(
  providerDb: DbExecutor,
  query: z.infer<typeof brandingPreviewQuerySchema>,
  now: Date = new Date(),
): Promise<RenderedMessage> {
  const tenantName = (await tenantNameOf(providerDb, query.tenantId)) ?? "Contoso";
  const loaded = await effectiveBrand(providerDb, query.tenantId ?? null);
  const { brand } = mailBrandOf(loaded, "preview");
  return sampleMessage(query.kind, query.lang ?? defaultLanguage, tenantName, brand, now);
}

/** POST /settings/branding/test: the sample alert to the signed-in user, inline logo and all. */
export async function sendBrandingTest(
  providerDb: DbExecutor,
  notifier: Notifier | null,
  input: z.infer<typeof brandingTestSchema>,
  actor: BrandingActor,
  language: SupportedLanguage,
  now: Date = new Date(),
): Promise<{ to: string }> {
  if (!notifier) {
    throw new ProblemError(409, "Mail transport not configured", {
      type: "urn:restow:problem:mail-not-configured",
      detail: "Configure a mail transport first.",
    });
  }
  const tenantName = (await tenantNameOf(providerDb, input.tenantId)) ?? "Contoso";
  const loaded = await effectiveBrand(providerDb, input.tenantId ?? null);
  const mail = mailBrandOf(loaded, "cid");
  const rendered = sampleMessage(
    input.kind ?? "alert",
    language,
    tenantName,
    mail.brand,
    now,
    true,
  );
  const message: NotificationMessage = {
    to: actor.email,
    ...rendered,
    ...(mail.from ? { from: mail.from } : {}),
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
    ...(mail.attachment && rendered.html.includes(`cid:${mail.attachment.cid}`)
      ? { attachments: [mail.attachment] }
      : {}),
  };
  const result = await notifier.send(message);
  if (!result.ok) {
    throw new ProblemError(502, "The test mail could not be sent", {
      type: "urn:restow:problem:mail-send-failed",
      detail: result.error ?? "The mail transport refused the message.",
      extensions: { reason: result.reason ?? null },
    });
  }
  await audit(providerDb, {
    tenantId: input.tenantId ?? null,
    actor: actor.email,
    actorUserId: actor.id,
    action: BRANDING_AUDIT_ACTIONS.testSent,
    target: input.tenantId ?? "provider",
    targetType: "branding",
    ip: actor.ip,
    details: { kind: input.kind ?? "alert" },
  });
  return { to: actor.email };
}
