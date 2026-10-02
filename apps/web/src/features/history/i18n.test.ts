import de from "@restow/i18n/resources/de/history.json" with { type: "json" };
import en from "@restow/i18n/resources/en/history.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { RUN_CATEGORIES } from "./api";

/**
 * Guards for the `history` namespace: German and English carry the same keys with the same ICU
 * arguments, every key the code names exists, and every family of keys built at runtime is
 * complete. Capitals only where a word starts a sentence: there is no uppercase label.
 */

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      result.set(path, value);
    } else {
      for (const [leaf, text] of leaves(value, path)) {
        result.set(leaf, text);
      }
    }
  }
  return result;
}

function has(tree: Tree, path: string): boolean {
  let node: string | Tree | undefined = tree;
  for (const segment of path.split(".")) {
    if (node === undefined || typeof node === "string") {
      return false;
    }
    node = node[segment];
  }
  return node !== undefined;
}

function icuArguments(message: string): string[] {
  return [
    ...new Set([...message.matchAll(/\{(\w+)\s*[,}]/g)].map((match) => match[1] ?? "")),
  ].sort();
}

const enTree = en as Tree;
const deTree = de as Tree;

const sourceFiles = import.meta.glob(
  [
    "./**/*.ts",
    "./**/*.tsx",
    "!./**/*.test.ts",
    "!./**/*.test.tsx",
    "!./fixtures.ts",
    "!./testing.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

describe("the history namespace", () => {
  it("has the same keys in German and English", () => {
    expect([...leaves(deTree).keys()].sort()).toEqual([...leaves(enTree).keys()].sort());
  });

  it("uses the same ICU arguments in both languages for every message", () => {
    const german = leaves(deTree);
    for (const [key, message] of leaves(enTree)) {
      expect(icuArguments(german.get(key) ?? ""), key).toEqual(icuArguments(message));
    }
  });

  it("has no empty message and no em dash", () => {
    for (const tree of [leaves(enTree), leaves(deTree)]) {
      for (const [key, message] of tree) {
        expect(message.trim().length, key).toBeGreaterThan(0);
        expect(message, key).not.toContain("—");
      }
    }
  });

  it("has every key the code names", () => {
    const missing: string[] = [];
    for (const [file, source] of Object.entries(sourceFiles)) {
      for (const [, key] of source.matchAll(/\bt\(\s*"([a-zA-Z_.]+)"/g)) {
        if (!has(enTree, key as string)) {
          missing.push(`${file}: ${key}`);
        }
      }
    }
    // The cell that says a failed run is retried reads the `failures` namespace with its own `t`.
    expect(missing.filter((entry) => !entry.endsWith("section.retrying"))).toEqual([]);
  });

  it("is complete for every key family built at runtime", () => {
    for (const category of RUN_CATEGORIES) {
      expect(has(enTree, `tabs.${category}`), `tabs.${category}`).toBe(true);
      expect(has(enTree, `kind.${category}`), `kind.${category}`).toBe(true);
    }
    for (const state of [
      "queued",
      "running",
      "succeeded",
      "restored",
      "partial",
      "failed",
      "cancelled",
      "incomplete",
    ]) {
      expect(has(enTree, `state.${state}`), `state.${state}`).toBe(true);
    }
    for (const trigger of ["scheduled", "manual", "after_backup"]) {
      expect(has(enTree, `trigger.${trigger}`)).toBe(true);
    }
    for (const subject of ["mailbox", "onedrive", "imap", "server", "client"]) {
      expect(has(enTree, `subject.${subject}`), `subject.${subject}`).toBe(true);
      expect(has(enTree, `view.wave.${subject}`), `view.wave.${subject}`).toBe(true);
    }
    expect(has(enTree, "view.wave.generic")).toBe(true);
    for (const check of [
      "passed",
      "warning",
      "failed",
      "queued",
      "running",
      "unverified",
      "none",
    ]) {
      expect(has(enTree, `restoreCheck.${check}`), `restoreCheck.${check}`).toBe(true);
    }
    for (const type of ["archive", "directory", "retention", "scrub", "storage_migration"]) {
      expect(has(enTree, `type.${type}`), `type.${type}`).toBe(true);
    }
    for (const key of ["processed", "transferred"]) {
      expect(has(enTree, `chart.${key}.title`)).toBe(true);
      expect(has(enTree, `chart.${key}.hint`)).toBe(true);
      expect(has(enTree, `chart.summary.${key}`)).toBe(true);
    }
    for (const status of ["connecting", "open", "reconnecting", "closed"]) {
      expect(has(enTree, `live.${status}`), `live.${status}`).toBe(true);
    }
    for (const unit of ["now", "seconds", "minutes"]) {
      expect(has(enTree, `live.updated.${unit}`)).toBe(true);
    }
    // Every line of a timeline the server can send.
    for (const event of [
      "queued",
      "started",
      "startedFull",
      "phase",
      "throttled",
      "itemFailed",
      "completedItems",
      "completedWithFailures",
      "completed",
      "completedWithFailuresPlain",
      "failed",
      "failedWithReason",
      "cancelled",
      "agentError",
      "agentErrorPath",
      "finished",
      "finishedFiles",
      "restore_check_queued",
      "restore_check_running",
      "restore_check_passed",
      "restore_check_warning",
      "restore_check_failed",
    ]) {
      expect(has(enTree, `events.${event}`), `events.${event}`).toBe(true);
    }
  });
});
