import de from "@restow/i18n/resources/de/backupjobs.json" with { type: "json" };
import en from "@restow/i18n/resources/en/backupjobs.json" with { type: "json" };
import commonEn from "@restow/i18n/resources/en/common.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { EXCLUSION_PRESET_IDS } from "./exclusions.js";
import { OVERRIDE_GROUPS } from "./form.js";
import { MEMBER_KINDS_OF } from "./presenters.js";

/**
 * Guards for the `backupjobs` namespace: German and English carry the same keys with the
 * same ICU arguments, every key the feature's code names exists, and every family of keys
 * built at runtime is complete. The keys under `auto.` belong to the server (the names of
 * the jobs the migration creates) and stay as they are.
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

function lookup(tree: Tree, path: string): string | Tree | undefined {
  let node: string | Tree | undefined = tree;
  for (const segment of path.split(".")) {
    if (node === undefined || typeof node === "string") {
      return undefined;
    }
    node = node[segment];
  }
  return node;
}

/** ICU argument names (`{name}`, `{count, plural, ...}`); plural `#` is not an argument. */
function icuArguments(message: string): string[] {
  return [
    ...new Set([...message.matchAll(/\{(\w+)\s*[,}]/g)].map((match) => match[1] ?? "")),
  ].sort();
}

const enTree = en as Tree;
const deTree = de as Tree;
const namespaces: Record<string, Tree> = { backupjobs: enTree, common: commonEn as Tree };

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

function qualify(key: string, fallback: string): [string, string] {
  const colon = key.indexOf(":");
  return colon > 0 ? [key.slice(0, colon), key.slice(colon + 1)] : [fallback, key];
}

function collect(pattern: RegExp, fallback: string): [string, string, string][] {
  const found: [string, string, string][] = [];
  for (const [file, text] of Object.entries(sourceFiles)) {
    for (const match of text.matchAll(pattern)) {
      const [namespace, key] = qualify(match[1] ?? "", fallback);
      found.push([file, namespace, key]);
    }
  }
  return found;
}

