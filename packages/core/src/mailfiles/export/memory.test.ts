import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createEmlZip } from "./eml-zip.js";
import { createMbox, createMboxZip } from "./mbox.js";
import type { ExportMessage, ExportResult } from "./types.js";

const MESSAGE_BYTES = 1024 * 1024;
const MESSAGES = 200;
const CHUNK = randomBytes(64 * 1024);

interface Probe {
  producedBytes: number;
  consumedBytes: number;
  maxInFlight: number;
  open: number;
  maxOpen: number;
  peakRss: number;
}

/** 200 messages of 1 MiB each, produced on demand and never kept. */
function bigMailbox(
  probe: Probe,
  folders: (index: number) => string[],
): AsyncGenerator<ExportMessage> {
  async function* generate(): AsyncGenerator<ExportMessage> {
    for (let index = 0; index < MESSAGES; index++) {
      yield {
        folder: folders(index),
        date: new Date(Date.UTC(2024, 0, 1 + (index % 28))),
        size: MESSAGE_BYTES,
        messageId: `<m${index}@example.test>`,
        subject: `Message ${index}`,
        from: "sender@example.test",
        to: "rcpt@example.test",
        open: () => {
          probe.open++;
          probe.maxOpen = Math.max(probe.maxOpen, probe.open);
          let sent = 0;
          const stream = new Readable({
            read() {
              if (sent >= MESSAGE_BYTES) {
                this.push(null);
                return;
              }
              sent += CHUNK.length;
              probe.producedBytes += CHUNK.length;
              probe.maxInFlight = Math.max(
                probe.maxInFlight,
                probe.producedBytes - probe.consumedBytes,
              );
              this.push(CHUNK);
            },
          });
          stream.once("close", () => {
            probe.open--;
          });
          return stream;
        },
      };
    }
  }
  return generate();
}

async function consumeSlowly(result: ExportResult, probe: Probe): Promise<void> {
  let chunks = 0;
  for await (const chunk of result.stream) {
    probe.consumedBytes += (chunk as Buffer).length;
    probe.peakRss = Math.max(probe.peakRss, process.memoryUsage().rss);
    if (++chunks % 16 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  await result.completed;
}

function newProbe(): Probe {
  return {
    producedBytes: 0,
    consumedBytes: 0,
    maxInFlight: 0,
    open: 0,
    maxOpen: 0,
    peakRss: process.memoryUsage().rss,
  };
}

/**
 * The claim: a writer never holds more than one message, whatever the export
 * size. 200 MiB flow through; at any moment only a few MiB may be in flight
 * between the sources and the consumer, and never two sources are open.
 */
describe("memory bound", () => {
  const IN_FLIGHT_LIMIT = 8 * 1024 * 1024;
  const RSS_GROWTH_LIMIT = 160 * 1024 * 1024;

  it("EML ZIP: 200 messages of 1 MiB", { timeout: 60_000 }, async () => {
    const probe = newProbe();
    const baseline = process.memoryUsage().rss;
    const result = createEmlZip(
      bigMailbox(probe, (i) => ["Inbox", `Folder ${i % 5}`]),
      { level: 1 },
    );
    await consumeSlowly(result, probe);
    const summary = await result.completed;
    expect(summary.messages).toBe(MESSAGES);
    expect(probe.producedBytes).toBe(MESSAGES * MESSAGE_BYTES);
    expect(probe.maxOpen).toBe(1);
    expect(probe.maxInFlight).toBeLessThan(IN_FLIGHT_LIMIT);
    expect(probe.peakRss - baseline).toBeLessThan(RSS_GROWTH_LIMIT);
  });

  it("single MBOX: 200 messages of 1 MiB", { timeout: 60_000 }, async () => {
    const probe = newProbe();
    const baseline = process.memoryUsage().rss;
    const result = createMbox(bigMailbox(probe, () => ["Inbox"]));
    await consumeSlowly(result, probe);
    const summary = await result.completed;
    expect(summary.messages).toBe(MESSAGES);
    expect(probe.consumedBytes).toBeGreaterThanOrEqual(MESSAGES * MESSAGE_BYTES);
    expect(probe.maxOpen).toBe(1);
    expect(probe.maxInFlight).toBeLessThan(IN_FLIGHT_LIMIT);
    expect(probe.peakRss - baseline).toBeLessThan(RSS_GROWTH_LIMIT);
  });

  it("MBOX ZIP: 200 messages of 1 MiB in 4 folders", { timeout: 60_000 }, async () => {
    const probe = newProbe();
    const baseline = process.memoryUsage().rss;
    const result = createMboxZip(
      bigMailbox(probe, (i) => ["Folder", `Part ${Math.floor(i / 50)}`]),
      { level: 1 },
    );
    await consumeSlowly(result, probe);
    const summary = await result.completed;
    expect(summary.messages).toBe(MESSAGES);
    expect(probe.maxOpen).toBe(1);
    expect(probe.maxInFlight).toBeLessThan(IN_FLIGHT_LIMIT);
    expect(probe.peakRss - baseline).toBeLessThan(RSS_GROWTH_LIMIT);
  });
});
