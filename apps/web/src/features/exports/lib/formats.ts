import type { ExportFormatId, ExportFormatInfo } from "@/features/exports/api";

/**
 * Which export formats the dialog shows and which of them can be chosen.
 * The API decides what is available; the dialog decides how to present it:
 * MBOX and EML are always listed, MSG only when the server can really write
 * it, and PST is always listed as planned (never faked).
 */

/** Display order of the formats. */
export const FORMAT_ORDER: readonly ExportFormatId[] = ["eml_zip", "mbox", "msg_zip", "pst"];

export interface FormatChoice {
  id: ExportFormatId;
  /** The format can be chosen. */
  available: boolean;
  /** The format is on the roadmap but does not exist yet. */
  planned: boolean;
}

/**
 * The formats to show for what the API listed. While nothing was listed yet
 * (loading or failed) there is nothing to choose, so the list is empty.
 */
export function formatChoices(formats: readonly ExportFormatInfo[] | undefined): FormatChoice[] {
  if (!formats) {
    return [];
  }
  const choices: FormatChoice[] = [];
  for (const id of FORMAT_ORDER) {
    const info = formats.find((candidate) => candidate.id === id);
    if (id === "msg_zip") {
      // Only offered once the server can really write it.
      if (info?.available) {
        choices.push({ id, available: true, planned: false });
      }
      continue;
    }
    if (id === "pst") {
      const available = info?.available === true;
      choices.push({ id, available, planned: !available });
      continue;
    }
    if (info) {
      choices.push({ id, available: info.available, planned: info.planned === true });
    }
  }
  return choices;
}

/** The format a dialog opens with: the first one that can be chosen (EML in a ZIP, normally). */
export function defaultFormat(choices: readonly FormatChoice[]): ExportFormatId | null {
  return choices.find((choice) => choice.available)?.id ?? null;
}

/** True when `format` is among the choices and can be picked. */
export function formatAvailable(
  choices: readonly FormatChoice[],
  format: ExportFormatId | null,
): boolean {
  return format !== null && choices.some((choice) => choice.id === format && choice.available);
}
