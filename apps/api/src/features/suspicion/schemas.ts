import {
  RANSOMWARE_SETTING_RANGES,
  type RansomwareSettingKey,
  SUSPICION_OBJECT_KINDS,
} from "@restow/core";
import { z } from "zod";

/** Request schemas of the ransomware detection (docs/RANSOMWARE.md). */

export const MAX_FALSE_ALARM_NOTE_LENGTH = 1000;

export const objectQuerySchema = z.object({
  kind: z.enum(SUSPICION_OBJECT_KINDS),
  objectId: z.string().uuid(),
});

export const idParamSchema = z.object({ id: z.string().uuid() });

export const falseAlarmSchema = z.object({
  note: z.string().trim().max(MAX_FALSE_ALARM_NOTE_LENGTH).nullish(),
});

/** Releasing an object's retention hold, or calling all its held findings a false alarm. */
export const holdActionSchema = z.object({
  kind: z.enum(SUSPICION_OBJECT_KINDS),
  objectId: z.string().uuid(),
  note: z.string().trim().max(MAX_FALSE_ALARM_NOTE_LENGTH).nullish(),
});

function inRange(key: RansomwareSettingKey, integer = false) {
  const [min, max] = RANSOMWARE_SETTING_RANGES[key];
  const number = z.number().min(min).max(max);
  return (integer ? number.int() : number).optional();
}

/**
 * The installation's thresholds as an owner saves them: any subset, every number in its range
 * (@restow/core RANSOMWARE_SETTING_RANGES). What is left out takes its default.
 */
export const ransomwareSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    baselineRuns: inRange("baselineRuns", true),
    minBaselineRuns: inRange("minBaselineRuns", true),
    changeRate: z
      .object({
        enabled: z.boolean().optional(),
        madFactor: inRange("changeRate.madFactor"),
        minRatio: inRange("changeRate.minRatio"),
        minItems: inRange("changeRate.minItems", true),
        minBytes: inRange("changeRate.minBytes", true),
      })
      .strict()
      .optional(),
    deletions: z
      .object({
        enabled: z.boolean().optional(),
        minFiles: inRange("deletions.minFiles", true),
        minShare: inRange("deletions.minShare"),
      })
      .strict()
      .optional(),
    renames: z
      .object({
        enabled: z.boolean().optional(),
        minFiles: inRange("renames.minFiles", true),
        minShare: inRange("renames.minShare"),
      })
      .strict()
      .optional(),
    names: z
      .object({
        enabled: z.boolean().optional(),
        minExtensionFiles: inRange("names.minExtensionFiles", true),
        minNoteCopies: inRange("names.minNoteCopies", true),
      })
      .strict()
      .optional(),
    entropy: z
      .object({
        enabled: z.boolean().optional(),
        minSamples: inRange("entropy.minSamples", true),
        highBits: inRange("entropy.highBits"),
        minHighShare: inRange("entropy.minHighShare"),
      })
      .strict()
      .optional(),
    compressibility: z
      .object({
        enabled: z.boolean().optional(),
        minBytes: inRange("compressibility.minBytes", true),
        madFactor: inRange("compressibility.madFactor"),
        compressionMinRatio: inRange("compressibility.compressionMinRatio"),
        compressionMinRise: inRange("compressibility.compressionMinRise"),
        dedupMinRatio: inRange("compressibility.dedupMinRatio"),
        dedupMinRise: inRange("compressibility.dedupMinRise"),
      })
      .strict()
      .optional(),
    retentionHold: z
      .object({
        enabled: z.boolean().optional(),
        reminderDays: inRange("retentionHold.reminderDays", true),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RansomwareSettingsInput = z.infer<typeof ransomwareSettingsSchema>;
