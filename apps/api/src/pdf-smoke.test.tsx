/**
 * Smoke test of the PDF toolchain the API's reports are built on
 * (docs/STACK.md, PDF reports): @react-pdf/renderer lays out a React
 * component tree into a PDF inside the api process, with the built-in fonts
 * only, and unpdf reads the pages and the text back, which is how the report
 * tests check what a rendered report says.
 */
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";

const styles = StyleSheet.create({
  page: { padding: 48, fontFamily: "Helvetica", fontSize: 11 },
  title: { fontSize: 18, fontFamily: "Helvetica-Bold", marginBottom: 16 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
});

/** A one-page report in the shape the real ones take: a title and key figures. */
function SmokeReport({ rows }: { rows: [string, string][] }) {
  return (
    <Document title="Restow smoke report" author="Restow" creator="Restow">
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>Recovery readiness</Text>
        {rows.map(([label, value]) => (
          <View key={label} style={styles.row}>
            <Text>{label}</Text>
            <Text>{value}</Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}

describe("PDF rendering", () => {
  it("renders a one-page A4 report whose text can be read back", async () => {
    const rows: [string, string][] = [
      ["Tenant", "Contoso Zürich"],
      ["Protected mailboxes", "250"],
      ["Verified items", "1,024"],
    ];
    const buffer = await renderToBuffer(<SmokeReport rows={rows} />);

    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    expect(pdf.numPages).toBe(1);
    const viewport = (await pdf.getPage(1)).getViewport({ scale: 1 });
    // A4 in PostScript points.
    expect(Math.round(viewport.width)).toBe(595);
    expect(Math.round(viewport.height)).toBe(842);

    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    expect(totalPages).toBe(1);
    for (const fragment of ["Recovery readiness", ...rows.flat()]) {
      expect(text).toContain(fragment);
    }
  });
});
