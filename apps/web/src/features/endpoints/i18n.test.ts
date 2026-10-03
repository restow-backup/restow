import de from "@restow/i18n/resources/de/endpoints.json" with { type: "json" };
import en from "@restow/i18n/resources/en/endpoints.json" with { type: "json" };
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n.js";

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string"
      ? [[prefix ? `${prefix}.${key}` : key, value] as [string, string]]
      : leaves(value, prefix ? `${prefix}.${key}` : key),
  );
}

const sources = import.meta.glob<string>(
  ["./**/*.ts", "./**/*.tsx", "!./**/*.test.*", "!./dom-harness.tsx"],
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);

/** The keys the feature's source names outright (`t("list.search")`), dynamic ones left out. */
function staticKeys(): Set<string> {
  const keys = new Set<string>();
  for (const source of Object.values(sources)) {
    for (const match of source.matchAll(/\bt\(\s*"([^"$]+)"/g)) {
      // Keys of another namespace (`common:app.name`) are not this feature's.
      if (!(match[1] as string).includes(":")) keys.add(match[1] as string);
    }
    // Keys the presenters hand to components as messages.
    for (const match of source.matchAll(/\bkey:\s*"([a-zA-Z_.]+)"/g)) {
      keys.add(match[1] as string);
    }
  }
  return keys;
}

const VALUES = {
  count: 2,
  hours: 2,
  days: 7,
  min: 5,
  max: 50,
  default: 240,
  name: "web-01",
  person: "Alice Example",
  url: "https://restow.example",
  time: "30 Sep 2026",
  hostname: "web-01",
  id: "abcd1234",
  path: "/etc",
  index: 1,
  kind: "server",
  value: "x",
  done: "1",
  total: "2",
  matched: "19",
  files: "20",
  percent: 12,
  size: "1 GB",
  used: "900 GB",
  budget: "1 TB",
  kept: "40",
  message: "boom",
  status: "ok",
  daily: 30,
  weekly: 12,
  monthly: 12,
  version: 3,
  applied: 2,
  code: 3,
  scripts: "db-dump, fsfreeze",
  tokenFile: "/root/restow-enrollment.token",
  fingerprint: "0123456789abcdef",
  job: "Linux servers, daily",
  sequence: 12,
};

describe("endpoints translations", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("has the same keys in German and English, and no empty text", () => {
    const enKeys = leaves(en as Tree)
      .map(([key]) => key)
      .sort();
    const deKeys = leaves(de as Tree)
      .map(([key]) => key)
      .sort();
    expect(deKeys).toEqual(enKeys);
    for (const [key, value] of [...leaves(en as Tree), ...leaves(de as Tree)]) {
      expect(value.trim(), key).not.toBe("");
    }
  });

  it("has every key the feature's code names, in both languages", () => {
    const enKeys = new Set(leaves(en as Tree).map(([key]) => key));
    const deKeys = new Set(leaves(de as Tree).map(([key]) => key));
    // Guards the scan itself: it must actually find the feature's keys.
    expect(staticKeys().size).toBeGreaterThan(150);
    const missing = [...staticKeys()].filter((key) => !enKeys.has(key) || !deKeys.has(key));
    expect(missing).toEqual([]);
  });

  it("names the product through {appName}, never as a literal word", () => {
    for (const [key, value] of [...leaves(en as Tree), ...leaves(de as Tree)]) {
      // The folder the agent creates, the install location on macOS and the program
      // names are technical and stay literal.
      const prose = value
        .replace(/Restow-Restore/g, "")
        .replace(/\/Library\/Application Support\/Restow\b/g, "");
      expect(prose, key).not.toMatch(/\bRestow\b/);
    }
    expect(i18n.t("endpoints:repositoryKey.title", { appName: "Acme Backup" })).toBe(
      "Restore without Acme Backup",
    );
  });

  it("drops the alpha and planned placeholders of the old section", () => {
    expect(en).not.toHaveProperty("alpha");
    expect(en).not.toHaveProperty("planned");
    expect(de).not.toHaveProperty("alpha");
    expect(JSON.stringify(en).toLowerCase()).not.toContain("not part of this release");
  });

  for (const language of ["en", "de"] as const) {
    it(`formats every ${language} text without leaving a placeholder or a tag behind`, async () => {
      await i18n.changeLanguage(language);
      try {
        for (const [key] of leaves(en as Tree)) {
          const text = String(i18n.t(`endpoints:${key}`, VALUES as never));
          expect(text, key).not.toBe(`endpoints:${key}`);
          expect(text, key).not.toMatch(/\{[a-zA-Z]+[,}]/);
          expect(text, key).not.toMatch(/<\/?[a-z]+>/);
        }
      } finally {
        await i18n.changeLanguage("en");
      }
    });
  }

  it("says Planned and Geplant for Windows and keeps Linux and macOS names", async () => {
    expect(i18n.t("endpoints:enroll.os.planned")).toBe("Planned");
    expect(i18n.t("endpoints:os.darwin")).toBe("macOS");
    await i18n.changeLanguage("de");
    try {
      expect(i18n.t("endpoints:enroll.os.planned")).toBe("Geplant");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("words every state the presenters can return", () => {
    const keys = [
      ...[
        "silent",
        "backup_overdue",
        "last_backup_failed",
        "restore_test_failed",
        "repository_damaged",
        "never_seen",
        "no_job",
      ].flatMap((a) => [`attention.${a}.label`, `attention.${a}.hint`, `attention.${a}.message`]),
      ...["running", "succeeded", "partial", "failed"].map((s) => `runStatus.${s}`),
      ...["backup", "restore", "verify_sample"].flatMap((k) => [`runKind.${k}`, `activity.${k}`]),
      ...["online", "offline", "never", "revoked"].map((s) => `status.${s}`),
      ...["green", "yellow", "red", "unverified", "no_backup"].map((s) => `readiness.state.${s}`),
      ...[
        "interrupted",
        "agent_stopped",
        "no_paths",
        "pre_hook_failed",
        "post_hook_failed",
        "timeout",
        "target_not_empty",
        "invalid_task",
        "hash_mismatch",
        "missing",
        "not_regular",
        "read_error",
        "restic_exit",
        "unknown",
      ].map((code) => `runErrors.${code}`),
      "runStatus.interrupted",
      ...[
        "resticBusy",
        "repositoryLocked",
        "repositoryUnavailable",
        "resticFailed",
        "resticUnavailable",
        "unsupportedOs",
        "revoked",
        "nothingToTest",
        "instanceUnknown",
        "queueNotReady",
        "pathNotFound",
        "tokenSettled",
      ].map((e) => `errors.${e}`),
    ];
    for (const key of keys) {
      expect(i18n.exists(`endpoints:${key}`, { lng: "en" }), key).toBe(true);
      expect(i18n.exists(`endpoints:${key}`, { lng: "de" }), key).toBe(true);
    }
  });
});
