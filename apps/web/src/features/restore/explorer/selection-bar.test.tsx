import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import { EMPTY_SELECTION, selectionOf } from "../lib/selection.js";
import { SelectionBar } from "./selection-bar.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const selection = selectionOf({
  path: "Mail/Inbox",
  kind: "folder",
  itemId: null,
  subject: null,
  size: 0,
});

function render(onExport?: () => void): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <SelectionBar
        selection={selection}
        onClear={() => undefined}
        onRestore={() => undefined}
        onDownload={() => undefined}
        onExport={onExport}
      />
    </I18nextProvider>,
  );
}

describe("SelectionBar", () => {
  it("offers restore, download and, for mail, export", () => {
    const html = render(() => undefined);
    expect(html).toContain("Restore …");
    expect(html).toContain("Download");
    expect(html).toContain("Export …");
  });

  it("leaves export out where mail cannot be exported (OneDrive)", () => {
    const html = render(undefined);
    expect(html).toContain("Restore …");
    expect(html).not.toContain("Export …");
  });

  it("counts the selection", () => {
    expect(render()).toContain("1 entry selected");
    expect(EMPTY_SELECTION.size).toBe(0);
  });
});
