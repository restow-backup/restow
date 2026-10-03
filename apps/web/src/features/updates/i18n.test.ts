import commonDe from "@restow/i18n/resources/de/common.json" with { type: "json" };
import updatesDe from "@restow/i18n/resources/de/updates.json" with { type: "json" };
import commonEn from "@restow/i18n/resources/en/common.json" with { type: "json" };
import updatesEn from "@restow/i18n/resources/en/updates.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import {
  BLOCKER_CODES,
  CHECK_ERROR_CODES,
  FAILURE_CODES,
  LEAD_TIME_PRESETS,
  RUN_OUTCOMES,
  SELF_UPDATE_REASONS,
  STEP_STATUSES,
  UPDATE_MESSAGE_CODES,
  UPDATE_STEPS,
} from "./api";
import {
  blockerKey,
  checkErrorKey,
  failureKey,
  leadTimeLabel,
  maintenanceMessageKey,
  outcomeKey,
  sourceUrlIssueKey,
  spanLabel,
  stepLabelKey,
  stepStatusKey,
} from "./presenters";
import "./i18n";

/**
 * Guards for the `updates` namespace: German and English carry the same keys
 * with the same ICU arguments, and every key the code names exists. A missing
 * key would render as the raw key in front of an operator.
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

/** ICU argument names (`{name}`, `{count, plural, ...}`). */
function icuArguments(message: string): string[] {
  return [
    ...new Set([...message.matchAll(/\{(\w+)\s*[,}]/g)].map((match) => match[1] ?? "")),
  ].sort();
}

const en = updatesEn as Tree;
const de = updatesDe as Tree;
const namespaces: Record<string, Tree> = {
  updates: en,
  common: commonEn as Tree,
};

