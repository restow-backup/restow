/**
 * The report frame and the table across pages: the running footer with
 * "page x of y" on every page, the table header repeated on every page the
 * table spans (and only there), and text outside the standard fonts'
 * character set replaced visibly instead of garbled.
 */
import { Text } from "@react-pdf/renderer";
import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { Section } from "./blocks.js";
import { ReportDocument, ReportHeader, ReportPage } from "./document.js";
import { renderPdf } from "./render.js";
import { ReportTable } from "./table.js";

interface Row {
  id: number;
  name: string;
}

describe("report layout", () => {
  it("repeats the footer on every page and the table header on the table's pages", async () => {
    const rows: Row[] = Array.from({ length: 90 }, (_, id) => ({ id, name: `Mailbox ${id}` }));
    const after = Array.from({ length: 60 }, (_, index) => `Closing note ${index}`);
    const buffer = await renderPdf(
      <ReportDocument title="Layout" author="Restow" language="en" createdAt={new Date(0)}>
        <ReportPage
          footer="Restow layout test"
          pageLabel={(page, total) => `Page ${page} of ${total}`}
        >
          <ReportHeader eyebrow="Restow" title="Layout" subtitle="東京 office" meta={["Line"]} />
          <Section title="Mailboxes">
            <ReportTable
              rows={rows}
              rowKey={(row) => String(row.id)}
              empty="No rows"
              columns={[
                { header: "Mailbox name", weight: 3, cell: (row) => row.name },
                { header: "Number", weight: 1, align: "right", cell: (row) => String(row.id) },
              ]}
            />
          </Section>
          {after.map((line) => (
            <Text key={line}>{line}</Text>
          ))}
        </ReportPage>
      </ReportDocument>,
    );
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    expect(totalPages).toBeGreaterThanOrEqual(3);

    const lastRowPage = text.findIndex((page) => page.includes("Mailbox 89"));
    text.forEach((page, index) => {
      expect(page).toContain(`Page ${index + 1} of ${totalPages}`);
      expect(page).toContain("Restow layout test");
      expect(page.includes("Mailbox name")).toBe(index <= lastRowPage);
    });
    expect(text.at(-1)).toContain("Closing note 59");
    expect(text[0]).toContain("?? office");
  });

  it("says so when a table has no rows", async () => {
    const buffer = await renderPdf(
      <ReportDocument title="Empty" author="Restow" language="de" createdAt={new Date(0)}>
        <ReportPage footer="Restow" pageLabel={(page, total) => `Seite ${page} von ${total}`}>
          <ReportTable<Row>
            rows={[]}
            rowKey={(row) => String(row.id)}
            empty="Keine Einträge in diesem Zeitraum."
            columns={[{ header: "Name", weight: 1, cell: (row) => row.name }]}
          />
        </ReportPage>
      </ReportDocument>,
    );
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    expect(totalPages).toBe(1);
    expect(text).toContain("Keine Einträge in diesem Zeitraum.");
    expect(text).toContain("Seite 1 von 1");
  });
});
