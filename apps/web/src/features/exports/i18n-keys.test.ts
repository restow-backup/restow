import exportsDe from "@restow/i18n/resources/de/exports.json" with { type: "json" };
import exportsEn from "@restow/i18n/resources/en/exports.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { KNOWN_PHASES, SKIPPED_KINDS, expiryMessage } from "@/features/exports/lib/exports";
import { FORMAT_ORDER } from "@/features/exports/lib/formats";
import { EXPORT_ERROR_KEYS } from "@/features/exports/lib/request";

/**
 * German and English carry the same keys with the same placeholders, and
 * every key the feature's code builds at run time (statuses, phases, formats,
 * skipped kinds, expiry sentences, error messages) exists in both.
 */

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const found = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      found.set(path, value);
    } else {
      for (const [inner, text] of leaves(value, path)) {
        found.set(inner, text);
      }
    }
  }
  return found;
}

/** The argument names an ICU message uses (`{count, plural, ...}` and `{name}`). */
function placeholders(message: string): string[] {
  const names = new Set<string>();
  for (const match of message.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/g)) {
    names.add(match[1] as string);
  }
  return [...names].sort();
}

const en = leaves(exportsEn as Tree);
const de = leaves(exportsDe as Tree);

describe("exports translations", () => {
  it("have the same keys in German and English", () => {
    expect([...de.keys()].sort()).toEqual([...en.keys()].sort());
  });

  it("have no empty text", () => {
    for (const [key, text] of [...en, ...de]) {
      expect(text.trim().length, key).toBeGreaterThan(0);
    }
  });

  it("use the same placeholders in both languages", () => {
    for (const [key, text] of en) {
      expect(placeholders(de.get(key) ?? ""), key).toEqual(placeholders(text));
    }
  });

  it("contain every key the code builds at run time", () => {
    const keys = [
      ...(
        [
          "queued",
          "active",
          "completed",
          "completedWithIssues",
          "failed",
          "cancelled",
          "unknown",
        ] as const
      ).map((status) => `status.${status}`),
      ...KNOWN_PHASES.map((phase) => `phase.${phase}`),
      ...SKIPPED_KINDS.map((kind) => `skipped.${kind}`),
      ...FORMAT_ORDER.flatMap((format) => [
        `formats.${format}.label`,
        `formats.${format}.short`,
        `formats.${format}.description`,
      ]),
      "formats.pst.alternative",
      ...[
        { kind: "days", days: 3, hours: 1 },
        { kind: "hours", hours: 2, minutes: 3 },
        { kind: "minutes", minutes: 4 },
        { kind: "soon" },
      ].flatMap((expiry) =>
        (["sentence", "short"] as const).map(
          (variant) =>
            expiryMessage(expiry as Parameters<typeof expiryMessage>[0], variant)?.key ?? "",
        ),
      ),
      ...EXPORT_ERROR_KEYS.filter((key) => key.startsWith("exports:")).map((key) =>
        key.slice("exports:".length),
      ),
    ];
    for (const key of keys) {
      expect(en.has(key), `en ${key}`).toBe(true);
      expect(de.has(key), `de ${key}`).toBe(true);
    }
  });
});
