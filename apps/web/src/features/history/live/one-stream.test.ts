import { describe, expect, it } from "vitest";

/**
 * A tab holds one live stream. Every other part of the app reads what the channel writes into
 * the query cache, or polls while it is down; none opens a stream of its own. This guard reads
 * the sources: only the stream's own file and the channel's provider may call `openEventStream`,
 * and nobody may reach for `EventSource` or a second `/events` path.
 */

const sources = import.meta.glob<string>(
  ["../../../**/*.ts", "../../../**/*.tsx", "!../../../**/*.test.*", "!../../../vite-env.d.ts"],
  { query: "?raw", import: "default", eager: true },
);

const ALLOWED_OPENERS = new Set([
  // The stream itself.
  "../../jobs/sse.ts",
  // The one place that opens it, through the channel.
  "./provider.tsx",
]);

describe("one live stream per tab", () => {
  it("scans the app's sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(300);
  });

  it("opens an event stream only in the channel's provider", () => {
    const openers = Object.entries(sources)
      .filter(([, source]) => /import[^;]*\bopenEventStream\b[^;]*from/s.test(source))
      .map(([path]) => path)
      .filter((path) => !ALLOWED_OPENERS.has(path));
    expect(openers, "these files open an event stream of their own").toEqual([]);
  });

  it("never uses EventSource or names an events path of its own", () => {
    const offenders = Object.entries(sources)
      .filter(
        ([path, source]) =>
          !ALLOWED_OPENERS.has(path) &&
          (/\bnew EventSource\b/.test(source) ||
            /["'`]\/(?:jobs|runs)\/[^"'`]*events/.test(source)),
      )
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("opens the stream with the channel's own path", () => {
    const channel = sources["./channel.ts"] ?? "";
    expect(channel).toContain("LIVE_PATH");
  });
});
