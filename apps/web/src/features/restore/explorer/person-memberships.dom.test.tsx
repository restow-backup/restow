// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  enableActEnvironment,
  installMemoryStorage,
  json,
  type Mounted,
  mount,
  problem,
  sessionAs,
  waitFor,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import type { PersonMembership, SnapshotObject } from "../api.js";
import { PersonMemberships } from "./person-memberships.js";

/**
 * The "Teams & sites" area of a person's entry (#89): the group mailboxes and sites the person
 * owns or belongs to, with the role, a page at a time from the API, each leading to the object's
 * own restore points; a failed read says so and can be retried, an empty list says why.
 */

enableActEnvironment();

let mounted: Mounted | null = null;
const asked: URL[] = [];

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
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
    ownerKey: null,
    own: false,
    snapshotCount: 2,
    latestSnapshotId: "s",
    latestSnapshotAt: "2026-10-20T10:00:00.000Z",
    readiness: "green",
    ...over,
  };
}

function membership(index: number, over: Partial<PersonMembership> = {}): PersonMembership {
  return {
    role: "member",
    object: object({
      id: `o${index}`,
      kind: index % 2 === 0 ? "site" : "group",
      displayName: `Team ${String(index).padStart(3, "0")}`,
    }),
    ...over,
  };
}

/** The memberships endpoint over `items`, `pageSize` at a time. */
function stubMemberships(items: PersonMembership[], pageSize = 25) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    asked.push(url);
    const start = Number(url.searchParams.get("after") ?? 0);
    return json({
      key: url.searchParams.get("key"),
      items: items.slice(start, start + pageSize),
      total: items.length,
      next: start + pageSize < items.length ? String(start + pageSize) : null,
    });
  });
}

const slots = (name: string) => [
  ...document.querySelectorAll<HTMLElement>(`[data-slot="${name}"]`),
];

describe("a person's Teams and sites", () => {
  it("lists the group mailboxes and sites with the role, and opens one on its restore points", async () => {
    stubMemberships([
      membership(0, {
        role: "owner",
        object: object({ id: "site-1", kind: "site", displayName: "Projekt Nordlicht" }),
      }),
      membership(1, {
        object: object({
          id: "group-1",
          kind: "group",
          displayName: "Vertrieb",
          status: "excluded",
          snapshotCount: 0,
          latestSnapshotId: null,
          latestSnapshotAt: null,
          readiness: "no_backup",
        }),
      }),
      membership(2, {
        object: object({ id: "site-2", kind: "site", displayName: "Alt", status: "orphaned" }),
      }),
    ]);
    const onOpen = vi.fn();
    mounted = mount(<PersonMemberships personKey="user:u1" onOpen={onOpen} />, {
      session: SESSION,
    });
    await waitFor(() => slots("person-membership").length === 3, { what: "the memberships" });
    expect(asked[0]?.pathname).toBe("/api/v1/snapshots/people/memberships");
    expect(asked[0]?.searchParams.get("key")).toBe("user:u1");
    expect(document.querySelector("h3")?.textContent).toBe("Teams & sites");

    const [site, group, gone] = slots("person-membership");
    expect(site?.textContent).toContain("Projekt Nordlicht");
    expect(site?.textContent).toContain("SharePoint site");
    expect(site?.textContent).toContain("Owner");
    expect(site?.getAttribute("aria-label")).toBe("Open the restore points of Projekt Nordlicht");
    expect(group?.textContent).toContain("Member");
    expect(group?.textContent).toContain("No backup yet");
    expect(gone?.textContent).toContain("Removed");
    // A role is no proof of anything: neutral, never green.
    const owner = [...document.querySelectorAll('[data-slot="badge"]')].find(
      (node) => node.textContent === "Owner",
    );
    expect(owner?.getAttribute("data-tone")).toBe("neutral");
    expect(document.querySelector('[data-tone="success"]')).toBeNull();

    await act(async () => site?.click());
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "site-1", kind: "site" }));
  });

  it("loads the next page on request, never all of them at once", async () => {
    stubMemberships(Array.from({ length: 60 }, (_, index) => membership(index)));
    mounted = mount(<PersonMemberships personKey="user:u1" onOpen={() => {}} />, {
      session: SESSION,
    });
    await waitFor(() => slots("person-membership").length === 25, { what: "the first page" });
    expect(slots("person-memberships-more")[0]?.textContent).toBe("Show 35 more");
    await act(async () => slots("person-memberships-more")[0]?.click());
    await waitFor(() => slots("person-membership").length === 50, { what: "the second page" });
    expect(asked.map((url) => url.searchParams.get("after"))).toEqual([null, "25"]);
    await act(async () => slots("person-memberships-more")[0]?.click());
    await waitFor(() => slots("person-membership").length === 60, { what: "the last page" });
    expect(slots("person-memberships-more")).toHaveLength(0);
  });

  it("says why the list is empty", async () => {
    stubMemberships([]);
    mounted = mount(<PersonMemberships personKey="user:u1" onOpen={() => {}} />, {
      session: SESSION,
    });
    await waitFor(() => slots("person-memberships-empty").length === 1, { what: "the empty text" });
    expect(slots("person-memberships-empty")[0]?.textContent).toContain(
      "No Teams or sites are known for this person",
    );
  });

  it("says that the list could not be loaded, and loads it on retry", async () => {
    let failing = true;
    vi.stubGlobal("fetch", async () =>
      failing
        ? problem("urn:restow:problem:internal", 500)
        : json({ key: "user:u1", items: [membership(1)], total: 1, next: null }),
    );
    mounted = mount(<PersonMemberships personKey="user:u1" onOpen={() => {}} />, {
      session: SESSION,
    });
    await waitFor(() => document.querySelector('[role="alert"]') !== null, { what: "the error" });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("could not be loaded");
    failing = false;
    const retry = document.querySelector<HTMLButtonElement>('[role="alert"] button');
    await act(async () => retry?.click());
    await waitFor(() => slots("person-membership").length === 1, { what: "the list after retry" });
  });
});
