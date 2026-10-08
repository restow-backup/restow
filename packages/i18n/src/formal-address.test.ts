import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * German addresses the reader formally ("Sie", docs/GLOSSARY.md). An informal "du" slipped
 * into a shipped text once (an unused tagline); this keeps it out of every German resource.
 */
const INFORMAL = /\b(?:du|dein|deine|deinen|deinem|deiner|dich|dir)\b/i;

const RESOURCES = fileURLToPath(new URL("../resources/de/", import.meta.url));

function leaves(value: unknown, prefix = ""): { key: string; value: string }[] {
  if (typeof value === "string") {
    return [{ key: prefix, value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => leaves(child, `${prefix}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      leaves(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [];
}

describe("German texts", () => {
  it("address the reader formally, never with du", () => {
    const informal: string[] = [];
    for (const file of readdirSync(RESOURCES).filter((name) => name.endsWith(".json"))) {
      const data = JSON.parse(readFileSync(`${RESOURCES}${file}`, "utf8")) as unknown;
      for (const { key, value } of leaves(data)) {
        if (INFORMAL.test(value)) {
          informal.push(`${file}:${key}`);
        }
      }
    }
    expect(informal).toEqual([]);
  });
});