describe("backupjobs translations", () => {
  it("have identical keys in German and English", () => {
    expect([...leaves(deTree).keys()].sort()).toEqual([...leaves(enTree).keys()].sort());
  });

  it("use the same ICU arguments in both languages", () => {
    const german = leaves(deTree);
    for (const [key, text] of leaves(enTree)) {
      expect(icuArguments(german.get(key) ?? ""), key).toEqual(icuArguments(text));
    }
  });

  it("have no empty messages and no dash used as a pause", () => {
    for (const [key, text] of [...leaves(enTree), ...leaves(deTree)]) {
      expect(text.trim().length, key).toBeGreaterThan(0);
      expect(text, key).not.toMatch(/—|(?<=\s)–|–(?=\s)/);
    }
  });

  it("keep the server's names of the migrated jobs", () => {
    for (const key of [
      "auto.mailJob",
      "auto.format",
      "auto.duplicate",
      "auto.group.linux.server",
      "auto.schedule.onConnectMinutes",
    ]) {
      expect(typeof lookup(enTree, key), key).toBe("string");
      expect(typeof lookup(deTree, key), key).toBe("string");
    }
  });

  it("contain every literal key the feature uses", () => {
    const literal = [
      ...collect(/\bt\(\s*"([^"]+)"/g, "backupjobs"),
      ...collect(/\blabelKey:\s*"([^"]+)"/g, "common"),
    ];
    expect(literal.length).toBeGreaterThan(150);
    for (const [file, namespace, key] of literal) {
      const tree = namespaces[namespace];
      if (namespace === "schedules" || namespace === "endpoints" || namespace === "backup") {
        continue;
      }
      expect(tree, `${file}: unknown namespace ${namespace}`).toBeDefined();
      expect(typeof lookup(tree as Tree, key), `${file}: ${namespace}:${key}`).toBe("string");
    }
  });

  it("contain the groups that dynamic keys are built from", () => {
    const dynamic = collect(/\bt\(\s*`([\w.]+)\.\$\{/g, "backupjobs");
    expect(dynamic.length).toBeGreaterThan(30);
    for (const [file, namespace, prefix] of dynamic) {
      const node = lookup(namespaces[namespace] as Tree, prefix);
      expect(typeof node, `${file}: ${namespace}:${prefix}.*`).toBe("object");
    }
  });

  it("name every state, kind, exclusion chip, override group, skip reason, tab and problem", () => {
    const required = [
      ...["paused", "failing", "running", "attention", "empty", "ok"].map((s) => `state.${s}`),
      ...["paused", "manual", "onConnect", "empty", "unknown"].map((k) => `nextRun.${k}`),
      ...["mail", "endpoint"].flatMap((kind) => [
        `list.description.${kind}`,
        `list.empty.title.${kind}`,
        `list.empty.description.${kind}`,
        `list.uncovered.${kind}`,
        `editor.createTitle.${kind}`,
        `editor.description.${kind}`,
        `editor.scope.title.${kind}`,
        `editor.scope.description.${kind}`,
        `picker.search.${kind}`,
        `picker.empty.${kind}`,
        `scope.empty.title.${kind}`,
        `scope.remove.description.${kind}`,
        `delete.impact.${kind}`,
        `toasts.runQueued.${kind}`,
        `toasts.added.${kind}`,
        `tenant.new.${kind}`,
        `overview.showScope.${kind}`,
        `overrides.description.${kind}`,
        `addMembers.title.${kind}`,
      ]),
      ...Object.values(MEMBER_KINDS_OF)
        .flat()
        .flatMap((kind) => [`scope.kinds.${kind}`, `scope.kindNames.${kind}`]),
      ...EXCLUSION_PRESET_IDS.map((id) => `exclusions.presets.${id}`),
      ...OVERRIDE_GROUPS.flatMap((group) => [
        `overrides.groups.${group}.title`,
        `overrides.groups.${group}.switch`,
        `overrides.groups.${group}.follows`,
        `overrides.groups.${group}.short`,
      ]),
      ...[
        "already_queued",
        "excluded",
        "orphaned",
        "source_pending",
        "source_disabled",
        "revoked",
        "not_in_job",
      ].map((reason) => `run.skipped.${reason}`),
      ...["overview", "scope", "settings", "runs"].map((tab) => `detail.tabs.${tab}`),
      ...["daily", "interval", "on_connect"].flatMap((kind) => [`schedule.endpoint.kinds.${kind}`]),
      ...["interval", "on_connect"].flatMap((kind) => [
        `schedule.endpoint.minutes.${kind}`,
        `schedule.endpoint.minutesHint.${kind}`,
      ]),
      ...["passed", "failed", "warning", "unverified", "noBackup"].map(
        (key) => `restoreCheck.detail.${key}`,
      ),
      ...["succeeded", "partial", "failed", "running", "queued"].map((o) => `scope.outcome.${o}`),
      ...["demo", "role"].map((block) => `access.${block}`),
      ...["inOtherJob", "pauseNotSupported", "state", "invalid"].map((key) => `errors.${key}`),
      ...["none", "tooMany", "empty", "controlCharacters", "notAbsolute", "tooLong"].map(
        (key) => `problems.form.paths.${key}`,
      ),
      ...["tooMany", "controlCharacters", "tooLong"].map((key) => `problems.form.excludes.${key}`),
      ...[
        "nameRequired",
        "nameTooLong",
        "tooManyMembers",
        "required",
        "integer",
        "range",
        "timeOfDay",
        "larger",
        "hooksHidden",
        "hookTooLong",
      ].map((key) => `problems.form.${key}`),
      ...[
        "generic",
        "schedule_kind_not_supported",
        "timezone_unknown",
        "interval_out_of_range",
        "time_of_day_invalid",
        "required",
      ].map((key) => `problems.server.${key}`),
      // The time windows of the bandwidth limit: what the form checks, and what the server answers.
      ...["fix", "days", "time", "kbpsRequired", "kbps", "overlap", "tooMany"].map(
        (key) => `problems.form.windows.${key}`,
      ),
      ...[
        "bandwidth_windows_too_many",
        "bandwidth_window_days_required",
        "bandwidth_window_days_invalid",
        "bandwidth_window_time_invalid",
        "bandwidth_window_kbps_invalid",
        "bandwidth_window_overlap",
      ].map((code) => `problems.server.${code}`),
      ...["summary", "summaryNextDay", "summaryWholeDay", "unlimited", "limitValue"].map(
        (key) => `bandwidth.windows.${key}`,
      ),
    ];
    for (const key of required) {
      expect(typeof lookup(enTree, key), key).toBe("string");
    }
  });
});
