import { z } from "zod";
import { WEBHOOK_EVENTS } from "../../lib/webhooks.js";

/** Request schemas of the webhooks feature (same style as apps/api/src/schemas.ts). */

export const MAX_WEBHOOK_URL_LENGTH = 2048;

export type WebhookUrlIssue = "invalid" | "scheme" | "credentials";

/**
 * Why `value` cannot be a webhook target, or null when it can: an absolute
 * http(s) URL without embedded credentials. Which addresses the worker may
 * connect to (no loopback, link-local or, by default, private networks) is
 * decided at delivery time, after DNS resolution.
 */
export function webhookUrlIssue(value: string): WebhookUrlIssue | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "scheme";
  }
  if (url.username !== "" || url.password !== "") {
    return "credentials";
  }
  return url.hostname.length > 0 ? null : "invalid";
}

const URL_ISSUE_MESSAGES: Record<WebhookUrlIssue, string> = {
  invalid: "Enter an absolute URL, e.g. https://rmm.example.com/hooks/restow.",
  scheme: "Only http:// and https:// URLs can receive webhooks.",
  credentials: "Credentials in the URL are not allowed; authenticate with the signature instead.",
};

export const webhookUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_WEBHOOK_URL_LENGTH)
  .superRefine((value, ctx) => {
    const issue = webhookUrlIssue(value);
    if (issue) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: URL_ISSUE_MESSAGES[issue] });
    }
  });

export const webhookEventSchema = z.enum(WEBHOOK_EVENTS);

const eventsSchema = z
  .array(webhookEventSchema)
  .min(1)
  .max(WEBHOOK_EVENTS.length * 2)
  .transform((events) => WEBHOOK_EVENTS.filter((event) => events.includes(event)));

/** An optional display name; blank means none. */
const nameSchema = z
  .string()
  .trim()
  .max(100)
  .nullable()
  .transform((value) => (value && value.length > 0 ? value : null));

export const createWebhookSchema = z.object({
  name: nameSchema.optional().transform((value) => value ?? null),
  url: webhookUrlSchema,
  events: eventsSchema,
  active: z.boolean().default(true),
});
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export const updateWebhookSchema = z
  .object({
    name: nameSchema.optional(),
    url: webhookUrlSchema.optional(),
    events: eventsSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Nothing to update.",
  });
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;

export const webhookParamSchema = z.object({ id: z.string().uuid() });

export const deliveryParamSchema = z.object({
  id: z.string().uuid(),
  deliveryId: z.string().uuid(),
});

export const deliveryStatusSchema = z.enum(["pending", "delivered", "failed"]);

export const deliveriesQuerySchema = z.object({
  status: deliveryStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Opaque cursor from the previous page's `next`. */
  cursor: z.string().min(1).max(512).optional(),
});
export type DeliveriesQuery = z.infer<typeof deliveriesQuerySchema>;
