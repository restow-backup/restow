// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { detail } from "../testing/fixtures";
import { buildReportJson, downloadTextFile, reportFileName } from "./download";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reportFileName", () => {
  it("makes a safe name from the mailbox name and the day", () => {
    const day = new Date("2026-09-30T10:00:00.000Z");
    expect(reportFileName("Mail archive 2019", day)).toBe(
      "import-report-mail-archive-2019-2026-09-30.json",
    );
    expect(reportFileName("../../etc/passwd", day)).toBe(
      "import-report-etc-passwd-2026-09-30.json",
    );
    expect(reportFileName("Ärger & Übel", day)).toMatch(
      /^import-report-[a-z0-9-]+-2026-09-30\.json$/,
    );
    expect(reportFileName("***", day)).toBe("import-report-mailbox-2026-09-30.json");
  });
});

describe("buildReportJson", () => {
  it("holds the request and the report, and nothing about the person", () => {
    const parsed = JSON.parse(buildReportJson(detail()));
    expect(parsed.name).toBe("Mail archive 2019");
    expect(parsed.report.totals.messages).toBe(1204);
    expect(parsed.report.items).toHaveLength(3);
    expect(parsed.files).toHaveLength(2);
    expect(JSON.stringify(parsed)).not.toContain("lena@acme.example");
  });
});

describe("downloadTextFile", () => {
  it("hands the text to the browser as a named file", async () => {
    const created: Blob[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: (blob: Blob) => {
        created.push(blob);
        return "blob:test";
      },
      revokeObjectURL: vi.fn(),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    downloadTextFile("report.json", '{"a":1}');
    expect(click).toHaveBeenCalledOnce();
    expect(created).toHaveLength(1);
    expect(await created[0]?.text()).toBe('{"a":1}');
    expect(created[0]?.type).toContain("application/json");
    vi.unstubAllGlobals();
  });
});
