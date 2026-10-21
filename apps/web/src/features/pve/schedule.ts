import "@/features/schedules/i18n";

import {
  type CadenceDraft,
  cadenceDraftFrom,
  checkCadence,
  newCadenceDraft,
} from "@/features/schedules/presenters";
import {
  PRESET_TYPES,
  type PresetType,
  presetFromCadence,
  type StoredCadence,
} from "@/features/schedules/presets";

import type { PveJobSchedule } from "./api.js";

/**
 * A Proxmox VE job's schedule in the cadence form the mail jobs use (features/schedules): every
 * few hours, daily, on chosen weekdays, monthly, or a cron expression. The server plans them
 * with `pveNextRunAt` (@restow/core); a backup more often than hourly is not offered (the server
 * refuses intervals under 60 minutes).
 */

/** The presets a PVE job offers: all but "every few minutes". */
export const PVE_PRESET_TYPES: readonly PresetType[] = PRESET_TYPES.filter(
  (type) => type !== "every_minutes",
);

/** The stored cadence of a PVE schedule; a daily time is the cron expression it stands for. */
export function cadenceOfPveSchedule(schedule: PveJobSchedule): StoredCadence {
  if (schedule.kind === "interval") {
    return { intervalMinutes: schedule.intervalMinutes ?? 24 * 60, cron: null };
  }
  if (schedule.kind === "cron") {
    return { intervalMinutes: null, cron: schedule.cron ?? "" };
  }
  const [hh, mm] = (schedule.timeOfDay ?? "22:00").split(":");
  return { intervalMinutes: null, cron: `${Number(mm)} ${Number(hh)} * * *` };
}

/** The form state of a job's schedule; a new job starts daily at 22:00. */
export function pveCadenceDraft(schedule: PveJobSchedule | null, zone: string): CadenceDraft {
  if (!schedule) {
    return cadenceDraftFrom({ intervalMinutes: null, cron: "0 22 * * *" }, zone);
  }
  return cadenceDraftFrom(cadenceOfPveSchedule(schedule), schedule.timeZone || zone);
}

/** The PVE schedule a draft describes, or null while a field needs correcting. */
export function pveScheduleOfDraft(draft: CadenceDraft): PveJobSchedule | null {
  const check = checkCadence(draft);
  if (!check.ok) {
    return null;
  }
  const { cadence } = check;
  if (cadence.intervalMinutes !== null) {
    return { kind: "interval", intervalMinutes: cadence.intervalMinutes, timeZone: draft.timezone };
  }
  const preset = presetFromCadence(cadence);
  if (preset.type === "daily") {
    // A daily time stays `daily`, as every server version reads it.
    const pad = (value: number) => String(value).padStart(2, "0");
    return {
      kind: "daily",
      timeOfDay: `${pad(preset.hour)}:${pad(preset.minute)}`,
      timeZone: draft.timezone,
    };
  }
  return { kind: "cron", cron: cadence.cron ?? "", timeZone: draft.timezone };
}

export { newCadenceDraft };
