import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import { RulesSheet } from "./rules-sheet";
import type { DirectorySource, ProtectionRules } from "./types";

/**
 * The rules sheet's three scope modes, rendered to static markup (server
 * rendering has no document to portal the sheet into, so its Radix dialog
 * portal is swapped for one that renders in place — everything else is the
 * production path). Interaction (clicking a radio, saving) is out of scope
 * here; ./presenters.test.ts covers the pure decisions the form makes.
 */

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const ALL_RULES: ProtectionRules = {
  mode: "all",
  groupId: null,
  groupName: null,
  exclude: ["scanner@contoso.example"],
  includeSharedMailboxes: true,
};

function sourceWith(rules: ProtectionRules): DirectorySource {
  return {
    id: "s-1",
    name: "Contoso",
    kind: "m365",
    status: "active",
    errorMessage: null,
    failure: null,
    lastSyncAt: null,
    consentGranted: true,
    rules,
    overrideCount: 0,
    sync: { lastRun: null, lastFullSyncAt: null, fullSyncPending: false, pendingJob: null },
    imapAuthMode: null,
    counts: { total: 0, active: 0, excluded: 0, orphaned: 0, mailbox: 0, onedrive: 0, imap: 0 },
  };
}

function render(source: DirectorySource): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <RulesSheet source={source} open onOpenChange={() => {}} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("RulesSheet", () => {
  it("offers all three scope modes", () => {
    const html = render(sourceWith(ALL_RULES));
    expect(html).toContain("Everyone in the directory");
    expect(html).toContain("Members of one group");
    expect(html).toContain("Only selected objects");
  });

  it("shows the exclusion list and shared-mailbox switch in `all` mode", () => {
    const html = render(sourceWith(ALL_RULES));
    expect(html).toContain("Exclusion list");
    expect(html).toContain("Include shared and blocked mailboxes");
  });

  it("hides the exclusion list and the shared-mailbox switch in `selected` mode and explains the mode instead", () => {
    const html = render(sourceWith({ ...ALL_RULES, mode: "selected", exclude: [] }));
    expect(html).not.toContain("Exclusion list");
    expect(html).not.toContain("Include shared and blocked mailboxes");
    expect(html).toContain("Nobody is protected until an admin explicitly includes");
    expect(html).toContain("Choose what to protect from the Objects tab");
  });
});
