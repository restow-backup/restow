// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  type Mounted,
  mount,
  sessionAs,
  waitFor,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import type { PersonEntry, SnapshotObject } from "../api.js";
import { AccountList, SEARCH_DEBOUNCE_MS } from "./account-list.js";

/**
 * The explorer's left column as a person meets it: people with their mailbox and OneDrive as one
 * entry, sites apart, a deleted account marked, the list loaded a page at a time from the API,
 * and the search asked of the API once the typing stops.
 */

enableActEnvironment();

let mounted: Mounted | null = null;
const asked: URL[] = [];

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
  const proto = Element.prototype as { scrollIntoView?: () => void };
  proto.scrollIntoView ??= () => {};
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  asked.length = 0;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const SESSION = sessionAs({
  role: "tenant_admin",
  isProviderAdmin: false,
  activeTenant: {
    id: "t1",
    name: "Müller GmbH",
    slug: "mueller",
    kind: "customer",
    customerNumber: null,
    role: "tenant_admin",
    status: "active",
  },
});

function object(
  over: Partial<SnapshotObject> & Pick<SnapshotObject, "id" | "kind">,
): SnapshotObject {
  return {
    externalId: over.id,
    displayName: null,
    status: "active",
    sourceKind: "m365",
    ownerEmail: null,
    own: false,
    snapshotCount: 1,
    latestSnapshotId: "s",
    latestSnapshotAt: "2026-09-20T10:00:00.000Z",
    readiness: "green",
    ...over,
  };
}

function person(index: number, over: Partial<PersonEntry> = {}): PersonEntry {
  const name = `Person ${String(index).padStart(4, "0")}`;
  return {
    key: `user:u${index}`,
    name,
    address: `p${index}@example.com`,
    own: false,
    accountDeleted: false,
    objects: [object({ id: `m${index}`, kind: "mailbox", displayName: name })],
    ...over,
  };
}

const CARLA = person(1, {
  name: "Carla Weber",
  address: "carla@example.com",
  own: true,
  objects: [
    object({ id: "m-carla", kind: "mailbox", displayName: "Carla Weber", own: true }),
    object({ id: "d-carla", kind: "onedrive", displayName: "Carla Weber", readiness: "yellow" }),
  ],
});
const DIETER = person(2, {
  name: "Dieter Former",
  address: "dieter@example.com",
  accountDeleted: true,
  objects: [object({ id: "d-dieter", kind: "onedrive", status: "orphaned" })],
});
const SITE: PersonEntry = {
  key: "site:s1",
  name: "Projekt Nordlicht",
  address: null,
  own: false,
  accountDeleted: false,
  objects: [object({ id: "s1", kind: "site", displayName: "Projekt Nordlicht" })],
};

/** The people endpoint over `people`, `pageSize` at a time, searched by name. */
function stubPeople(people: PersonEntry[], sites: PersonEntry[] = [], pageSize = 50) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    asked.push(url);
    const list = url.searchParams.get("section") === "sites" ? sites : people;
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const matching = list.filter((entry) => entry.name.toLowerCase().includes(q));
    const start = Number(url.searchParams.get("after") ?? 0);
    const items = matching.slice(start, start + pageSize);
    return json({
      section: url.searchParams.get("section"),
      items,
      total: matching.length,
      next: start + pageSize < matching.length ? String(start + pageSize) : null,
    });
  });
}

const slots = (name: string) => [
  ...document.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];

describe("the people list", () => {
  it("shows a person's mailbox and OneDrive as one entry, a deleted account marked, sites apart", async () => {
    stubPeople([CARLA, DIETER], [SITE]);
    mounted = mount(<AccountList value="m-carla" onChange={() => {}} />, { session: SESSION });
    await waitFor(() => slots("account-person").length === 2, { what: "the people" });
    const [carla, dieter] = slots("account-person");
    expect(carla?.textContent).toContain("Carla Weber");
    expect(carla?.textContent).toContain("Yours");
    expect(carla?.querySelector('[data-slot="account-address"]')?.textContent).toBe(
      "Mailbox, OneDrive · carla@example.com",
    );
    // The least proven of the person's restore points: the OneDrive's.
    expect(carla?.textContent).toContain("Attention");
    expect(carla?.getAttribute("aria-current")).toBe("true");
    expect(dieter?.textContent).toContain("Account deleted");
    // Sites and Microsoft 365 group mailboxes share the heading (0.4.5).
    expect(
      document.querySelector('[data-slot="account-sites"] [cmdk-group-heading]')?.textContent,
    ).toBe("SharePoint & Teams");
    expect(slots("account-site").map((node) => node.textContent)).toEqual([
      expect.stringContaining("Projekt Nordlicht"),
    ]);
    // Protected is a state, not a proof: neutral, never green.
    const badge = [...document.querySelectorAll('[data-slot="badge"]')].find(
      (node) => node.textContent === "Protected",
    );
    expect(badge?.getAttribute("data-tone")).toBe("neutral");
  });

  it("opens a person on their first area", async () => {
    stubPeople([CARLA]);
    const onChange = vi.fn();
    mounted = mount(<AccountList value={null} onChange={onChange} />, { session: SESSION });
    await waitFor(() => slots("account-person").length === 1, { what: "the person" });
    await act(async () => slots("account-person")[0]?.click());
    expect(onChange).toHaveBeenCalledWith("m-carla", "mail");
  });

  it("loads the next page on request, never everyone at once", async () => {
    const many = Array.from({ length: 120 }, (_, index) => person(index + 10));
    stubPeople(many);
    mounted = mount(<AccountList value={null} onChange={() => {}} />, { session: SESSION });
    await waitFor(() => slots("account-person").length === 50, { what: "the first page" });
    expect(slots("account-more")[0]?.textContent).toBe("Show 70 more");
    await act(async () => slots("account-more")[0]?.click());
    await waitFor(() => slots("account-person").length === 100, { what: "the second page" });
    const pages = asked.filter((url) => url.searchParams.get("section") === "people");
    expect(pages.map((url) => url.searchParams.get("after"))).toEqual([null, "50"]);
    await act(async () => slots("account-more")[0]?.click());
    await waitFor(() => slots("account-person").length === 120, { what: "the last page" });
    expect(slots("account-more")).toHaveLength(0);
  });

  it("asks the API once the typing stops, not at every key", async () => {
    stubPeople(Array.from({ length: 30 }, (_, index) => person(index)));
    mounted = mount(<AccountList value={null} onChange={() => {}} />, { session: SESSION });
    await waitFor(() => slots("account-person").length === 30, { what: "the people" });
    const input = document.querySelector<HTMLInputElement>('[data-slot="command-input"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    for (const typed of ["0", "00", "000", "0012"]) {
      await act(async () => {
        setter?.call(input, typed);
        input?.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 100));
    });
    await flush(4);
    await waitFor(() => slots("account-person").length === 1, { what: "the search result" });
    const searched = asked
      .filter((url) => url.searchParams.get("section") === "people")
      .map((url) => url.searchParams.get("q"));
    expect(searched).toEqual([null, "0012"]);
    expect(slots("account-person")[0]?.textContent).toContain("Person 0012");
  });
});
