import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { Failure } from "@/features/failures/api";
import { i18n } from "@/i18n";

import { directoryKeys } from "./api";
import "./i18n";
import { ObjectsPanel } from "./objects-panel";
import { toObjectsQuery } from "./search";
import type { DirectorySource, ObjectsPage, ProtectedObject } from "./types";

/**
 * The objects table, rendered to static markup with the query cache
 * pre-filled (a query's data is available synchronously from the cache on
 * mount, before any network request the test never lets run): the "Not
 * selected" status for a `selected`-mode object that nothing chose, and the
 * checkbox column that appears once the view is scoped to one source.
 */

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));

// The job link of a failed backup becomes a plain anchor, so the table renders without a router.
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

function object(overrides: Partial<ProtectedObject> = {}): ProtectedObject {
  return {
    id: "o-1",
    sourceId: "s-1",
    sourceName: "Contoso",
    sourceKind: "m365",
    kind: "mailbox",
    origin: "directory_sync",
    status: "active",
    externalId: "user-1",
    displayName: "Alice Example",
    userId: "u-1",
    email: "alice@contoso.example",
    upn: "alice@contoso.example",
    sharedOrBlocked: false,
    override: null,
    notSelected: false,
    lastBackupAt: null,
    snapshotCount: 0,
    latestBackupJob: null,
    readiness: null,
    credential: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function source(overrides: Partial<DirectorySource> = {}): DirectorySource {
  return {
    id: "s-1",
    name: "Contoso",
    kind: "m365",
    status: "active",
    errorMessage: null,
    failure: null,
    lastSyncAt: null,
    consentGranted: true,
    rules: null,
    overrideCount: 0,
    sync: { lastRun: null, lastFullSyncAt: null, fullSyncPending: false, pendingJob: null },
    imapAuthMode: null,
    counts: { total: 10, active: 7, excluded: 3, orphaned: 0, mailbox: 8, onedrive: 2, imap: 0 },
    ...overrides,
  };
}

function render(page: ObjectsPage, sources: readonly DirectorySource[]): string {
  const client = new QueryClient();
  const query = toObjectsQuery({});
  client.setQueryData(directoryKeys.objectsPage("t-1", query), page);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <TooltipProvider delayDuration={200}>
          <ObjectsPanel
            search={{}}
            onSearchChange={() => {}}
            sources={sources}
            onShowSources={() => {}}
          />
        </TooltipProvider>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("ObjectsPanel", () => {
  it("shows 'Not selected' rather than 'Excluded' for a selected-mode default", () => {
    const html = render(
      {
        items: [object({ status: "excluded", notSelected: true })],
        total: 1,
        page: 1,
        pageSize: 25,
      },
      [source()],
    );
    expect(html).toContain("Not selected");
    expect(html).not.toContain(">Excluded<");
  });

  it("shows a protected-of-total count from the sources it knows about", () => {
    const html = render({ items: [object()], total: 1, page: 1, pageSize: 25 }, [source()]);
    expect(html).toContain("7 of 10 protected");
  });

  it("offers row checkboxes once the view is scoped to one source", () => {
    const html = render({ items: [object()], total: 1, page: 1, pageSize: 25 }, [source()]);
    expect(html).toContain('data-slot="checkbox"');
  });

  it("hides checkboxes when several sources are in view and none is chosen", () => {
    const html = render({ items: [object()], total: 1, page: 1, pageSize: 25 }, [
      source(),
      source({ id: "s-2", name: "Fabrikam" }),
    ]);
    expect(html).not.toContain('data-slot="checkbox"');
  });
});

/** The opening tag of the filter trigger that carries this accessible name. */
function triggerTag(html: string, label: string): string {
  const tags = html.match(/<button[^>]*data-slot="select-trigger"[^>]*>/g) ?? [];
  const tag = tags.find((candidate) => candidate.includes(`aria-label="${label}"`));
  if (!tag) {
    throw new Error(`no filter trigger named ${label}`);
  }
  return tag;
}

/** The width of a trigger at the `sm` breakpoint in px (Tailwind `sm:w-48` is 12rem = 192px). */
function triggerWidth(tag: string): number {
  const width = tag.match(/\bsm:w-(\d+)\b/);
  if (!width) {
    throw new Error(`no sm width in ${tag}`);
  }
  return Number(width[1]) * 4;
}

describe("the filter row", () => {
  // Radix clamps the selected value to one line with an ellipsis, so a trigger
  // narrower than its longest label cuts it off ("Shared and persona…"). Width
  // of the label at 14px, the chevron (16px), the gap (8px), the horizontal
  // padding (24px) and the border (2px) are what a trigger needs.
  const CHARACTER_PX = 7.6;
  const CHROME_PX = 16 + 8 + 24 + 2;
  const needed = (labels: readonly string[]) =>
    Math.ceil(Math.max(...labels.map((label) => label.length)) * CHARACTER_PX) + CHROME_PX;

  const FILTERS = [
    {
      name: "kind",
      keys: ["objects.filters.allKinds", "kind.mailbox", "kind.onedrive", "kind.imap"],
    },
    {
      name: "status",
      keys: [
        "objects.filters.allStatuses",
        "status.active",
        "status.excluded",
        "status.not_selected",
        "status.orphaned",
      ],
    },
    {
      name: "shared",
      keys: [
        "objects.filters.sharedAll",
        "objects.filters.sharedOnly",
        "objects.filters.sharedExcluded",
      ],
    },
  ] as const;

  for (const language of ["en", "de"] as const) {
    it(`leaves each ${language} filter room for its longest label`, async () => {
      await i18n.changeLanguage(language);
      const html = render({ items: [object()], total: 1, page: 1, pageSize: 25 }, [source()]);
      for (const filter of FILTERS) {
        const labels = filter.keys.map((key) => i18n.t(`directory:${key}`));
        const label = i18n.t(`directory:objects.filters.${filter.name}`);
        const width = triggerWidth(triggerTag(html, label));
        expect(width, `${language} ${filter.name}: ${labels.join(" | ")}`).toBeGreaterThanOrEqual(
          needed(labels),
        );
      }
    });
  }

  it("gives the long shared filter a row of its own on a phone, where two filters share one", () => {
    const html = render({ items: [object()], total: 1, page: 1, pageSize: 25 }, [source()]);
    const tag = triggerTag(html, "Shared or blocked");
    expect(tag).toMatch(/\bcol-span-2\b/);
    expect(tag).toMatch(/\bsm:col-span-1\b/);
  });
});

const DOCS = "https://docs.example.test/troubleshooting";

const accessDenied: Failure = {
  code: "graph.access_denied",
  category: "microsoft",
  transient: false,
  retryable: true,
  params: { permission: "Mail.ReadWrite" },
  technical: { httpStatus: 403 },
  occurredAt: "2026-09-28T04:00:00.000Z",
  step: "download",
  retry: null,
  steps: [{ id: "verify_permissions", target: "source" }],
  docsUrl: DOCS,
};

const authFailed: Failure = {
  code: "imap.auth_failed",
  category: "imap",
  transient: false,
  retryable: true,
  params: { host: "imap.example.com" },
  technical: { imapResponse: "AUTHENTICATIONFAILED" },
  occurredAt: "2026-09-28T04:00:00.000Z",
  step: null,
  retry: null,
  steps: [{ id: "set_object_password", target: "directory" }],
  docsUrl: DOCS,
};

function page(...items: ProtectedObject[]): ObjectsPage {
  return { items, total: items.length, page: 1, pageSize: 25 };
}

function failedBackup(failure: Failure | null): ProtectedObject {
  return object({
    latestBackupJob: {
      id: "job-7",
      status: "failed",
      at: "2026-09-28T04:00:00.000Z",
      failure,
    },
  });
}

function failedLogin(failure: Failure | null): ProtectedObject {
  return object({
    sourceKind: "imap",
    kind: "imap",
    externalId: "alice@hoster.example",
    displayName: "Alice",
    credential: {
      authMode: "per_mailbox",
      hasPassword: true,
      status: "failed",
      checkedAt: "2026-09-28T04:00:00.000Z",
      error: "Authentication failed for alice",
      errorReason: "auth",
      failure,
    },
  });
}

describe("ObjectsPanel failure causes", () => {
  it("names the cause of a failed backup and links to its job", () => {
    const html = render(page(failedBackup(accessDenied)), [source()]);
    expect(html).toContain("Last run failed");
    expect(html).toContain('data-cause="graph.access_denied"');
    expect(html).toContain("Microsoft denied access to this mailbox or drive");
    expect(html).toContain('href="/history/job-7"');
    expect(html).toContain("Open run");
  });

  it("names the cause of a failed backup in German", async () => {
    await i18n.changeLanguage("de");
    const html = render(page(failedBackup(accessDenied)), [source()]);
    expect(html).toContain("Letzter Lauf fehlgeschlagen");
    expect(html).toContain(
      "Microsoft hat den Zugriff auf dieses Postfach oder Laufwerk verweigert",
    );
    expect(html).toContain("Lauf öffnen");
    expect(html).toContain('href="/history/job-7"');
  });

  it("looks as before for a failed backup without a classified cause", () => {
    const html = render(page(failedBackup(null)), [source()]);
    expect(html).toContain("Last run failed");
    expect(html).not.toContain("data-cause");
    expect(html).not.toContain("Open run");
  });

  it("does not show a cause for a backup that did not fail", () => {
    const html = render(
      page(
        object({
          latestBackupJob: {
            id: "job-8",
            status: "completed",
            at: "2026-09-28T04:00:00.000Z",
            failure: accessDenied,
          },
          lastBackupAt: "2026-09-28T04:00:00.000Z",
          snapshotCount: 3,
        }),
      ),
      [source()],
    );
    expect(html).not.toContain("data-cause");
  });

  it("names the cause of a failed login test and offers its explanation", () => {
    const html = render(page(failedLogin(authFailed)), [source()]);
    expect(html).toContain("Login failed");
    expect(html).toContain('data-cause="imap.auth_failed"');
    expect(html).toContain("The IMAP server refused the login");
    // The explanation opens on demand.
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("What to do");
  });

  it("names the cause of a failed login test in German", async () => {
    await i18n.changeLanguage("de");
    const html = render(page(failedLogin(authFailed)), [source()]);
    expect(html).toContain("Anmeldung fehlgeschlagen");
    expect(html).toContain("Der IMAP-Server hat die Anmeldung abgelehnt");
  });

  it("looks as before for a failed login test without a classified cause", () => {
    const html = render(page(failedLogin(null)), [source()]);
    expect(html).toContain("Login failed");
    expect(html).not.toContain("data-cause");
    expect(html).not.toContain('aria-haspopup="dialog"');
  });

  it("shows no cause for a login that works, whatever an old row still carries", () => {
    const working = failedLogin(authFailed);
    const html = render(
      page({
        ...working,
        credential: working.credential && { ...working.credential, status: "ok" },
      }),
      [source()],
    );
    expect(html).toContain("Login works");
    expect(html).not.toContain("data-cause");
  });
});
