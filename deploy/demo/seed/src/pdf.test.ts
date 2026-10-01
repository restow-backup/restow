import { describe, expect, it } from "vitest";
import { buildPdf } from "./pdf.js";

describe("buildPdf", () => {
  it("starts with the PDF header and ends with %%EOF", () => {
    const pdf = buildPdf(["Rechnung RE-2024-0001"]);
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("is deterministic for the same input", () => {
    expect(buildPdf(["a", "b"])).toEqual(buildPdf(["a", "b"]));
  });

  it("points startxref at a real 'xref' keyword", () => {
    const pdf = buildPdf(["one line"]);
    const text = pdf.toString("latin1");
    const startxrefMatch = /startxref\n(\d+)\n%%EOF/.exec(text);
    expect(startxrefMatch).not.toBeNull();
    const offset = Number(startxrefMatch?.[1]);
    expect(text.slice(offset, offset + 4)).toBe("xref");
  });

  it("gives every object offset a matching 'N 0 obj' at that position", () => {
    const pdf = buildPdf(["line one", "line two", "line three"]);
    const text = pdf.toString("latin1");
    const xrefBody = /xref\n0 (\d+)\n((?:\d{10} \d{5} [fn] \n)+)/.exec(text);
    expect(xrefBody).not.toBeNull();
    const count = Number(xrefBody?.[1]);
    const entries = (xrefBody?.[2] ?? "").trim().split("\n");
    expect(entries).toHaveLength(count);
    // Entry 0 is the free-list head; entries 1..N-1 are real objects.
    for (let objectId = 1; objectId < count; objectId++) {
      const offset = Number(entries[objectId]?.slice(0, 10));
      expect(text.slice(offset, offset + String(objectId).length + 6)).toBe(`${objectId} 0 obj`);
    }
  });

  it("escapes parentheses and backslashes in the printed text", () => {
    const pdf = buildPdf(["Betrag (netto): 100\\00"]);
    const text = pdf.toString("latin1");
    expect(text).toContain("Betrag \\(netto\\): 100\\\\00");
  });

  it("sets /Length to the exact byte length of the content stream", () => {
    const pdf = buildPdf(["short"]);
    const text = pdf.toString("latin1");
    const match = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(text);
    expect(match).not.toBeNull();
    const declared = Number(match?.[1]);
    const stream = match?.[2] ?? "";
    expect(Buffer.byteLength(stream, "latin1")).toBe(declared);
  });
});
