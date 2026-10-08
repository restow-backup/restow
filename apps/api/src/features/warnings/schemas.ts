import { MAX_ACK_NOTE_LENGTH } from "@restow/core";
import { z } from "zod";
import { MAX_BULK_TARGETS } from "./service.js";

/** Request schemas of the warnings feature. */

export const targetKindSchema = z.enum(["object", "machine"]);

export const targetParamSchema = z.object({
  kind: targetKindSchema,
  id: z.string().uuid(),
});

export const listQuerySchema = z.object({
  state: z.enum(["open", "acknowledged", "all"]).default("all"),
});

export const acknowledgeSchema = z.object({
  targets: z
    .array(z.object({ kind: targetKindSchema, id: z.string().uuid() }))
    .min(1)
    .max(MAX_BULK_TARGETS),
  note: z.string().max(MAX_ACK_NOTE_LENGTH).nullish(),
});
export type AcknowledgeInput = z.infer<typeof acknowledgeSchema>;
