// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buttonByText,
  click,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  problem,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { RUN_IDS, agentRun, detail, finished, run } from "../fixtures";
import "../i18n";
import { type Opened, openHistory } from "../testing";

/**
 * The page of one run, where an old `/jobs/<id>` leads: what the drawer shows, plus the failed
 * items of a mail run and the way to the machine of an agent run.
 */

enableActEnvironment();

let opened: Opened | null = null;

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await opened?.mounted.unmount();
  opened = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const text = () => document.body.textContent ?? "";
const page = () => document.querySelector<HTMLElement>('[data-slot="run-detail-page"]');

/** What `/jobs/<id>` answers for a mail run: its failed items. */
function jobDetail(id: string) {
  return {
    id,
    queue: "backup",
    status: "completed",
    protectedObjectId: "object-1",
    object: {
      id: "object-1",
      kind: "mailbox",
      displayName: "anna",
      externalId: "anna@x",
      status: "active",
    },
    scheduleId: null,
    full: false,
    createdAt: "2026-10-02T10:00:00.000Z",
    updatedAt: "2026-10-02T10:10:00.000Z",
    startedAt: "2026-10-02T10:00:01.000Z",
    completedAt: "2026-10-02T10:10:00.000Z",
    errorMessage: null,
    progress: null,
    phase: null,
    throttle: null,
    cancellable: false,
    retryable: false,
    failures: [
      {
        id: "f1",
        itemRef: "AAMkAD-item-1",
        reason: "Item too large",
        failure: null,
        attempts: 3,
        lastAttemptAt: null,
      },
    ],
    failureCount: 1,
    failureGroups: [],
    snapshot: null,
    result: null,
  };
}

describe("the page of a mail run", () => {
  it("shows the run like the drawer does and the failed items below", async () => {
    const done = detail(finished("partial", { id: RUN_IDS.mailDone }));
    opened = await openHistory(`/history/${RUN_IDS.mailDone}`, {
      routes: {
        [`GET /history/${RUN_IDS.mailDone}`]: () => json(done),
        [`GET /jobs/${RUN_IDS.mailDone}`]: () => json(jobDetail(RUN_IDS.mailDone)),
      },
    });
    await flush(8);
    expect(page()).not.toBeNull();
    expect(document.querySelector("h1")?.textContent).toBe("Backup · anna@contoso.example");
    expect(page()?.querySelector('[data-section="progress"]')).not.toBeNull();
    expect(page()?.querySelector('[data-section="stats"]')).not.toBeNull();
    expect(page()?.querySelector("[data-chart]")).not.toBeNull();
    expect(page()?.querySelector('[data-section="objects"]')).not.toBeNull();
    // The failed items of the mail run, from the job endpoint.
    expect(text()).toContain("AAMkAD-item-1");
    expect(text()).toContain("Item too large");
  });

  it("offers Retry on a failed mail run and does not offer Open in History on its own page", async () => {
    const failed = detail(
      finished("failed", { id: RUN_IDS.mailDone, errorMessage: "Mailbox not found" }),
    );
    opened = await openHistory(`/history/${RUN_IDS.mailDone}`, {
      routes: {
        [`GET /history/${RUN_IDS.mailDone}`]: () => json(failed),
        [`GET /jobs/${RUN_IDS.mailDone}`]: () =>
          json({ ...jobDetail(RUN_IDS.mailDone), failures: [], failureCount: 0 }),
        [`POST /jobs/${RUN_IDS.mailDone}/retry`]: () =>
          json({ id: "aaaaaaaa-0000-4000-8000-000000000000" }, 202),
      },
    });
    await flush(8);
    const labels = [...(page()?.querySelectorAll("button, a") ?? [])].map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).toContain("Retry");
    expect(labels).toContain("Edit job");
    expect(labels).not.toContain("Open in History");
    // The reason is explained, not just stated.
    expect(text()).toContain("Mailbox not found");
    await click(buttonByText(page() as HTMLElement, "Retry"));
    await flush(4);
    expect(
      opened.requests.some(
        (request) => request.method === "POST" && request.path.endsWith("/retry"),
      ),
    ).toBe(true);
  });

  it("says so when the run does not exist, or belongs to another tenant", async () => {
    opened = await openHistory(`/history/${RUN_IDS.mailDone}`, {
      routes: {
        [`GET /history/${RUN_IDS.mailDone}`]: () => problem("urn:restow:problem:not-found", 404),
      },
    });
    await flush(6);
    expect(text()).toContain("does not exist any more");
    expect(page()).toBeNull();
  });

  it("moves to another run of the wave with a click on its object", async () => {
    const done = detail(finished("succeeded", { id: RUN_IDS.mailDone }));
    opened = await openHistory(`/history/${RUN_IDS.mailDone}`, {
      routes: {
        [`GET /history/${RUN_IDS.mailDone}`]: () => json(done),
        [`GET /jobs/${RUN_IDS.mailDone}`]: () => json(jobDetail(RUN_IDS.mailDone)),
        "GET /history/66666666-6666-4666-8666-666666666666": () =>
          problem("urn:restow:problem:not-found", 404),
      },
    });
    await flush(8);
    const other = [...document.querySelectorAll('[data-section="objects"] li button')][0];
    await click(other);
    await flush(4);
    expect(opened.where().pathname).toBe("/history/66666666-6666-4666-8666-666666666666");
  });

  it("is live: an ended run shows no running state and a running one shows its throughput", async () => {
    const running = detail(run({ id: RUN_IDS.mailRunning }));
    opened = await openHistory(`/history/${RUN_IDS.mailRunning}`, {
      routes: {
        [`GET /history/${RUN_IDS.mailRunning}`]: () => json(running),
        [`GET /jobs/${RUN_IDS.mailRunning}`]: () =>
          json({ ...jobDetail(RUN_IDS.mailRunning), status: "active" }),
      },
    });
    await flush(8);
    expect(page()?.querySelector('[data-state="running"]')).not.toBeNull();
    expect(page()?.querySelector('[data-term="speed"]')?.textContent).toMatch(/[\d.,]+ [kKMG]B\/s/);
    const labels = [...(page()?.querySelectorAll("button, a") ?? [])].map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).toContain("Cancel run");
  });
});

describe("the page of an agent run", () => {
  it("links to the machine and offers no cancel: the agent owns its runs", async () => {
    const machine = detail(agentRun({ id: RUN_IDS.agentRunning }), {
      batch: null,
      objects: [],
      events: [],
    });
    opened = await openHistory(`/history/${RUN_IDS.agentRunning}`, {
      routes: { [`GET /history/${RUN_IDS.agentRunning}`]: () => json(machine) },
    });
    await flush(8);
    const links = [...(page()?.querySelectorAll("a") ?? [])];
    const machineLink = links.find((link) => link.textContent?.includes("Open machine"));
    expect(machineLink?.getAttribute("href")).toContain("/inventory/");
    const labels = [...(page()?.querySelectorAll("button, a") ?? [])].map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).not.toContain("Cancel run");
    // No request for the failed items of a mail run.
    expect(opened.requests.some((request) => request.path.startsWith("/jobs/"))).toBe(false);
  });
});
