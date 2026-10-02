// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { EmbeddedPage } from "@/components/kit/page-context";
import { JobsSection } from "@/features/tenant-page/sections/wrappers";
import { openSection, tenantOf } from "@/features/tenant-page/testing";
import {
  type Mounted,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  routedFetch,
  sessionAs,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { defaults, endpointJob, list, mailJob } from "../fixtures.js";
import "../i18n.js";
import { describedText, openMenu } from "../testing.js";

/**
 * The Jobs & schedules section of the tenant page: the tenant's backup jobs on top, with the way
 * into each one and into the editor for either kind, and the maintenance schedules below.
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

const MUELLER = tenantOf("mueller", { name: "Müller GmbH" });

/** The section the way the tenant page shows it: inside the page, whose heading it does not claim. */
function Section() {
  return (
    <EmbeddedPage>
      <JobsSection />
    </EmbeddedPage>
  );
}
const slot = (name: string) => document.querySelector<HTMLElement>(`[data-slot="${name}"]`);

async function open(jobs: ReturnType<typeof list>, options: { demo?: boolean } = {}) {
  const { mock } = routedFetch({
    "GET /backup-jobs": () => json(jobs),
    "GET /backup-jobs/defaults": () => json(defaults("mail")),
    "GET /schedules": () =>
      json({
        items: [
          {
            id: "s1",
            kind: "retention",
            protectedObject: null,
            intervalMinutes: null,
            cron: "30 4 * * *",
            timezone: "Europe/Berlin",
            enabled: true,
            nextRunAt: "2026-10-03T02:30:00.000Z",
            lastRunAt: null,
            lastJob: null,
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        missingKinds: [],
      }),
  });
  vi.stubGlobal("fetch", mock);
  mounted = await openSection(Section, "/tenants/mueller/jobs", {
    demo: options.demo,
    session: sessionAs({ activeTenant: MUELLER, tenants: [MUELLER] }),
  });
  await flush(6);
}

describe("Jobs & schedules", () => {
  it("lists the backup jobs of both kinds with the way into each, then the maintenance schedules", async () => {
    await open(list([mailJob(), endpointJob()]));
    const card = slot("tenant-jobs") as HTMLElement;
    expect(card.querySelector("h2")?.textContent).toBe("Backup jobs");
    const rows = [...card.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    const mail = rows.find((row) => row.textContent?.includes("All mailboxes, daily"));
    expect(mail?.querySelector("a")?.getAttribute("href")).toContain(
      "/jobs/definitions/job-mail-all",
    );
    expect(mail?.textContent).toContain("Mail & SaaS");
    expect(mail?.textContent).toContain("214 mailboxes, 6 OneDrives");
    const machines = rows.find((row) => row.textContent?.includes("Linux servers, daily"));
    expect(machines?.textContent).toContain("Servers & endpoints");
    expect(machines?.textContent).toContain("3 servers");
    expect(card.querySelector('td[data-pinned="left"]')).not.toBeNull();
    // The schedules that are left follow below, under their own heading.
    const headings = [...document.querySelectorAll("h2")].map((heading) => heading.textContent);
    expect(headings).toEqual(["Backup jobs", "Maintenance schedules"]);
    expect(document.body.textContent).toContain("Retention");
  });

  it("opens the jobs page with the editor on a new job of either kind", async () => {
    await open(list([mailJob()]));
    const trigger = [...document.querySelectorAll<HTMLElement>("button")].find((button) =>
      button.textContent?.includes("New job"),
    );
    const items = await openMenu(trigger);
    expect(items.map((item) => item.textContent)).toEqual([
      "Mail & SaaS job",
      "Server or client job",
    ]);
  });

  it("names what no job covers and where to see it", async () => {
    await open(list([mailJob()], { mail: 3, endpoint: 2 }));
    const notice = slot("tenant-uncovered") as HTMLElement;
    expect(notice.textContent).toContain("3 protected objects are in no job");
    expect(notice.textContent).toContain("2 machines are in no job");
    expect([...notice.querySelectorAll("a")].map((anchor) => anchor.getAttribute("href"))).toEqual([
      "/jobs?type=mail",
      "/jobs?type=endpoint",
    ]);
  });

  it("offers a way forward when the tenant has no job yet", async () => {
    await open(list([]));
    expect(slot("tenant-jobs")?.querySelector('[data-slot="empty-state"]')?.textContent).toContain(
      "No backup jobs yet",
    );
  });

  it("closes New job in the public demo and says why next to it", async () => {
    await open(list([mailJob()]), { demo: true });
    const trigger = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("New job"),
    ) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(describedText(trigger)).toContain("This is the public demo");
    expect(slot("access-note")?.getAttribute("data-reason")).toBe("demo");
  });
});
