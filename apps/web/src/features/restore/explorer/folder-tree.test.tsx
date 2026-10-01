import { beforeAll, describe, expect, it, vi } from "vitest";

import { render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";

import type { TreeEntry } from "../api.js";
import { FolderTree } from "./folder-tree.js";

const levels = vi.hoisted(() => new Map<string, unknown[]>());

vi.mock("@/features/restore/use-restore-data", () => ({
  useFolders: (_snapshotId: string | null, path: string) => {
    const entries = levels.get(path) ?? [];
    return { isPending: false, isError: false, data: { entries, total: entries.length } };
  },
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function folder(path: string, name: string): TreeEntry {
  return {
    id: path,
    kind: "folder",
    name,
    path,
    parentPath: "",
    size: 0,
    mtime: null,
    itemId: null,
    deleted: false,
    implicit: false,
    mail: null,
    contentType: null,
  };
}

const object = { kind: "imap" as const, displayName: "anna@example.com", externalId: "anna" };

describe("FolderTree", () => {
  it("says so when an expanded folder has no subfolders", () => {
    levels.clear();
    levels.set("", [folder("Archive", "Archive")]);
    levels.set("Archive", []);
    const html = render(
      <FolderTree snapshotId="s1" object={object} currentPath="Archive" onOpen={() => {}} />,
    );
    expect(html).toContain("Archive");
    expect(html).toContain("No subfolders");
  });

  it("says so when the account has no folders at all", () => {
    levels.clear();
    const html = render(
      <FolderTree snapshotId="s1" object={object} currentPath="" onOpen={() => {}} />,
    );
    expect(html).toContain("No folders");
    expect(html).not.toContain("No subfolders");
  });
});
