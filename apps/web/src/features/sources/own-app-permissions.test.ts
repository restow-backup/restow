import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OWN_APP_PERMISSIONS, OWN_APP_TOKEN_HINTS, ownAppTokenHint } from "./own-app-permissions";

const core = (path: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../../../packages/core/src/entra/${path}`, import.meta.url)),
    "utf8",
  );

describe("own app permissions", () => {
  it("lists exactly the core catalogue, in order, with the same required flags", () => {
    const source = core("permissions.ts");
    const block = source.slice(
      source.indexOf("GRAPH_APPLICATION_PERMISSIONS"),
      source.indexOf("export type PermissionType"),
    );
    const entries = [
      ...block.matchAll(/permission: "([^"]+)",\s*required: (true|false),\s*purpose: "([^"]+)"/g),
    ].map((match) => ({ permission: match[1], required: match[2] === "true", purpose: match[3] }));
    expect(entries.length).toBeGreaterThan(0);
    expect(OWN_APP_PERMISSIONS).toEqual(entries);
  });

  it("asks for the read-write variants restores need", () => {
    const names = OWN_APP_PERMISSIONS.map((entry) => entry.permission);
    expect(names).toContain("Mail.ReadWrite");
    expect(names).toContain("Files.ReadWrite.All");
    expect(names).not.toContain("Mail.Read");
    expect(names).not.toContain("Files.Read.All");
  });

  it("knows every token hint the core reports", () => {
    const source = core("verify.ts");
    const reported = new Set([...source.matchAll(/hint = "([a-z_]+)"/g)].map((match) => match[1]));
    for (const hint of reported) {
      expect(OWN_APP_TOKEN_HINTS).toContain(hint);
    }
    expect(ownAppTokenHint("consent_missing")).toBe("consent_missing");
    expect(ownAppTokenHint("nope")).toBeNull();
    expect(ownAppTokenHint(undefined)).toBeNull();
  });
});
