import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { Failure } from "@/features/failures/api";
import { i18n } from "@/i18n";

import "./i18n";
import { SourcesPanel } from "./sources-panel";
import type { DirectorySource, ProtectionRules } from "./types";

/**
 * The source card's rule summary, rendered to static markup (the sheet and
 * dialog it also mounts start closed, so no portal is needed). Regression
 * coverage for HIGH-2: a `selected`-mode source must not read as a `group`
 * source with an empty group, and must not show the shared-mailbox or
 * exclusion lines, which play no part in that mode.
 */

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));

// Steps of an explanation link into the app; plain anchors let the panel render without a router.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      className,
      children,
    }: { to: string; className?: string; children: React.ReactNode }) => (
      <a href={String(to)} className={className}>
        {children}
      </a>
    ),
  };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

function sourceWith(rules: ProtectionRules | null): DirectorySource {
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
    overrideCount: 4,
    sync: { lastRun: null, lastFullSyncAt: null, fullSyncPending: false, pendingJob: null },
    imapAuthMode: null,
    counts: { total: 10, active: 4, excluded: 6, orphaned: 0, mailbox: 8, onedrive: 2, imap: 0 },
  };
}

function query(sources: DirectorySource[]): UseQueryResult<DirectorySource[]> {
  return {
    data: sources,
    isPending: false,
    isError: false,
    error: null,
    isFetching: false,
    refetch: () => Promise.resolve(),
  } as unknown as UseQueryResult<DirectorySource[]>;
}

