import { describe, expect, it } from "vitest";

import { labelKey, targetLabelOf, targetsByType } from "./labels.js";

const OBJECT = "9F4C9001-6772-43C6-8670-233E0D7C536D";
const TENANT = "3c1f0a52-7d0e-4c1b-9f3a-2b6c8d9e0f11";

describe("targetsByType", () => {
  it("groups UUID targets of nameable types and ignores everything else", () => {
    const grouped = targetsByType([
      { target: OBJECT, targetType: "protected_object" },
      { target: OBJECT.toLowerCase(), targetType: "protected_object" },
      { target: TENANT, targetType: "tenant" },
      { target: "all", targetType: "tenant" },
      { target: "AAMkAGI2", targetType: "manifest_object" },
      { target: null, targetType: "source" },
      { target: TENANT, targetType: null },
    ]);
    expect(grouped.get("protected_object")).toEqual([OBJECT.toLowerCase()]);
    expect(grouped.get("tenant")).toEqual([TENANT]);
    expect(grouped.has("source")).toBe(false);
    expect([...grouped.keys()]).not.toContain("manifest_object");
  });
});

describe("targetLabelOf", () => {
  it("finds a label regardless of the id's case and falls back to null", () => {
    const labels = new Map([[labelKey("protected_object", OBJECT), "Buchhaltung"]]);
    expect(targetLabelOf({ target: OBJECT, targetType: "protected_object" }, labels)).toBe(
      "Buchhaltung",
    );
    expect(
      targetLabelOf({ target: OBJECT.toLowerCase(), targetType: "protected_object" }, labels),
    ).toBe("Buchhaltung");
    expect(targetLabelOf({ target: TENANT, targetType: "tenant" }, labels)).toBeNull();
    expect(targetLabelOf({ target: null, targetType: "tenant" }, labels)).toBeNull();
  });
});

describe("export targets", () => {
  it("are nameable by their export id", () => {
    const grouped = targetsByType([{ target: OBJECT, targetType: "export_job" }]);
    expect(grouped.get("export_job")).toEqual([OBJECT.toLowerCase()]);
    const labels = new Map([[labelKey("export_job", OBJECT), "Anna"]]);
    expect(targetLabelOf({ target: OBJECT, targetType: "export_job" }, labels)).toBe("Anna");
  });
});

describe("import targets", () => {
  const IMPORT = "5b0a77d2-0c9a-4e0f-8c64-1f2d3a4b5c6d";
  const UPLOAD = "a4c19e6b-93d0-41d7-a8f2-7e60b1c2d3e4";

  it("are nameable by the import and the upload id", () => {
    const grouped = targetsByType([
      { target: IMPORT, targetType: "mail_import" },
      { target: UPLOAD, targetType: "import_upload" },
    ]);
    expect(grouped.get("mail_import")).toEqual([IMPORT]);
    expect(grouped.get("import_upload")).toEqual([UPLOAD]);
  });

  it("use the resolved name first", () => {
    const labels = new Map([[labelKey("mail_import", IMPORT), "Anna Example"]]);
    expect(
      targetLabelOf(
        { target: IMPORT, targetType: "mail_import", details: { name: "Old name" } },
        labels,
      ),
    ).toBe("Anna Example");
  });

  it("fall back to the name the entry recorded when the row is gone", () => {
    const labels = new Map<string, string>();
    expect(
      targetLabelOf(
        { target: IMPORT, targetType: "mail_import", details: { name: "  Anna Example " } },
        labels,
      ),
    ).toBe("Anna Example");
    expect(
      targetLabelOf(
        { target: UPLOAD, targetType: "import_upload", details: { fileName: "archive.mbox" } },
        labels,
      ),
    ).toBe("archive.mbox");
  });

  it("keep no label when there is nothing readable to show", () => {
    const labels = new Map<string, string>();
    expect(targetLabelOf({ target: IMPORT, targetType: "mail_import" }, labels)).toBeNull();
    expect(
      targetLabelOf({ target: IMPORT, targetType: "mail_import", details: { name: "" } }, labels),
    ).toBeNull();
    expect(
      targetLabelOf({ target: IMPORT, targetType: "mail_import", details: { name: 7 } }, labels),
    ).toBeNull();
    // A detail that names something else on another kind of target is not a label.
    expect(
      targetLabelOf({ target: OBJECT, targetType: "snapshot", details: { name: "x" } }, labels),
    ).toBeNull();
  });
});

describe("protected object targets named by their kind", () => {
  it("group under the kind the audit entry carries", () => {
    const grouped = targetsByType([
      { target: OBJECT, targetType: "mailbox" },
      { target: TENANT, targetType: "imap" },
      { target: OBJECT, targetType: "onedrive" },
    ]);
    expect(grouped.get("mailbox")).toEqual([OBJECT.toLowerCase()]);
    expect(grouped.get("imap")).toEqual([TENANT]);
    expect(grouped.get("onedrive")).toEqual([OBJECT.toLowerCase()]);
  });
});

describe("machine targets", () => {
  it("are nameable by their endpoint id", () => {
    expect(targetsByType([{ target: OBJECT, targetType: "endpoint" }]).get("endpoint")).toEqual([
      OBJECT.toLowerCase(),
    ]);
  });
});
