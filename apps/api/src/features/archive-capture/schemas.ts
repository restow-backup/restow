import { z } from "zod";
import { MAILBOX_WAYS, STREAM_STATUSES } from "./service.js";

/** GET /archive/capture/mailboxes query. */
export const captureMailboxesQuerySchema = z.object({
  way: z.enum(MAILBOX_WAYS).optional(),
  status: z.enum(STREAM_STATUSES).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

export const captureObjectParamSchema = z.object({ objectId: z.string().uuid() });

export const holdSourceParamSchema = z.object({ sourceId: z.string().uuid() });

/** PUT /archive/capture/holds/:sourceId body. */
export const holdBodySchema = z.object({ status: z.enum(["confirmed", "unknown"]) }).strict();
