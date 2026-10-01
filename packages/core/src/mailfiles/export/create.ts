/** One entry point for the coordinator: the writer that belongs to an export format. */
import { createEmlZip } from "./eml-zip.js";
import { isExportFormatAvailable } from "./formats.js";
import type { ExportFormatId } from "./formats.js";
import { createMbox } from "./mbox.js";
import type { ExportMessage, ExportOptions, ExportResult } from "./types.js";

/** Start an export in `format`. Throws for a format that is not available. */
export function createExport(
  format: ExportFormatId,
  messages: AsyncIterable<ExportMessage> | Iterable<ExportMessage>,
  options: ExportOptions = {},
): ExportResult {
  if (!isExportFormatAvailable(format)) {
    throw new Error(`the export format ${format} is not available`);
  }
  switch (format) {
    case "eml_zip":
      return createEmlZip(messages, options);
    case "mbox":
      return createMbox(messages, options);
    default:
      throw new Error(`the export format ${format} is not available`);
  }
}