function render(sources: DirectorySource[]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <TooltipProvider delayDuration={200}>
          <SourcesPanel sources={query(sources)} onShowObjects={() => {}} />
        </TooltipProvider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("SourcesPanel", () => {
  it("describes a `selected`-mode source as such, not as an unnamed group", () => {
    const html = render([
      sourceWith({
        mode: "selected",
        groupId: null,
        groupName: null,
        exclude: ["stale@contoso.example"],
        includeSharedMailboxes: true,
      }),
    ]);
    expect(html).toContain("Only selected objects");
    expect(html).not.toContain("Members of the group");
    expect(html).not.toContain("Members of ");
  });

  it("hides the shared-mailbox and exclusion lines for a `selected`-mode source", () => {
    const html = render([
      sourceWith({
        mode: "selected",
        groupId: null,
        groupName: null,
        exclude: ["stale@contoso.example"],
        includeSharedMailboxes: true,
      }),
    ]);
    expect(html).not.toContain("Shared and blocked mailboxes");
    expect(html).not.toContain("exclusion");
    // The individual-decisions count still applies: it is exactly what populates this mode.
    expect(html).toContain("4 individual decisions");
  });

  it("still shows the group name and the shared/exclusion lines for a `group`-mode source", () => {
    const html = render([
      sourceWith({
        mode: "group",
        groupId: "g-1",
        groupName: "Backup users",
        exclude: ["scanner@contoso.example"],
        includeSharedMailboxes: false,
      }),
    ]);
    expect(html).toContain("Members of Backup users");
    expect(html).toContain("Shared and blocked mailboxes left out");
    expect(html).toContain("1 exclusion");
  });
});

const DOCS = "https://docs.example.test/troubleshooting";

const permissionMissing: Failure = {
  code: "graph.permission_missing",
  category: "microsoft",
  transient: false,
  retryable: true,
  params: { permission: "User.Read.All" },
  technical: { httpStatus: 403, requestId: "req-42" },
  occurredAt: "2026-09-28T04:00:00.000Z",
  step: null,
  retry: null,
  steps: [
    { id: "grant_permission", target: "source" },
    { id: "verify_permissions", target: "source" },
  ],
  docsUrl: DOCS,
};

const authFailed: Failure = {
  code: "imap.auth_failed",
  category: "imap",
  transient: false,
  retryable: true,
  params: { host: "imap.example.com" },
  technical: {},
  occurredAt: "2026-09-28T04:00:00.000Z",
  step: null,
  retry: null,
  steps: [{ id: "check_app_password", target: "source" }],
  docsUrl: DOCS,
};

/** A source whose last directory sync ended in an error. */
function failedSync(
  failure: Failure | null,
  overrides: Partial<DirectorySource> = {},
): DirectorySource {
  const base = sourceWith(null);
  return {
    ...base,
    ...overrides,
    sync: {
      lastRun: {
        startedAt: "2026-09-28T03:59:00.000Z",
        finishedAt: "2026-09-28T04:00:00.000Z",
        ok: false,
        mode: "incremental",
        counts: null,
        warnings: [],
        warningCount: 0,
        error: "Graph answered 403 Forbidden",
        failure,
      },
      lastFullSyncAt: null,
      fullSyncPending: false,
      pendingJob: null,
    },
  };
}

describe("SourcesPanel failure explanations", () => {
  it("explains a failed sync: what happened, why, what to do, docs link", () => {
    const html = render([failedSync(permissionMissing, { status: "error" })]);
    expect(html).toContain("The Restow app is missing a Microsoft 365 permission");
    expect(html).toContain("The last directory sync of Contoso failed");
    expect(html).toContain("User.Read.All");
    expect(html).toContain("What to do");
    expect(html).toContain("Add the application permission User.Read.All");
    expect(html).toContain(`href="${DOCS}"`);
    // The recorded text is a technical detail now, not a second alert.
    expect(html).not.toContain("Last sync failed");
    expect(html.split('data-slot="alert"').length - 1).toBe(1);
  });

  it("explains it in German", async () => {
    await i18n.changeLanguage("de");
    const html = render([failedSync(permissionMissing, { status: "error" })]);
    expect(html).toContain("Was passiert ist");
    expect(html).toContain("Der letzte Verzeichnisabgleich von Contoso ist");
    expect(html).toContain("Was zu tun ist");
    expect(html).toContain("Anleitung zur Fehlersuche");
    expect(html).not.toContain("What happened");
  });

  it("falls back to the cause of the source when the run has none of its own", () => {
    const html = render([failedSync(null, { status: "error", failure: permissionMissing })]);
    expect(html).toContain("The Restow app is missing a Microsoft 365 permission");
    expect(html).toContain("The last directory sync of Contoso failed");
  });

  it("explains a broken connection when the last sync itself was fine", () => {
    const base = sourceWith(null);
    const html = render([
      {
        ...base,
        status: "error",
        failure: permissionMissing,
        errorMessage: "Verification failed",
        sync: {
          lastRun: {
            startedAt: "2026-09-27T03:59:00.000Z",
            finishedAt: "2026-09-27T04:00:00.000Z",
            ok: true,
            mode: "incremental",
            counts: null,
            warnings: [],
            warningCount: 0,
            error: null,
            failure: null,
          },
          lastFullSyncAt: null,
          fullSyncPending: false,
          pendingJob: null,
        },
      },
    ]);
    expect(html).toContain("The connection to Contoso is broken");
    expect(html).not.toContain("The last directory sync of Contoso failed");
    // The successful run stays visible.
    expect(html).toContain("Last sync");
  });

  it("keeps the old alert and text for a failed run without a classified cause", () => {
    const html = render([failedSync(null)]);
    expect(html).toContain("Last sync failed");
    expect(html).toContain("Graph answered 403 Forbidden");
    expect(html).not.toContain("What happened");
    expect(html).not.toContain("Technical details");
  });

  it("keeps the old text in German for a failed run without a classified cause", async () => {
    await i18n.changeLanguage("de");
    const html = render([failedSync(null)]);
    expect(html).toContain("Letzter Abgleich");
    expect(html).toContain("Graph answered 403 Forbidden");
    expect(html).not.toContain("Was passiert ist");
  });

  it("shows nothing extra for a healthy source", () => {
    const html = render([sourceWith(null)]);
    expect(html).not.toContain("What happened");
    expect(html).not.toContain("data-cause");
  });

  it("names the cause of a broken IMAP source in one line and links to the source", () => {
    const imap: DirectorySource = {
      ...sourceWith(null),
      kind: "imap",
      name: "Hoster",
      status: "error",
      failure: authFailed,
      consentGranted: false,
      sync: null,
      imapAuthMode: "shared",
    };
    const html = render([imap]);
    expect(html).toContain('data-cause="imap.auth_failed"');
    expect(html).toContain("The IMAP server refused the login");
    expect(html).toContain('href="/sources/s-1"');
    expect(html).toContain("Open source");
    // A line, not the full explanation.
    expect(html).not.toContain("What to do");
  });

  it("shows nothing about the cause on an IMAP source that is fine", () => {
    const imap: DirectorySource = {
      ...sourceWith(null),
      kind: "imap",
      failure: null,
      consentGranted: false,
      sync: null,
      imapAuthMode: "shared",
    };
    const html = render([imap]);
    expect(html).not.toContain("data-cause");
    expect(html).toContain("IMAP servers have no directory");
  });
});
