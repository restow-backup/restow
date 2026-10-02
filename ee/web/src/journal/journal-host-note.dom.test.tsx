// @vitest-environment happy-dom
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ArchiveSections, ArchiveSettingsSections } from "../archive-sections";
import { JournalHostNote } from "./journal-host-note";

import {
  type Mounted,
  enableActEnvironment,
  flush,
  mount,
  newQueryClient,
  sessionAs,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { type JournalSetup, journalKeys } from "./api";

/**
 * The journal host on the tenant page (Archive settings): read-only, with where
 * it is set, only where the journal receiver exists and for the tenant's
 * administrator. The slot of the tenant page holds legal holds and this note;
 * the journal address itself stays on the daily Archive page.
 */

enableActEnvironment();

const TENANT = {
  id: "t-1",
  name: "Contoso",
  slug: "contoso",
  kind: "customer" as const,
  customerNumber: null,
  role: "tenant_admin" as const,
  status: "active" as const,
};

const SETUP: JournalSetup = {
  address: "journal+q2w3e4r5t6y7u8i9o2p3a4s5d6f7g2h3@archive.example.test",
  localPart: "journal+q2w3e4r5t6y7u8i9o2p3a4s5d6f7g2h3",
  hostname: "archive.example.test",
  hostnameIssue: null,
  status: "receiving",
  receiver: { listening: true, reason: null },
  lastReportAt: null,
  counts: { last24Hours: 0, last7Days: 0 },
  requirements: {
    dnsName: "archive.example.test",
    smtpPort: 25,
    exchangePort: 25,
    portMismatch: false,
    tlsConfigured: true,
    maxMessageMegabytes: 150,
  },
  docsUrl: "https://docs.example.test/",
};

let mounted: Mounted | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function show(
  node: React.ReactNode,
  session: Parameters<typeof sessionAs>[0],
  setup: JournalSetup | null = SETUP,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 })),
  );
  const queryClient = newQueryClient();
  if (setup) {
    queryClient.setQueryData(journalKeys.setup("t-1"), setup);
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  mounted = mount(<RouterProvider router={router} />, {
    session: sessionAs({ activeTenant: TENANT, tenants: [TENANT], ...session }),
    queryClient,
  });
  await flush(4);
}

const note = () => document.querySelector<HTMLElement>('[data-slot="journal-host"]');

describe("the journal host note", () => {
  it("shows the host with the way to where the installation sets it, to a provider admin on Business", async () => {
    await show(<JournalHostNote />, { extensions: { edition: "business" } });
    expect(note()?.textContent).toContain("archive.example.test");
    expect(note()?.querySelector("a")?.getAttribute("href")).toBe("/installation/journal");
  });

  it("tells a tenant administrator whom to ask instead of linking to a page they cannot open", async () => {
    await show(<JournalHostNote />, {
      extensions: { edition: "business" },
      isProviderAdmin: false,
      providerRole: null,
      role: "tenant_admin",
    });
    expect(note()?.textContent).toContain("archive.example.test");
    expect(note()?.querySelector("a")).toBeNull();
  });

  it("is absent on Community, where there is no journal receiver", async () => {
    await show(<JournalHostNote />, { extensions: { edition: "community" } });
    expect(note()).toBeNull();
  });
});

describe("the archive slots", () => {
  it("puts the journal address on the Archive page and legal holds with the host note into the settings", async () => {
    await show(<ArchiveSections />, { extensions: { edition: "business" } });
    expect(document.body.textContent).toContain("Exchange journaling");
    expect(note()).toBeNull();
    await mounted?.unmount();
    mounted = null;

    await show(<ArchiveSettingsSections />, { extensions: { edition: "business" } });
    expect(note()).not.toBeNull();
    expect(document.body.textContent).toContain("Legal holds");
    expect(document.body.textContent).not.toContain("Exchange journaling");
  });
});
