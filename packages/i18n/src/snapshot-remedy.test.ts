import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * A machine-wide VSS failure (restow-agent 0.5.0 reports it as `snapshot_unavailable`, permanent:
 * the service disabled, access denied by Windows or COM security) is not fixed by waiting. Its
 * explanation and its step name what to look at: the services, the account, COM security and
 * the event log, in both languages.
 */
function failures(lang: "de" | "en") {
  const path = fileURLToPath(new URL(`../resources/${lang}/failures.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as {
    cause: { endpoint: { snapshot_unavailable: { why: string } } };
    steps: Record<string, string>;
  };
}

describe("the remedy of an unusable shadow copy service", () => {
  it("names the service, the account, COM security and the event log", () => {
    const en = failures("en");
    const step = en.steps.check_endpoint_snapshot_service ?? "";
    for (const part of ["services.msc", "Volume Shadow Copy", "SYSTEM", "COM Security", "VSS"]) {
      expect(step, part).toContain(part);
    }
    expect(en.cause.endpoint.snapshot_unavailable.why).toContain("COM security");
    expect(en.cause.endpoint.snapshot_unavailable.why).toContain("not a passing fault");

    const de = failures("de");
    const schritt = de.steps.check_endpoint_snapshot_service ?? "";
    for (const part of ["services.msc", "Volumeschattenkopie", "SYSTEM", "COM-Sicherheit"]) {
      expect(schritt, part).toContain(part);
    }
    expect(schritt).toContain("prüfen Sie");
    expect(de.cause.endpoint.snapshot_unavailable.why).toContain("COM-Sicherheit");
  });
});
