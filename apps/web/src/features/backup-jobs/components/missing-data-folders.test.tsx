import { beforeAll, describe, expect, it } from "vitest";

import { render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";

import "../i18n";
import { MissingDataFoldersNotice } from "./missing-data-folders";

/** The notice about data folders a machine job leaves out (#59). */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("MissingDataFoldersNotice", () => {
  it("names what a client-style job leaves out and offers to add it", () => {
    const html = render(
      <MissingDataFoldersNotice
        paths={["/etc", "/home", "/root", "/srv", "/var/www"]}
        onAdd={() => undefined}
      />,
    );
    expect(html).toContain("/opt, /usr/local, /var/lib, /var/backups");
    expect(html).toContain("Add these 4 folders");
  });

  it("explains a restore point without an add button", () => {
    const html = render(
      <MissingDataFoldersNotice paths={["/etc", "/home"]} context="restorePoint" />,
    );
    expect(html).toContain("This restore point does not contain every data folder");
    expect(html).not.toContain("<button");
  });

  it("says nothing when every data folder is covered", () => {
    expect(render(<MissingDataFoldersNotice paths={["/"]} />)).toBe("");
  });
});
