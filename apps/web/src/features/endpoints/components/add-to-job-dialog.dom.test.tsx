// @vitest-environment happy-dom
import { act } from "react";
import type * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { endpointJob, list } from "@/features/backup-jobs/fixtures";
import { adminSession } from "@/features/backup-jobs/testing";
import {
  type Mounted,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  mount,
  newQueryClient,
  problem,
  routedFetch,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/api";

import "../i18n.js";
import { AddToJobDialog } from "./add-to-job-dialog.js";

// The "Create a job" link becomes a plain anchor, so the dialog renders outside a router.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      children,
      ...props
    }: { to: string; search?: Record<string, unknown>; children: React.ReactNode }) => (
      <a href={`${to}?${new URLSearchParams(search as Record<string, string>)}`} {...props}>
        {children}
      </a>
    ),
  };
});

/**
 * "Add to job" for a machine without backup (release 0.2.1): the machine jobs to pick from, the
 * request that adds the machine, and the question when another administrator was faster.
 */

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const MACHINE = { id: "11111111-1111-4111-8111-111111111111", name: "web-01" };

async function open(routes: Parameters<typeof routedFetch>[0]) {
  const { mock, requests } = routedFetch({
    "GET /setup/state": () =>
      json({ configured: true, demo: { enabled: false, email: null, password: null } }),
    ...routes,
  });
  vi.stubGlobal("fetch", mock);
  const queryClient = newQueryClient();
  queryClient.setQueryData(queryKeys.setupState, {
    configured: true,
    demo: { enabled: false, email: null, password: null },
  });
  const onOpenChange = vi.fn();
  mounted = mount(<AddToJobDialog open onOpenChange={onOpenChange} endpoints={[MACHINE]} />, {
    session: adminSession(),
    queryClient,
  });
  await flush(6);
  return { requests, onOpenChange };
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    (element as HTMLElement).click();
  });
  await flush(6);
}

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );

describe("AddToJobDialog", () => {
  it("lists the machine jobs and adds the machine to the one chosen", async () => {
    const { requests, onOpenChange } = await open({
      "GET /backup-jobs": () =>
        json(list([endpointJob(), endpointJob({ id: "job-mac", name: "Macs, on connect" })])),
      "POST /backup-jobs/job-mac/members": () => json(endpointJob({ id: "job-mac" })),
    });
    const dialog = document.querySelector('[data-slot="add-to-job-dialog"]') as HTMLElement;
    expect(dialog.textContent).toContain("Choose the backup job for web-01");
    expect(dialog.textContent).toContain("Linux servers, daily");
    expect(dialog.textContent).toContain("Macs, on connect");
    // Nothing is chosen yet.
    expect(button("Add")?.disabled).toBe(true);
    await click(document.querySelector("#add-to-job-job-mac"));
    await click(button("Add"));
    const added = requests.find((request) => request.method === "POST");
    expect(added).toMatchObject({
      path: "/backup-jobs/job-mac/members",
      body: { members: [{ id: MACHINE.id }] },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("asks before it moves a machine another administrator put into a job meanwhile", async () => {
    let calls = 0;
    const { requests } = await open({
      "GET /backup-jobs": () => json(list([endpointJob()])),
      "POST /backup-jobs/job-srv/members": () => {
        calls++;
        return calls === 1
          ? problem("urn:restow:problem:backup-job-member-in-other-job", 409, {
              conflicts: [{ targetId: MACHINE.id, jobId: "job-x", jobName: "Old servers" }],
            })
          : json(endpointJob());
      },
    });
    await click(document.querySelector("#add-to-job-job-srv"));
    await click(button("Add"));
    const conflict = document.querySelector('[data-slot="add-to-job-conflict"]');
    expect(conflict?.textContent).toContain("Old servers");
    await click(button("Move here"));
    const posts = requests.filter((request) => request.method === "POST");
    expect(posts.map((request) => request.body)).toEqual([
      { members: [{ id: MACHINE.id }] },
      { members: [{ id: MACHINE.id }], move: true },
    ]);
  });

  it("leads to a new job with the machine chosen when there is no job yet", async () => {
    await open({ "GET /backup-jobs": () => json(list([])) });
    const empty = document.querySelector('[data-slot="add-to-job-empty"]') as HTMLElement;
    expect(empty.textContent).toContain("There is no job for servers and clients yet");
    const link = empty.querySelector("a");
    expect(link?.getAttribute("href")).toBe(`/jobs?type=endpoint&new=1&select=${MACHINE.id}`);
    expect(button("Add")).toBeUndefined();
  });
});
