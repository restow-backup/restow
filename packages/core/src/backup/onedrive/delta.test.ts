import { describe, expect, it } from "vitest";
import { GraphError } from "../../graph/errors.js";
import { graphError } from "../../graph/testing/fake-graph.js";
import { type DrivePage, type DriveWalkOutcome, walkDriveDelta } from "./delta.js";
import fixture from "./fixtures/drive-backup.json" with { type: "json" };
import { DELTA_PATH, DRIVE, createFakeGraph, deltaUrl } from "./testing.js";

async function drain(
  generator: AsyncGenerator<DrivePage, DriveWalkOutcome, unknown>,
): Promise<{ pages: DrivePage[]; outcome: DriveWalkOutcome }> {
  const pages: DrivePage[] = [];
  for (;;) {
    const next = await generator.next();
    if (next.done) {
      return { pages, outcome: next.value };
    }
    pages.push(next.value);
  }
}

describe("walkDriveDelta", () => {
  it("yields every page with the URL it came from and ends with the delta link", async () => {
    const graph = createFakeGraph([
      { url: deltaUrl(null), respond: { status: 200, json: fixture.initialPage1 } },
      { url: deltaUrl("NEXT1"), respond: { status: 200, json: fixture.initialPage2 } },
    ]);
    const { pages, outcome } = await drain(
      walkDriveDelta({
        client: graph.client(),
        driveId: DRIVE,
        start: { url: null, mode: "initial" },
      }),
    );
    expect(pages.map((p) => [p.mode, p.reset, p.items.length])).toEqual([
      ["initial", false, 4],
      ["initial", false, 3],
    ]);
    expect(pages[0]?.url).toBe(`/drives/${DRIVE}/root/delta`);
    expect(pages[1]?.url).toContain("token=NEXT1");
    expect(outcome).toEqual({
      mode: "initial",
      deltaLink: fixture.initialPage2["@odata.deltaLink"],
      pages: 2,
      items: 7,
    });
  });

  it("continues from a stored link in incremental mode", async () => {
    const graph = createFakeGraph([
      { url: deltaUrl("DELTA1"), respond: { status: 200, json: fixture.incrementalPage } },
    ]);
    const { pages, outcome } = await drain(
      walkDriveDelta({
        client: graph.client(),
        driveId: DRIVE,
        start: { url: fixture.initialPage2["@odata.deltaLink"], mode: "incremental" },
      }),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]?.mode).toBe("incremental");
    expect(outcome.deltaLink).toContain("DELTA2");
  });

  it("restarts from the Location of a 410 at the start without asking for a reset", async () => {
    const graph = createFakeGraph([
      {
        url: deltaUrl("STALE"),
        respond: {
          status: 410,
          headers: {
            location: `https://graph.microsoft.com/v1.0${DELTA_PATH.slice(5)}?token=FRESH`,
          },
          json: fixture.gone,
        },
      },
      { url: deltaUrl("FRESH"), respond: { status: 200, json: fixture.resyncPage } },
    ]);
    const resyncs: number[] = [];
    const { pages, outcome } = await drain(
      walkDriveDelta({
        client: graph.client(),
        driveId: DRIVE,
        start: { url: `${DELTA_PATH.slice(5)}?token=STALE`, mode: "incremental" },
        onResync: (info) => resyncs.push(info.discardedPages),
      }),
    );
    expect(resyncs).toEqual([0]);
    expect(pages.map((p) => [p.mode, p.reset])).toEqual([["resync", false]]);
    expect(outcome.mode).toBe("resync");
    expect(outcome.deltaLink).toContain("DELTA-R");
    expect(graph.calls[1]?.url).toContain("token=FRESH");
  });

  it("flags a reset when the 410 arrives after pages were already yielded", async () => {
    const graph = createFakeGraph([
      { url: deltaUrl(null), respond: { status: 200, json: fixture.initialPage1 } },
      { url: deltaUrl("NEXT1"), respond: { status: 410, json: fixture.gone } },
      { url: deltaUrl("DELTA1"), respond: { status: 200, json: fixture.resyncPage } },
    ]);
    // Without a Location header the walk restarts at the initial URL; make that
    // URL answer differently the second time by routing on call order.
    let initialCalls = 0;
    graph.calls.length = 0;
    const client = graph.client({
      fetchImpl: async (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : (input as URL | Request).toString(),
        );
        if (url.pathname === DELTA_PATH && !url.searchParams.has("token")) {
          initialCalls += 1;
          if (initialCalls > 1) {
            return new Response(JSON.stringify(fixture.resyncPage), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
        }
        return graph.fetch(input, init);
      },
    });
    const { pages, outcome } = await drain(
      walkDriveDelta({ client, driveId: DRIVE, start: { url: null, mode: "initial" } }),
    );
    expect(pages.map((p) => [p.mode, p.reset, p.items.length])).toEqual([
      ["initial", false, 4],
      ["resync", true, 4],
    ]);
    expect(outcome.mode).toBe("resync");
    expect(outcome.pages).toBe(1);
  });

  it("gives up after a second 410 and on a stream without a delta link", async () => {
    const gone = createFakeGraph([
      { url: deltaUrl(null), respond: { status: 410, json: fixture.gone } },
    ]);
    await expect(
      drain(
        walkDriveDelta({
          client: gone.client(),
          driveId: DRIVE,
          start: { url: null, mode: "initial" },
        }),
      ),
    ).rejects.toBeInstanceOf(GraphError);
    expect(gone.calls).toHaveLength(2);

    const truncated = createFakeGraph([
      { url: deltaUrl(null), respond: { status: 200, json: { value: [] } } },
    ]);
    await expect(
      drain(
        walkDriveDelta({
          client: truncated.client(),
          driveId: DRIVE,
          start: { url: null, mode: "initial" },
        }),
      ),
    ).rejects.toThrow(/without a delta link/);

    const forbidden = createFakeGraph([
      { url: deltaUrl(null), respond: { status: 403, json: graphError("accessDenied") } },
    ]);
    await expect(
      drain(
        walkDriveDelta({
          client: forbidden.client(),
          driveId: DRIVE,
          start: { url: null, mode: "initial" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
