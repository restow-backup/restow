import {
  MAX_REPORT_RECIPIENTS,
  MAX_REPORT_THROTTLE_MINUTES,
  REPORT_EVENTS,
  REPORT_PERIOD_DAYS,
  REPORT_SECTIONS,
} from "@restow/core";
import { z } from "zod";
import { ProblemError } from "../../problem.js";

/**
 * Request schemas of the reports feature (same style as apps/api/src/schemas.ts).
 * A rule is either an `event` rule (at least one event) or a `schedule` rule
 * (a cadence and at least one section); either needs at least one channel.
 * Cadences are judged by the shared @restow/core code in the service.
 */

export const INVALID_REPORT_RULE_PROBLEM = "urn:restow:problem:invalid-report-rule";

export type ReportRuleField =
  | "name"
  | "events"
  | "sections"
  | "channels"
  | "emailRecipients"
  | "webhookId"
  | "trigger"
  | "intervalMinutes"
  | "cron"
  | "timezone";

/** A 422 problem naming the field, like a schema failure (`issues[0].path`). */
export function reportRuleProblem(
  field: ReportRuleField,
  code: string,
  message: string,
): ProblemError {
  return new ProblemError(422, "Invalid report rule", {
    type: INVALID_REPORT_RULE_PROBLEM,
    detail: `${field}: ${message}`,
    extensions: { field, code, issues: [{ path: [field], code, message }] },
  });
}

const email = z.string().trim().toLowerCase().email().max(254);

/** A list without repeats, in first-seen order (addresses are lower-cased first). */
const unique = <T>(values: T[]): T[] => [...new Set(values)];

const ruleFields = {
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  events: z
    .array(z.enum(REPORT_EVENTS))
    .max(REPORT_EVENTS.length * 2)
    .default([])
    .transform(unique),
  throttleMinutes: z.number().int().min(0).max(MAX_REPORT_THROTTLE_MINUTES).default(60),
  intervalMinutes: z.number().int().positive().nullable().optional(),
  cron: z.string().trim().min(1).max(120).nullable().optional(),
  timezone: z.string().trim().min(1).max(64).default("UTC"),
  periodDays: z
    .number()
    .int()
    .refine((value) => (REPORT_PERIOD_DAYS as readonly number[]).includes(value), {
      message: `one of ${REPORT_PERIOD_DAYS.join(", ")}`,
    })
    .default(7),
  sections: z
    .array(z.enum(REPORT_SECTIONS))
    .max(REPORT_SECTIONS.length * 2)
    .default([])
    .transform(unique),
  emailRecipients: z
    .array(email)
    .max(MAX_REPORT_RECIPIENTS * 2)
    .default([])
    .transform(unique)
    .refine((list) => list.length <= MAX_REPORT_RECIPIENTS, {
      message: `at most ${MAX_REPORT_RECIPIENTS} recipients`,
    }),
  inApp: z.boolean().default(false),
  webhookId: z.string().uuid().nullable().default(null),
  language: z.enum(["de", "en"]).nullable().default(null),
};

export const createReportRuleSchema = z.object({
  trigger: z.enum(["event", "schedule"]),
  ...ruleFields,
});
export type CreateReportRuleInput = z.infer<typeof createReportRuleSchema>;

/** Every field optional; the trigger cannot change (delete and recreate instead). */
export const updateReportRuleSchema = z
  .object({
    name: ruleFields.name,
    enabled: z.boolean(),
    events: z
      .array(z.enum(REPORT_EVENTS))
      .max(REPORT_EVENTS.length * 2)
      .transform(unique),
    throttleMinutes: z.number().int().min(0).max(MAX_REPORT_THROTTLE_MINUTES),
    intervalMinutes: z.number().int().positive().nullable(),
    cron: z.string().trim().min(1).max(120).nullable(),
    timezone: z.string().trim().min(1).max(64),
    periodDays: ruleFields.periodDays.removeDefault(),
    sections: z
      .array(z.enum(REPORT_SECTIONS))
      .max(REPORT_SECTIONS.length * 2)
      .transform(unique),
    emailRecipients: z
      .array(email)
      .max(MAX_REPORT_RECIPIENTS * 2)
      .transform(unique)
      .refine((list) => list.length <= MAX_REPORT_RECIPIENTS, {
        message: `at most ${MAX_REPORT_RECIPIENTS} recipients`,
      }),
    inApp: z.boolean(),
    webhookId: z.string().uuid().nullable(),
    language: z.enum(["de", "en"]).nullable(),
  })
  .partial()
  .strict();
export type UpdateReportRuleInput = z.infer<typeof updateReportRuleSchema>;

export const reportRuleParamSchema = z.object({ id: z.string().uuid() });

export const listDeliveriesQuerySchema = z.object({
  ruleId: z.string().uuid().optional(),
  status: z.enum(["pending", "sent", "failed", "skipped"]).optional(),
  /** Only rows created before this moment: the next older page (the `createdAt` of the last row). */
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuerySchema>;

/** The CSV export of the delivery log: the same filters, more rows at once. */
export const exportDeliveriesQuerySchema = listDeliveriesQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(10_000).default(5_000),
});

export const listNotificationsQuerySchema = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  /** `attention`: warnings and errors. */
  level: z.enum(["info", "warning", "error", "attention"]).optional(),
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const markNotificationsReadSchema = z
  .object({
    ids: z.array(z.string().uuid()).max(200).optional(),
    all: z.literal(true).optional(),
  })
  .refine((value) => value.all === true || (value.ids?.length ?? 0) > 0, {
    message: "ids or all is required",
  });
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;
