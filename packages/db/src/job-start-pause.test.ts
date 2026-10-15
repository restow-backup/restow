import { describe, expect, it } from "vitest";
import { NOT_PAUSED, readJobStartPause } from "./job-start-pause.js";
import type { Queryable } from "./roles.js";

function answering(rows: Record<string, unknown>[]): Queryable & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    query: async <R extends Record<string, unknown>>(text: string) => {
      texts.push(text);
      return { rows: rows as R[] };
    },
  };
}

describe("readJobStartPause", () => {
  it("is not paused without a row, and reads only a pause that has not expired", async () => {
    const db = answering([]);
    expect(await readJobStartPause(db)).toEqual(NOT_PAUSED);
    expect(db.texts[0]).toMatch(/expires_at > now\(\)/);
  });

  it("reports the mode: only drain stops running jobs", async () => {
    expect(
      await readJobStartPause(answering([{ mode: "drain", phase: "draining", version: "0.4.0" }])),
    ).toEqual({ paused: true, drain: true, mode: "drain", phase: "draining", version: "0.4.0" });
    expect(
      await readJobStartPause(answering([{ mode: "wait", phase: "announced", version: "0.4.0" }])),
    ).toMatchObject({ paused: true, drain: false, mode: "wait" });
  });

  it("counts a database without the table as not paused, and passes other errors on", async () => {
    const missing: Queryable = {
      query: async () => {
        throw Object.assign(new Error('relation "job_start_pause" does not exist'), {
          code: "42P01",
        });
      },
    };
    expect(await readJobStartPause(missing)).toEqual(NOT_PAUSED);
    const broken: Queryable = {
      query: async () => {
        throw Object.assign(new Error("connection lost"), { code: "57P01" });
      },
    };
    await expect(readJobStartPause(broken)).rejects.toThrow(/connection lost/);
  });
});