const sourceFiles = import.meta.glob(
  ["./**/*.ts", "./**/*.tsx", "!./**/*.test.ts", "!./**/*.test.tsx", "!./testing.tsx"],
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

describe("updates translations", () => {
  it("have identical keys in German and English", () => {
    expect([...leaves(de).keys()].sort()).toEqual([...leaves(en).keys()].sort());
  });

  it("use the same ICU arguments in both languages", () => {
    const german = leaves(de);
    for (const [key, text] of leaves(en)) {
      expect(icuArguments(german.get(key) ?? ""), key).toEqual(icuArguments(text));
    }
  });

  it("have no empty messages", () => {
    for (const [key, text] of [...leaves(en), ...leaves(de)]) {
      expect(text.trim().length, key).toBeGreaterThan(0);
    }
  });

  it("are translated: a German text is not the English one, except for names and identifiers", () => {
    const german = leaves(de);
    // Product terms, technical names and words that are the same in both languages.
    const SAME = new Set([
      "title",
      "version.title",
      "install.version",
      "install.lead",
      "check.status.available.detail",
      "maintenance.modal.percent",
      "source.providers.github",
      "source.channel.beta.label",
      "steps.status.pending",
      "dumps.title",
      "edition.title",
    ]);
    const untranslated = [...leaves(en)]
      .filter(([key, text]) => german.get(key) === text && !SAME.has(key))
      .map(([key]) => key);
    expect(untranslated).toEqual([]);
  });

  it("contain every literal key the feature uses", () => {
    const literal = [
      ...collect(/\bt\(\s*"([^"]+)"/g, "updates"),
      ...collect(/\btc\(\s*"([^"]+)"/g, "common"),
      ...collect(/"((?:updates|common):[\w.]+)"/g, "updates"),
    ];
    expect(literal.length).toBeGreaterThan(120);
    for (const [file, namespace, key] of literal) {
      const tree = namespaces[namespace];
      expect(tree, `${file}: unknown namespace ${namespace}`).toBeDefined();
      expect(typeof lookup(tree as Tree, key), `${file}: ${namespace}:${key}`).toBe("string");
    }
  });

  it("contain the groups that dynamic keys are built from", () => {
    const dynamic = collect(/\bt\(\s*`([\w.]+)\.\$\{/g, "updates");
    expect(dynamic.length).toBeGreaterThan(8);
    for (const [file, namespace, prefix] of dynamic) {
      const node = lookup(namespaces[namespace] as Tree, prefix);
      expect(typeof node, `${file}: ${namespace}:${prefix}.*`).toBe("object");
    }
  });

  it("cover every value the dynamic keys are built from", () => {
    const keys: string[] = [
      ...CHECK_ERROR_CODES.map(checkErrorKey),
      "check.errors.rate_limitedUntil",
      "check.errors.unknown",
      ...FAILURE_CODES.map(failureKey),
      failureKey("unknown"),
      ...BLOCKER_CODES.map(blockerKey),
      "updater.blockers.unknown",
      ...LEAD_TIME_PRESETS.map((seconds) => leadTimeLabel(seconds).key),
      leadTimeLabel(7200).key,
      ...UPDATE_STEPS.map((id) => stepLabelKey(id)),
      stepLabelKey("fetch", "image"),
      stepLabelKey("fetch", "source"),
      ...STEP_STATUSES.map(stepStatusKey),
      ...UPDATE_MESSAGE_CODES.map((code) => maintenanceMessageKey(code)),
      ...UPDATE_MESSAGE_CODES.map((code) => maintenanceMessageKey(code, "full")),
      ...([
        "run.titleSwitch",
        "run.titleActiveSwitch",
        "run.versionSwitch",
        "run.outcomeNote.succeededSwitch",
        "updater.busy.scheduledTitleSwitch",
        "updater.busy.runningTitleSwitch",
        "maintenance.banner.scheduledSwitch",
        "maintenance.banner.startingSwitch",
        "maintenance.banner.runningSwitch",
        "maintenance.announce.startSwitch",
        "maintenance.modal.running.titleSwitch",
        "maintenance.modal.running.titleSwitchNoVersion",
        "maintenance.modal.succeeded.titleSwitch",
        "maintenance.modal.succeeded.descriptionSwitch",
      ] as const),
      ...(["unchanged", "rolledBack", "needsAttention", "generic"] as const).map(
        (group) => `maintenance.modal.failed.${group}.titleSwitch`,
      ),
      "maintenance.modal.failed.unchanged.descriptionSwitch",
      "maintenance.modal.failed.rolledBack.descriptionSwitch",
      ...(["scheduled", "running", "cancelled", "failed", ...RUN_OUTCOMES] as const).map(
        (kind) => `run.status.${kind}`,
      ),
      ...RUN_OUTCOMES.filter((outcome) => outcome !== "needs_attention").map(
        (outcome) => `run.outcomeNote.${outcome}`,
      ),
      ...(["tooLong", "invalid", "protocol"] as const).map(sourceUrlIssueKey),
      ...(["github", "forgejo", "feed"] as const).map((provider) => `source.providers.${provider}`),
      ...(["image", "source"] as const).flatMap((mode) => [
        `source.mode.${mode}.label`,
        `source.mode.${mode}.description`,
        `manual.${mode}.title`,
        `manual.${mode}.hint`,
      ]),
      ...(["stable", "beta"] as const).flatMap((channel) => [
        `source.channel.${channel}.label`,
        `source.channel.${channel}.description`,
      ]),
      ...(["off", "pending", "upToDate", "comparisonUnavailable", "failed"] as const).map(
        (kind) => `check.status.${kind}.title`,
      ),
      ...(["off", "pending", "upToDate", "comparisonUnavailable"] as const).map(
        (kind) => `check.status.${kind}.description`,
      ),
      "check.status.available.title",
      ...(["disabled", "pending", "ok", "failed"] as const).map(
        (state) => `releases.empty.${state}`,
      ),
      ...(["unavailable", "ready", "blocked", "busy", "demo"] as const).map(
        (state) => `updater.description.${state}`,
      ),
      ...(["pending", "failed", "skipped", "on", "legacy"] as const).map(
        (kind) => `updater.selfUpdate.${kind}`,
      ),
      ...SELF_UPDATE_REASONS.map((reason) => `updater.selfUpdate.reasons.${reason}`),
      "updater.enable.image",
      "updater.enable.imageGeneric",
      ...(["copy", "stop", "restore", "images", "start"] as const).map(
        (id) => `recovery.steps.${id}`,
      ),
      ...(["start", "minute", "seconds", "starting"] as const).map(
        (stage) => `maintenance.announce.${stage}`,
      ),
      ...(["unchanged", "rolledBack", "needsAttention", "generic"] as const).flatMap((group) =>
        group === "needsAttention"
          ? [`maintenance.modal.failed.${group}.title`]
          : [
              `maintenance.modal.failed.${group}.title`,
              `maintenance.modal.failed.${group}.description`,
            ],
      ),
      ...["span.seconds", "span.minutes", "span.hours"],
    ];
    const missing = keys.filter((key) => typeof lookup(en, key) !== "string");
    expect(missing).toEqual([]);
    expect(keys.length).toBeGreaterThan(150);
  });

  it("have a text for every failure code, also in German", () => {
    for (const code of FAILURE_CODES) {
      expect(typeof lookup(de, `failure.${code}`), code).toBe("string");
    }
  });

  it("give the settings tab its label", () => {
    expect((commonDe as Tree).app).toBeDefined();
    expect(typeof lookup(namespaces.updates as Tree, "title")).toBe("string");
  });
});

describe("plural and formatted messages", () => {
  const format = (language: "en" | "de", key: string, values: Record<string, unknown>) =>
    i18n.getFixedT(language, "updates")(key, values);

  it("read naturally in both languages", () => {
    expect(format("en", "span.minutes", { count: 1 })).toBe("1 minute");
    expect(format("en", "span.minutes", { count: 5 })).toBe("5 minutes");
    expect(format("de", "span.minutes", { count: 1 })).toBe("1 Minute");
    expect(format("de", "span.minutes", { count: 15 })).toBe("15 Minuten");
    expect(format("en", "span.hours", { count: 1 })).toBe("1 hour");
    expect(format("de", "span.seconds", { count: 10 })).toBe("10 Sekunden");
    expect(format("en", "lead.custom", { minutes: 1 })).toBe("In 1 minute");
    expect(format("de", "lead.custom", { minutes: 45 })).toBe("In 45 Minuten");
  });

  it("fill the sentences the shell speaks", () => {
    expect(
      format("en", "maintenance.banner.scheduled", {
        time: "04:32",
        product: "Acme",
        version: "0.2.0",
      }),
    ).toBe("Maintenance in 04:32: Acme will be updated to version 0.2.0. Save your work.");
    expect(
      format("de", "maintenance.banner.scheduled", {
        time: "04:32",
        product: "Acme",
        version: "0.2.0",
      }),
    ).toBe(
      "Wartung in 04:32: Acme wird auf Version 0.2.0 aktualisiert. Speichern Sie Ihre Arbeit.",
    );
    expect(
      format("en", "maintenance.modal.running.title", { product: "Acme", version: "0.2.0" }),
    ).toBe("Acme is being updated to version 0.2.0");
    expect(
      format("de", "check.status.available.detailDated", { tag: "v0.2.0", date: "28.09.2026" }),
    ).toBe("Tag v0.2.0, veröffentlicht am 28.09.2026.");
  });

  it("nest failure codes that contain a dot", () => {
    expect(format("en", failureKey("fetch.pull_failed"), {})).toBe(
      "The new image could not be downloaded.",
    );
    expect(format("de", failureKey("interrupted"), {})).toContain("unterbrochen");
    expect(format("en", outcomeKey("rolled_back"), {})).toBe("run.outcomes.rolled_back");
  });

  it("agree with the span the presenters pick", () => {
    const span = spanLabel(300);
    expect(format("en", span.key, { count: span.count })).toBe("5 minutes");
  });
});
