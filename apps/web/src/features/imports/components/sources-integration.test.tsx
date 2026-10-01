// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DeleteSourceDialog } from "@/features/sources/components/delete-source-dialog";
import { SourceCard } from "@/features/sources/components/source-card";
import type { SourceDto } from "@/features/sources/types";
import { i18n } from "@/i18n";

import { mount, text } from "../testing/dom";
import { ImportSourcePanel } from "./import-source-panel";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({
      children,
      className,
      to,
    }: { children: ReactNode; className?: string; to: string }) => (
      <a className={className} href={String(to)}>
        {children}
      </a>
    ),
  };
});

const importSource: SourceDto = {
  id: "s-import",
  tenantId: "t1",
  kind: "import",
  name: "Imported mail files",
  status: "active",
  errorMessage: null,
  failure: null,
  lastSyncAt: null,
  createdAt: "2026-09-30T09:00:00.000Z",
  updatedAt: "2026-09-30T09:00:00.000Z",
  m365: null,
  imap: null,
  importedMailboxes: 3,
};

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the import source in the sources list", () => {
  it("counts the imported mailboxes and shows no connection status", () => {
    const view = mount(<SourceCard source={importSource} />);
    const content = text(view.container);
    expect(content).toContain("Imported mail files");
    expect(content).toContain("3 imported mailboxes");
    expect(content).not.toContain("Connected");
    expect(content).not.toContain("not tested");
    view.unmount();
  });

  it("says so when nothing was imported yet", () => {
    const view = mount(<SourceCard source={{ ...importSource, importedMailboxes: 0 }} />);
    expect(text(view.container)).toContain("No imported mailboxes yet");
    view.unmount();
  });

  it("uses the singular for one mailbox", () => {
    const view = mount(<SourceCard source={{ ...importSource, importedMailboxes: 1 }} />);
    expect(text(view.container)).toContain("1 imported mailbox");
    expect(text(view.container)).not.toContain("1 imported mailboxes");
    view.unmount();
  });
});

describe("the import source panel", () => {
  it("links to the wizard and to the history and offers no connection test", () => {
    const view = mount(<ImportSourcePanel mailboxes={3} />);
    expect(text(view.container)).toContain("Imported mail files");
    expect(text(view.container)).toContain("3");
    expect(text(view.container)).toContain("imported mailboxes");
    expect(view.container.querySelector('a[href="/sources/import"]')).not.toBeNull();
    expect(view.container.querySelector('a[href="/imports"]')).not.toBeNull();
    expect(text(view.container)).not.toContain("Test connection");
    view.unmount();
  });
});

describe("deleting the import source", () => {
  it("warns that the imported mailboxes and their snapshots go with it", () => {
    const view = mount(<DeleteSourceDialog open onOpenChange={() => {}} source={importSource} />);
    expect(document.body.textContent).toContain(
      "removed together with all imported mailboxes and their snapshots",
    );
    expect(document.body.textContent).not.toContain("stored credentials");
    view.unmount();
  });
});
