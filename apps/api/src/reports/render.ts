import { renderToBuffer } from "@react-pdf/renderer";
import type { ReactElement } from "react";

/**
 * Render a report document to PDF bytes, in the api process. The layout
 * engine uses the standard PDF fonts only; no font, image or other asset is
 * fetched, so rendering works offline and leaks nothing.
 */

type DocumentElement = Parameters<typeof renderToBuffer>[0];

/**
 * Render an element whose root is a `<Document>`: the element itself, or a
 * component that renders one (ReportDocument in document.tsx).
 */
export async function renderPdf(document: ReactElement): Promise<Buffer> {
  return renderToBuffer(document as DocumentElement);
}

/** The media type of a rendered report. */
export const PDF_CONTENT_TYPE = "application/pdf";
