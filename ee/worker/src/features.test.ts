import type { Database } from "@restow/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  extensionFeatureGate,
  registerWorkerExtension,
  resetWorkerExtensionsForTesting,
} from "../../../apps/worker/src/extensions.js";
import { eeWorkerExtension, WORKER_FEATURE_CAPABILITIES } from "./index.js";

/** An installation pool that answers the license lookup with `edition` (or no key). */
function fakeDb(edition?: "business" | "service_provider") {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => (edition ? [{ edition }] : []),
          }),
        }),
      }),
    }),
  };
  return db as unknown as Database;
}

afterEach(() => {
  resetWorkerExtensionsForTesting();
});

describe("the worker's feature gate", () => {
  it("is closed for every feature without an extension (the core alone)", async () => {
    const gate = extensionFeatureGate({ providerDb: fakeDb("business") });
    expect(await gate.isEnabled("archive.mailboxCapture")).toBe(false);
    expect(await gate.isEnabled("archive.smtpCapture")).toBe(false);
  });

  it("opens archive capture from Business on, by the installed license", async () => {
    registerWorkerExtension(eeWorkerExtension);
    const community = extensionFeatureGate({ providerDb: fakeDb() });
    expect(await community.isEnabled("archive.mailboxCapture")).toBe(false);
    const business = extensionFeatureGate({ providerDb: fakeDb("business") });
    expect(await business.isEnabled("archive.mailboxCapture")).toBe(true);
    expect(await business.isEnabled("archive.smtpCapture")).toBe(true);
  });

  it("maps the features to the same capabilities as the API", () => {
    expect(WORKER_FEATURE_CAPABILITIES).toEqual({
      "archive.mailboxCapture": "archive.mailboxCapture",
      "archive.smtpCapture": "archive.journalReceiver",
    });
  });

  it("counts a failing gate as closed", async () => {
    registerWorkerExtension({
      name: "broken",
      features: () => ({
        isEnabled: async () => {
          throw new Error("license table unreachable");
        },
      }),
    });
    const gate = extensionFeatureGate({ providerDb: fakeDb() });
    expect(await gate.isEnabled("archive.mailboxCapture")).toBe(false);
  });
});
