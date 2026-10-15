// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { EventStreamOptions, StreamStatus } from "@/features/jobs/sse";
import {
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  type Mounted,
  mount,
  newQueryClient,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import { run } from "../fixtures";
import "../i18n";
import { adminSession } from "../testing";
import { useMailJobsActivity } from "./activity-badges";
import { resetChannelsForTesting } from "./channel";
import { LiveChannelProvider } from "./provider";

/**
 * The count on "Jobs" under Mail & SaaS: from the live channel while it delivers, without a request
 * of its own; from the list of backup jobs while it does not; nothing while nothing runs.
 */

enableActEnvironment();

let mounted: Mounted | null = null;
const requests: string[] = [];

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  resetChannelsForTesting();
  vi.unstubAllGlobals();
  requests.length = 0;
  document.body.innerHTML = "";
});

function Probe() {
  const badge = useMailJobsActivity();
  return (
    <output
      data-probe
      data-count={badge?.count ?? "none"}
      data-queued={badge?.activity?.queued ?? "none"}
      data-items={badge?.activity?.items.map((item) => item.label).join("|") ?? ""}
    >
      {badge?.label ?? ""}
    </output>
  );
}

const probe = () => document.querySelector<HTMLElement>("[data-probe]");

async function show() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/backup-jobs")) {
      return json({
        items: [
          {
            id: "job-1",
            kind: "mail",
            name: "Mailboxes",
            lastRun: { at: null, failed: 0, partial: 0, running: 3, queued: 1, runId: "r1" },
          },
        ],
        uncovered: { mail: 0, endpoint: 0 },
      });
    }
    return json({}, 404);
  });
  const opened: EventStreamOptions[] = [];
  mounted = mount(
    <LiveChannelProvider
      deps={{
        open: (options: EventStreamOptions) => {
          opened.push(options);
          return { close: () => undefined };
        },
      }}
    >
      <Probe />
    </LiveChannelProvider>,
    { session: adminSession(), queryClient: newQueryClient() },
  );
  await flush(2);
  return {
    status: (value: StreamStatus) =>
      act(async () => {
        opened.at(-1)?.onStatus?.(value);
        await Promise.resolve();
      }),
    snapshot: async (runs: unknown[]) => {
      await act(async () => {
        opened.at(-1)?.onEvent({
          event: "snapshot",
          data: JSON.stringify({ runs, definitions: [], machines: [], serverTime: "" }),
          id: null,
        });
        await Promise.resolve();
      });
      await flush(2);
    },
  };
}

describe("the count on Jobs", () => {
  it("counts the running backups the channel follows, without a request of its own", async () => {
    const stream = await show();
    await stream.status("open");
    expect(probe()?.getAttribute("data-count")).toBe("none");
    await stream.snapshot([run(), run({ id: "q", state: "queued", startedAt: null })]);
    expect(probe()?.getAttribute("data-count")).toBe("1");
    expect(probe()?.getAttribute("data-queued")).toBe("1");
    expect(probe()?.textContent).toBe("1 backup running, 1 waiting");
    expect(probe()?.getAttribute("data-items")).toBe("Mail backup · anna@contoso.example");
    expect(requests.some((url) => url.includes("/backup-jobs"))).toBe(false);
  });

  it("reads the list of backup jobs while the channel is not connected", async () => {
    const stream = await show();
    await stream.status("open");
    await stream.status("reconnecting");
    await flush(3);
    expect(requests.some((url) => url.includes("/backup-jobs?kind=mail"))).toBe(true);
    expect(probe()?.getAttribute("data-count")).toBe("3");
    expect(probe()?.textContent).toBe("3 backups running, 1 waiting");
    expect(probe()?.getAttribute("data-items")).toBe("Mailboxes");
  });

  it("says it in German, formally and with the glossary's words", async () => {
    await i18n.changeLanguage("de");
    try {
      const stream = await show();
      await stream.status("open");
      await stream.snapshot([run(), run({ id: "b" }), run({ id: "q", state: "queued" })]);
      expect(probe()?.textContent).toBe("2 Backups laufen, 1 wartet");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
