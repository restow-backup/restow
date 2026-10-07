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

import { type HistoryPage as Page, type Run, historyKeys } from "../api";
import { RUN_IDS, agentRun, check, finished, iso, run } from "../fixtures";
import "../i18n";
import { list, mailJob } from "@/features/backup-jobs/fixtures";
import { applyEvent, newKnown } from "../live/apply";
import { type Opened, TENANT, openHistory } from "../testing";

/**
 * History as a person meets it: the tabs, the runs of both sources in one table with the live ones
 * moving, the retries of a restore check as one row, paging, the filter per job, the states that
 * are not the happy one, and the drawer a row opens.
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

const rows = () =>
  [...document.querySelectorAll("tbody tr")].filter((tr) => !tr.hasAttribute("aria-hidden"));
const rowOf = (needle: string) => rows().find((tr) => tr.textContent?.includes(needle));
const text = () => document.body.textContent ?? "";

const MAIL_RUNNING = run();
const MAIL_DONE = finished("succeeded", {
  id: RUN_IDS.mailDone,
  createdAt: iso(-3600),
  startedAt: iso(-3590),
  finishedAt: iso(-3000),
});
const PARTIAL = finished("partial", {
  id: "66666666-6666-4666-8666-666666666666",
  subject: { kind: "mailbox", id: "m2", name: "ben@contoso.example", detail: null },
  createdAt: iso(-7200),
  startedAt: iso(-7190),
  finishedAt: iso(-6500),
});
const AGENT = agentRun({ createdAt: iso(-2) });
const CHECK = run({
  id: RUN_IDS.checkRetry,
  kind: "restore_check",
  type: "verify",
  state: "queued",
  attempt: { number: 3, of: 6 },
  progress: null,
  samples: null,
  throughput: null,
  phase: null,
  cancellable: true,
  createdAt: iso(-1),
  startedAt: null,
});
const FAILED = finished("failed", {
  id: "77777777-7777-4777-8777-777777777777",
  subject: { kind: "mailbox", id: "m3", name: "clara@contoso.example", detail: null },
  errorMessage: "Mailbox not found",
  createdAt: iso(-9000),
  startedAt: iso(-8990),
  finishedAt: iso(-8900),
});
const RESTORE = finished("succeeded", {
  id: "88888888-8888-4888-8888-888888888888",
  kind: "restore",
  type: "restore",
  createdAt: iso(-10_000),
  startedAt: iso(-9990),
  finishedAt: iso(-9900),
  job: null,
  cancellable: false,
});

function page(items: Run[], next: string | null = null): Page {
  return { items, next };
}

describe("History", () => {
  it("lists the runs of both sources newest first, with the live ones moving", async () => {
    opened = await openHistory("/history", {
      routes: {
        "GET /history": () =>
          json(page([AGENT, CHECK, MAIL_RUNNING, MAIL_DONE, PARTIAL, FAILED, RESTORE])),
      },
    });
    await flush(6);
    expect(rows()).toHaveLength(7);
    // A running mail run and a running agent run: Lapis, a bar, a sparkline and a speed.
    const running = [...document.querySelectorAll('[data-state="running"]')];
    expect(running).toHaveLength(2);
    expect(running.every((badge) => badge.getAttribute("data-tone") === "info")).toBe(true);
    expect(document.querySelectorAll('[data-slot="sparkline"]')).toHaveLength(2);
    expect(rowOf("fs-bergisch")?.textContent).toContain("25 %");
    expect(rowOf("fs-bergisch")?.textContent).toMatch(/[\d.,]+ [kKMG]B\/s/);
    // A backup that merely completed is neutral; green is for a restore that brought the data back.
    expect(document.querySelector('[data-state="succeeded"]')?.getAttribute("data-tone")).toBe(
      "neutral",
    );
    const restored = rowOf("Restore · anna")?.querySelector('[data-state="succeeded"]');
    expect(restored?.getAttribute("data-tone")).toBe("success");
    // Items that failed, and why a run failed.
    expect(rowOf("ben@contoso.example")?.textContent).toContain("Completed with failed items");
    expect(rowOf("ben@contoso.example")?.textContent).toContain("3 items failed");
    expect(rowOf("clara@contoso.example")?.textContent).toContain("Mailbox not found");
  });

  it("shows the retries of one restore check as one row: the attempt it is on", async () => {
    opened = await openHistory("/history?type=restore_check", {
      routes: { "GET /history": () => json(page([CHECK])) },
    });
    await flush(6);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain("Attempt 3 of 6");
    expect(rows()[0]?.textContent).toContain("Waiting");
  });

  it("asks the server for the tab and the job named in the address, and offers each tab as a link", async () => {
    opened = await openHistory(`/history?type=restore&job=${RUN_IDS.jobMail}`, {
      routes: { "GET /history": () => json(page([RESTORE])) },
    });
    await flush(6);
    const asked = opened.requests.find((request) => request.path === "/history");
    expect(asked).toBeDefined();
    const tabs = [...document.querySelectorAll('[data-slot="page-tabs"] a')];
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      "All",
      "Backup",
      "Restore",
      "Restore check",
      "Export",
      "Import",
      "Maintenance",
    ]);
    const current = tabs.find((tab) => tab.getAttribute("aria-current") === "page");
    expect(current?.textContent?.trim()).toBe("Restore");
    // A tab keeps the job filter and drops nothing else of the address.
    expect(tabs[1]?.getAttribute("href")).toContain("type=backup");
    expect(tabs[1]?.getAttribute("href")).toContain(`job=${RUN_IDS.jobMail}`);
    expect(tabs[0]?.getAttribute("href")).not.toContain("type=");
  });

  it("sends the filters as the query of the request", async () => {
    opened = await openHistory(`/history?type=backup&job=${RUN_IDS.jobMachines}`, {
      routes: { "GET /history": () => json(page([])) },
    });
    await flush(6);
    // The fetch stand-in records the path without the query; the page's own request is what we
    // inspect through the cache key.
    const keys = opened.queryClient
      .getQueryCache()
      .findAll({ queryKey: historyKeys.lists(TENANT.id) });
    expect(keys.map((entry) => entry.queryKey)).toEqual([
      historyKeys.list(TENANT.id, { type: "backup", job: RUN_IDS.jobMachines }),
    ]);
  });

  it("pages with Load more and puts the next rows below the first", async () => {
    let calls = 0;
    opened = await openHistory("/history", {
      routes: {
        "GET /history": () => {
          calls++;
          return json(
            calls === 1 ? page([MAIL_RUNNING, MAIL_DONE], "cursor-2") : page([PARTIAL], null),
          );
        },
      },
    });
    await flush(6);
    expect(rows()).toHaveLength(2);
    await click(buttonByText(document.body, "Load more"));
    await flush(6);
    expect(rows()).toHaveLength(3);
    expect(calls).toBe(2);
    expect(buttonByText(document.body, "Load more")).toBeNull();
  });

  it("opens the drawer of a run from its row, the address naming the run, and from the name as a link", async () => {
    opened = await openHistory("/history", {
      routes: {
        "GET /history": () => json(page([MAIL_RUNNING])),
        [`GET /history/${RUN_IDS.mailRunning}`]: () => problem("urn:restow:problem:not-found", 404),
      },
    });
    await flush(6);
    const link = rows()[0]?.querySelector("a");
    expect(link?.getAttribute("href")).toContain(`run=${RUN_IDS.mailRunning}`);
    await click(rows()[0]?.querySelector("td:nth-child(3)"));
    await flush(4);
    expect(opened.where().pathname).toBe("/history");
    expect(opened.where().search).toMatchObject({ run: RUN_IDS.mailRunning });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("filters by job with the jobs of the tenant", async () => {
    opened = await openHistory(`/history?type=backup&job=${RUN_IDS.jobMail}`, {
      routes: {
        "GET /history": () => json(page([MAIL_DONE])),
        "GET /backup-jobs": () =>
          json(
            list([
              mailJob({ id: RUN_IDS.jobMail, name: "Mail backup" }),
              mailJob({ id: "other", name: "Other job" }),
            ]),
          ),
      },
    });
    await flush(6);
    // The job of the address is the one the filter shows, next to the tab that is open.
    expect(document.querySelector("#history-filter-job")?.textContent).toContain("Mail backup");
    expect(
      document.querySelector('[data-slot="page-tabs"] [aria-current="page"]')?.textContent,
    ).toBe("Backup");
  });

  it("names a job the address carries that the tenant does not have", async () => {
    opened = await openHistory(`/history?job=${RUN_IDS.jobMachines}`, {
      routes: { "GET /history": () => json(page([])) },
    });
    await flush(6);
    expect(document.querySelector("#history-filter-job")?.textContent).toContain("Another job");
  });

  it("explains an empty History, and an empty tab with the way back", async () => {
    opened = await openHistory("/history", { routes: { "GET /history": () => json(page([])) } });
    await flush(6);
    expect(text()).toContain("No runs yet");
    await opened.mounted.unmount();
    opened = await openHistory("/history?type=export", {
      routes: { "GET /history": () => json(page([])) },
    });
    await flush(6);
    expect(text()).toContain("No runs match");
    // A tab alone does not talk about a job.
    expect(text()).toContain("Nothing of this kind has run yet.");
    expect(text()).not.toContain("for this job");
    await click(buttonByText(document.body, "Clear filters"));
    await flush(4);
    expect(opened.where().search.type).toBeUndefined();
  });

  it("says the job filter is part of why nothing is shown", async () => {
    opened = await openHistory(`/history?type=export&job=${RUN_IDS.jobMail}`, {
      routes: { "GET /history": () => json(page([])) },
    });
    await flush(6);
    expect(text()).toContain("Nothing of this kind has run for this job yet.");
  });

  it("says when the runs could not be loaded and offers a retry", async () => {
    let fail = true;
    opened = await openHistory("/history", {
      routes: {
        "GET /history": () =>
          fail ? problem("urn:restow:problem:internal", 500) : json(page([MAIL_DONE])),
      },
    });
    await flush(8);
    expect(text()).toContain("The runs could not be loaded");
    fail = false;
    await click(buttonByText(document.body, /try again|retry/i));
    await flush(6);
    expect(rows()).toHaveLength(1);
  });

  it("follows the live channel: a run that ends moves its row without a request", async () => {
    opened = await openHistory("/history", {
      routes: { "GET /history": () => json(page([MAIL_RUNNING])) },
    });
    await flush(6);
    expect(rows()[0]?.textContent).toContain("Running");
    const before = opened.requests.length;
    await act(async () => {
      applyEvent(
        {
          client: opened?.queryClient as never,
          tenantId: TENANT.id,
          refetch: () => undefined,
          known: newKnown(),
        },
        {
          event: "run",
          data: JSON.stringify({
            ...MAIL_RUNNING,
            state: "succeeded",
            finishedAt: iso(300),
            updatedAt: iso(300),
            progress: { ...(MAIL_RUNNING.progress as object), percent: 100 },
            throughput: null,
            samples: null,
          }),
          id: null,
        },
      );
      await Promise.resolve();
    });
    await flush(2);
    expect(rows()[0]?.textContent).toContain("Completed");
    expect(rows()[0]?.textContent).not.toContain("Running");
    expect(opened.requests.length).toBe(before);
    void check;
  });
});
