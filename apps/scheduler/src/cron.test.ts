import * as core from "@restow/core";
import { describe, expect, it } from "vitest";
import * as cron from "./cron.js";

// The cron tests live with the implementation in packages/core/src/schedule.
// Here it is enough to prove the scheduler plans with that very code, so the
// API's previews and the scheduler's runs can never disagree.
describe("cron", () => {
  it("is the shared implementation from @restow/core", () => {
    expect(cron.parseCron).toBe(core.parseCron);
    expect(cron.nextCronOccurrence).toBe(core.nextCronOccurrence);
    expect(cron.isValidTimeZone).toBe(core.isValidTimeZone);
    expect(cron.CronSyntaxError).toBe(core.CronSyntaxError);
  });
});
