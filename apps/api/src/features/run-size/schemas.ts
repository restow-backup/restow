import {
  RUN_SIZE_FACTOR_RANGE,
  RUN_SIZE_FREE_PERCENT_MAX,
  RUN_SIZE_OBJECT_KINDS,
} from "@restow/core";
import { z } from "zod";

/** Request schemas of the size and space guard of backup runs (#99). */

const GIB = 1024 ** 3;
/** The largest size an administrator can set, in GiB (1 PiB). */
export const MAX_RUN_SIZE_GIB = 1024 * 1024;
export const MAX_RUN_SIZE_NOTE_LENGTH = 1000;

export const idParamSchema = z.object({ id: z.string().uuid() });

export const continueSchema = z.object({
  note: z.string().trim().max(MAX_RUN_SIZE_NOTE_LENGTH).nullish(),
});

export const raiseSchema = z.object({
  limitGib: z.number().positive().max(MAX_RUN_SIZE_GIB),
});

const gib = z.number().min(0).max(MAX_RUN_SIZE_GIB);

/**
 * An override as an administrator saves it, sizes in GiB: any subset; what is left out comes
 * from the layer below (the tenant's, then the defaults). `null` for a size: none.
 */
export const overrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    factor: z.number().min(RUN_SIZE_FACTOR_RANGE.min).max(RUN_SIZE_FACTOR_RANGE.max).optional(),
    minGib: gib.optional(),
    limitGib: gib.nullable().optional(),
    firstRunGib: gib.nullable().optional(),
    minFreePercent: z.number().min(0).max(RUN_SIZE_FREE_PERCENT_MAX).optional(),
  })
  .strict();

export const settingsSchema = z
  .object({
    kind: z.enum(RUN_SIZE_OBJECT_KINDS).optional(),
    objectId: z.string().uuid().optional(),
    /** null clears the override. */
    override: overrideSchema.nullable(),
  })
  .refine((value) => (value.kind === undefined) === (value.objectId === undefined), {
    message: "kind and objectId go together",
  });

const bytes = (value: number | null | undefined) =>
  value === undefined ? undefined : value === null ? null : Math.round(value * GIB);

/** The stored override (@restow/core RunSizeGuardOverride, bytes) from the request's GiB. */
export function overrideFromRequest(input: z.infer<typeof overrideSchema>) {
  const out: Record<string, unknown> = {};
  if (input.enabled !== undefined) out.enabled = input.enabled;
  if (input.factor !== undefined) out.factor = input.factor;
  if (input.minGib !== undefined) out.minBytes = bytes(input.minGib);
  if (input.limitGib !== undefined) out.limitBytes = bytes(input.limitGib);
  if (input.firstRunGib !== undefined) out.firstRunBytes = bytes(input.firstRunGib);
  if (input.minFreePercent !== undefined) out.minFreePercent = input.minFreePercent;
  return out;
}

export function gibToBytes(value: number): number {
  return Math.round(value * GIB);
}
