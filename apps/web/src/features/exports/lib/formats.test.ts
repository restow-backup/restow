import { describe, expect, it } from "vitest";

import type { ExportFormatInfo } from "@/features/exports/api";
import { defaultFormat, formatAvailable, formatChoices } from "@/features/exports/lib/formats";

const AS_SHIPPED: ExportFormatInfo[] = [
  { id: "eml_zip", available: true },
  { id: "mbox", available: true },
  { id: "msg_zip", available: false, reason: "not evaluated yet" },
  { id: "pst", available: false, planned: true, reason: "planned for a later release" },
];

describe("formatChoices", () => {
  it("offers nothing while the formats are not known", () => {
    expect(formatChoices(undefined)).toEqual([]);
  });

  it("lists EML and MBOX, hides MSG that the server cannot write, and shows PST as planned", () => {
    expect(formatChoices(AS_SHIPPED)).toEqual([
      { id: "eml_zip", available: true, planned: false },
      { id: "mbox", available: true, planned: false },
      { id: "pst", available: false, planned: true },
    ]);
  });

  it("offers MSG once the server reports it as available", () => {
    const formats = AS_SHIPPED.map((info) =>
      info.id === "msg_zip" ? { id: "msg_zip" as const, available: true } : info,
    );
    expect(formatChoices(formats).map((choice) => choice.id)).toEqual([
      "eml_zip",
      "mbox",
      "msg_zip",
      "pst",
    ]);
  });

  it("never enables PST unless the server says so, and shows it even when the server omits it", () => {
    expect(formatChoices([{ id: "eml_zip", available: true }]).at(-1)).toEqual({
      id: "pst",
      available: false,
      planned: true,
    });
    expect(
      formatChoices([{ id: "pst", available: false, planned: true }]).find(
        (choice) => choice.id === "pst",
      )?.available,
    ).toBe(false);
  });

  it("keeps an unavailable core format visible but not selectable", () => {
    const choices = formatChoices([
      { id: "eml_zip", available: false },
      { id: "mbox", available: true },
    ]);
    expect(choices[0]).toEqual({ id: "eml_zip", available: false, planned: false });
    expect(defaultFormat(choices)).toBe("mbox");
  });
});

describe("defaultFormat and formatAvailable", () => {
  const choices = formatChoices(AS_SHIPPED);

  it("opens with EML in a ZIP", () => {
    expect(defaultFormat(choices)).toBe("eml_zip");
  });

  it("has no default when nothing can be chosen", () => {
    expect(defaultFormat([])).toBeNull();
  });

  it("accepts only formats that are listed and available", () => {
    expect(formatAvailable(choices, "mbox")).toBe(true);
    expect(formatAvailable(choices, "pst")).toBe(false);
    expect(formatAvailable(choices, "msg_zip")).toBe(false);
    expect(formatAvailable(choices, null)).toBe(false);
  });
});
