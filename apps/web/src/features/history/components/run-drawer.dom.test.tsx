// @vitest-environment happy-dom
import { act } from "react";
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

import { type Run, historyKeys } from "../api";
import { RUN_IDS, agentRun, detail, finished, iso, run, samples } from "../fixtures";
import "../i18n";
import { type Opened, TENANT, adminSession, openHistory } from "../testing";

/**
 * The drawer a run opens in: reached by an address (`?run=<id>`), live while the run runs, closed
 * by Esc, by its button and by Back, with the focus moved into it and the actions of the run in
 * its footer.
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

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const section = (name: string) =>
  dialog()?.querySelector<HTMLElement>(`[data-section="${name}"]`) ?? null;
const text = () => dialog()?.textContent ?? "";

function routes(over: Record<string, () => Response> = {}) {
  const running = detail(run({ id: RUN_IDS.mailRunning }));
  const done = detail(finished("succeeded"), {
    batch: {
      total: 3,
      queued: 0,
      running: 0,
      succeeded: 3,
      partial: 0,
      failed: 0,
      cancelled: 0,
      truncated: false,
    },
  });
  return {
    [`GET /history/${RUN_IDS.mailRunning}`]: () => json(running),
    [`GET /history/${RUN_IDS.mailDone}`]: () => json(done),
    [`GET /history/${RUN_IDS.agentRunning}`]: () =>
      json(
        detail(agentRun(), {
          objects: [],
          batch: null,
          events: [],
          logTail: "agent: started backup\nagent: scanning /srv",
        }),
      ),
    ...over,
  };
}

async function open(id: string, over: Record<string, () => Response> = {}) {
  opened = await openHistory(`/host?run=${id}`, { routes: routes(over) });
  await flush(6);
  return opened;
}

describe("the run drawer opened by an address", () => {
  it("shows the run: who it is, its state, progress, three columns of numbers, charts, objects and timeline", async () => {
    await open(RUN_IDS.mailRunning);
    expect(dialog()).not.toBeNull();
    expect(dialog()?.getAttribute("data-slot")).toBe("run-drawer");
    // Header: the name, the scope and the state.
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Backup · anna@contoso.example");
    expect(text()).toContain("Mail backup");
    expect(dialog()?.querySelector('[data-state="running"]')?.textContent).toContain("Running");
    // Progress.
    expect(section("progress")?.textContent).toContain("40 %");
    // The step is named like the timeline names it, not by the engine's word.
    expect(section("progress")?.textContent).toContain("Step: Downloading");
    // The wave: two of the three mailboxes are done.
    expect(section("progress")?.textContent).toContain("2 of 3 mailboxes backed up");
    // The three columns.
    const stats = section("stats")?.textContent ?? "";
    for (const heading of ["Summary", "Data", "Result"]) {
      expect(stats).toContain(heading);
    }
    for (const label of [
      "Duration",
      "Processing",
      "Time left",
      "Processed",
      "New or changed",
      "Transferred",
      "Backed up",
      "Restore check",
      "Failed items",
    ]) {
      expect(stats).toContain(label);
    }
    // Two small charts on one axis.
    expect(section("charts")?.querySelectorAll("[data-chart]")).toHaveLength(2);
    // Objects of the wave, the opened one marked, and the timeline.
    const objects = [...(section("objects")?.querySelectorAll("li") ?? [])];
    expect(objects).toHaveLength(3);
    expect(objects[0]?.getAttribute("data-current")).toBe("true");
    expect(section("timeline")?.textContent).toContain("Run started");
  });

  it("says which attempt a retried restore check is, in the header", async () => {
    const retry = run({
      id: RUN_IDS.mailRunning,
      kind: "restore_check",
      type: "verify",
      state: "queued",
      attempt: { number: 3, of: 6 },
      startedAt: null,
      progress: null,
      samples: null,
      phase: null,
    });
    await open(RUN_IDS.mailRunning, {
      [`GET /history/${RUN_IDS.mailRunning}`]: () =>
        json(
          detail(retry, {
            objects: [],
            batch: null,
            restoreCheck: { state: "none", checkedAt: null, runId: null },
          }),
        ),
    });
    expect(dialog()?.textContent).toContain("Attempt 3 of 6");
    // Nothing of the restore check's result is known yet: a dash, not an empty cell.
    expect(section("stats")?.textContent).toContain("Restore check–");
  });

  it("opens with the focus inside, and closes on Escape, taking only the run out of the address", async () => {
    const page = await open(RUN_IDS.mailRunning);
    expect(dialog()?.contains(document.activeElement)).toBe(true);
    expect(page.where().search).toMatchObject({ run: RUN_IDS.mailRunning });
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await flush(4);
    expect(dialog()).toBeNull();
    expect(page.where().search.run).toBeUndefined();
  });

  it("closes with its own button as well", async () => {
    const page = await open(RUN_IDS.mailRunning);
    await click(buttonByText(dialog() as HTMLElement, "Close"));
    await flush(4);
    expect(dialog()).toBeNull();
    expect(page.where().search.run).toBeUndefined();
  });

  it("is named for assistive technology: a title and a description", async () => {
    await open(RUN_IDS.mailRunning);
    const labelled = dialog()?.getAttribute("aria-labelledby");
    const described = dialog()?.getAttribute("aria-describedby");
    expect(document.getElementById(labelled ?? "")?.textContent).toContain("Backup");
    expect(document.getElementById(described ?? "")?.textContent).toContain("Mail backup");
  });

  it("stays shut for an address that names no run, and says so for a run that does not exist", async () => {
    opened = await openHistory("/host?run=not-an-id", { routes: routes() });
    await flush(4);
    expect(dialog()).toBeNull();
    await opened.mounted.unmount();
    opened = null;
    await open("99999999-9999-4999-8999-999999999999", {
      "GET /history/99999999-9999-4999-8999-999999999999": () =>
        problem("urn:restow:problem:not-found", 404),
    });
    expect(text()).toContain("does not exist any more");
  });

  it("offers Cancel run for a run that runs, never Run now; and Run now for one that is over", async () => {
    await open(RUN_IDS.mailRunning);
    const labels = [...(dialog()?.querySelectorAll("button, a") ?? [])].map((node) =>
      node.textContent?.trim(),
    );
    expect(labels).toContain("Cancel run");
    expect(labels).toContain("Edit job");
    expect(labels).toContain("Open in History");
    expect(labels).not.toContain("Run now");
    await opened?.mounted.unmount();
    opened = null;
    await open(RUN_IDS.mailDone);
    const after = [...(dialog()?.querySelectorAll("button, a") ?? [])].map((node) =>
      node.textContent?.trim(),
    );
    expect(after).toContain("Run now");
    expect(after).not.toContain("Cancel run");
    // The restore check that passed is green, and the only green in the drawer.
    expect(dialog()?.querySelector('[data-check="passed"]')).not.toBeNull();
    expect(dialog()?.querySelector('[data-state="succeeded"]')?.getAttribute("data-tone")).toBe(
      "neutral",
    );
  });

  it("asks before cancelling and cancels the run", async () => {
    const page = await open(RUN_IDS.mailRunning, {
      [`POST /jobs/${RUN_IDS.mailRunning}/cancel`]: () => json({ id: RUN_IDS.mailRunning }),
    });
    await click(buttonByText(dialog() as HTMLElement, "Cancel run"));
    await flush(3);
    const confirm = document.querySelector('[role="alertdialog"]');
    expect(confirm?.textContent).toContain("Cancel this run?");
    // Nothing was sent before the answer.
    expect(page.requests.some((request) => request.path.endsWith("/cancel"))).toBe(false);
    await click(buttonByText(confirm as HTMLElement, "Cancel run"));
    await flush(4);
    expect(
      page.requests.some(
        (request) =>
          request.method === "POST" && request.path === `/jobs/${RUN_IDS.mailRunning}/cancel`,
      ),
    ).toBe(true);
  });

  it("links to the run's page and to its job", async () => {
    await open(RUN_IDS.mailRunning);
    const links = [...(dialog()?.querySelectorAll("a") ?? [])];
    expect(
      links.find((link) => link.textContent?.includes("Open in History"))?.getAttribute("href"),
    ).toBe(`/history/${RUN_IDS.mailRunning}`);
    const edit = links.find((link) => link.textContent?.includes("Edit job"));
    expect(edit?.getAttribute("href")).toContain(`/jobs/definitions/${RUN_IDS.jobMail}`);
    expect(edit?.getAttribute("href")).toContain("tab=settings");
  });
});

describe("the drawer is live", () => {
  it("moves with the channel: the numbers of a running run change without a request", async () => {
    const page = await open(RUN_IDS.mailRunning);
    const before = page.requests.filter((request) => request.path.startsWith("/history/")).length;
    expect(section("progress")?.textContent).toContain("40 %");
    const next: Run = run({
      id: RUN_IDS.mailRunning,
      updatedAt: iso(90),
      progress: {
        ...(run().progress as NonNullable<Run["progress"]>),
        percent: 61,
        itemsDone: 610,
        bytesProcessed: 640_000_000,
      },
      throughput: { processedBps: 12_000_000, transferredBps: 300_000 },
      samples: samples(45),
    });
    await act(async () => {
      page.queryClient.setQueryData(historyKeys.live(TENANT.id), { [RUN_IDS.mailRunning]: next });
      await Promise.resolve();
    });
    await flush(2);
    expect(section("progress")?.textContent).toContain("61 %");
    expect(section("stats")?.textContent).toContain("610 MB");
    expect(page.requests.filter((request) => request.path.startsWith("/history/")).length).toBe(
      before,
    );
  });

  it("shows what the agent is reading while an agent run runs", async () => {
    await open(RUN_IDS.agentRunning);
    expect(section("progress")?.textContent).toContain("/srv/data/archive/2025.db");
    expect(section("progress")?.textContent).toContain("25 %");
    // No objects to list for a machine outside any wave; and the agent's own log, tucked away.
    expect(section("objects")?.textContent).toContain("No objects to show");
    expect(section("timeline")?.querySelector("details pre")?.textContent).toContain(
      "scanning /srv",
    );
  });

  it("counts the duration on, once a second, while the run runs", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      vi.setSystemTime(new Date(Date.parse(iso(0)) + 10_000));
      await open(RUN_IDS.mailRunning);
      const duration = () => section("stats")?.querySelector('[data-term="duration"]')?.textContent;
      const first = duration();
      expect(first).toBe("0:10");
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(duration()).toBe("0:15");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the wave", () => {
  it("lists the objects of the run's job with their state and restore check, and moves to another run on a click", async () => {
    const page = await open(RUN_IDS.mailRunning);
    const items = [...(section("objects")?.querySelectorAll("li") ?? [])];
    expect(items.map((item) => item.querySelector(".font-mono")?.textContent)).toEqual([
      "anna@contoso.example",
      "ben@contoso.example",
      "clara@contoso.example",
    ]);
    expect(items[2]?.querySelector('[data-check="queued"]')).not.toBeNull();
    // The line under the bar counts the wave: one of three is not done, two are.
    expect(section("progress")?.textContent).toContain("2 of 3 mailboxes backed up");
    // Another object's run replaces the run of the drawer; the page is still the same.
    await click(items[1]?.querySelector("button"));
    await flush(3);
    expect(page.where().pathname).toBe("/host");
    expect(page.where().search.run).toBe("66666666-6666-4666-8666-666666666666");
  });
});

describe("a run that left items behind", () => {
  it("names the failed items with their cause and leads to the page that explains them all", async () => {
    await open(RUN_IDS.mailDone, {
      [`GET /history/${RUN_IDS.mailDone}`]: () =>
        json(
          detail(finished("partial"), {
            errors: [
              {
                path: "mail/Inbox/Quarterly report.0123456789abcdef.eml",
                message: "Graph 413 ErrorMessageSizeExceeded: too large",
                code: "graph.item_too_large",
                cause: "graph.item_too_large",
              },
            ],
            errorCount: 7,
          }),
        ),
    });
    const items = section("failed-items");
    expect(items).not.toBeNull();
    expect(items?.textContent).toContain("Items not backed up");
    expect(items?.textContent).toContain("Quarterly report");
    expect(items?.textContent).toContain("ErrorMessageSizeExceeded");
    expect(items?.querySelector('[data-cause="graph.item_too_large"]')).not.toBeNull();
    expect(items?.textContent).toContain("and 6 more items");
    expect(items?.querySelector("a")?.getAttribute("href")).toContain(RUN_IDS.mailDone);
  });
});
