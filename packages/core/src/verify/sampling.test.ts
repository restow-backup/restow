import { describe, expect, it } from "vitest";
import type { ManifestObject } from "../manifest.js";
import { pickRandom, seededRandom } from "./random.js";
import {
  DEFAULT_SAMPLE_SIZE,
  planFull,
  planSample,
  quotaFor,
  SAMPLED_VERSIONS_PER_FILE,
  sampleCategoryOf,
} from "./sampling.js";

function object(path: string, type: string | undefined, size = 100): ManifestObject {
  return {
    path,
    size,
    mtime: 0,
    ...(type !== undefined ? { type } : {}),
    chunks: size > 0 ? [`${path}-chunk`] : [],
  };
}

function snapshot(mails: number, files: number, events = 0, contacts = 0): ManifestObject[] {
  return [
    object("mail", "folder", 0),
    ...Array.from({ length: mails }, (_, i) => object(`mail/Inbox/${i}.eml`, "mail")),
    ...Array.from({ length: files }, (_, i) => object(`Documents/${i}.docx`, "file")),
    ...Array.from({ length: events }, (_, i) => object(`calendar/Calendar/${i}`, "event")),
    ...Array.from({ length: contacts }, (_, i) => object(`contacts/Contacts/${i}`, "contact")),
  ];
}

describe("sampleCategoryOf", () => {
  it("classifies content objects and ignores everything without content of its own", () => {
    expect(sampleCategoryOf(object("mail/Inbox/1.eml", "mail"))).toBe("mail");
    expect(sampleCategoryOf(object("INBOX/1.eml", "message"))).toBe("mail");
    expect(sampleCategoryOf(object("Documents/a.pdf", "file"))).toBe("file");
    expect(sampleCategoryOf(object("Documents/untyped.bin", undefined))).toBe("file");
    expect(sampleCategoryOf(object("calendar/Calendar/1", "event"))).toBe("event");
    expect(sampleCategoryOf(object("contacts/Contacts/1", "contact"))).toBe("contact");
    expect(sampleCategoryOf(object("mail/Inbox", "folder", 0))).toBeNull();
    expect(sampleCategoryOf(object("Documents/empty.txt", "file", 0))).toBeNull();
    // Not drawn on their own: read back as parts of their file or message (planSample, planFull).
    expect(sampleCategoryOf(object("Documents/a.pdf:versions/1", "file-version"))).toBeNull();
    expect(sampleCategoryOf(object("Notebooks/Work", "package"))).toBeNull();
    expect(sampleCategoryOf(object("mail/Inbox/1/att", "attachment"))).toBeNull();
  });

  it("reads a site's own JSON objects back as site content, never empty or chunkless ones", () => {
    expect(sampleCategoryOf(object("site.json", "site-info", 3800))).toBe("site");
    expect(sampleCategoryOf(object("Lists/Tasks/_list.json", "list-schema"))).toBe("site");
    expect(sampleCategoryOf(object("Lists/Tasks/Item (1).json", "list-item"))).toBe("site");
    expect(sampleCategoryOf(object("site.json", "site-info", 0))).toBeNull();
    expect(
      sampleCategoryOf({ ...object("Lists/Tasks/Item (2).json", "list-item"), chunks: [] }),
    ).toBeNull();
    expect(sampleCategoryOf(object("Lists/Tasks", "folder", 0))).toBeNull();
  });
});

describe("quotaFor", () => {
  it("draws 20 mails and 20 files by default and a quarter of that for calendar, contacts and sites [VERIFY-001]", () => {
    expect(quotaFor()).toEqual({ mail: 20, file: 20, event: 5, contact: 5, site: 5 });
    expect(quotaFor(DEFAULT_SAMPLE_SIZE)).toEqual(quotaFor());
    expect(quotaFor(1)).toEqual({ mail: 1, file: 1, event: 1, contact: 1, site: 1 });
    expect(quotaFor(0).mail).toBe(1);
  });
});

describe("planSample", () => {
  it("draws up to the quota per category and counts what was eligible [VERIFY-001]", () => {
    const plan = planSample(snapshot(120, 45, 30, 2), quotaFor(), seededRandom(7));
    const byCategory = (category: string) =>
      plan.items.filter((item) => item.category === category).length;
    expect(byCategory("mail")).toBe(20);
    expect(byCategory("file")).toBe(20);
    expect(byCategory("event")).toBe(5);
    expect(byCategory("contact")).toBe(2);
    expect(plan.eligible).toEqual({ mail: 120, file: 45, event: 30, contact: 2, site: 0 });
  });

  it("draws a site's JSON objects at the secondary share, at least one", () => {
    const site = [
      object("site.json", "site-info", 3800),
      object("Libraries/Documents", "folder", 0),
      object("Lists/Tasks", "folder", 0),
      object("Lists/Tasks/_list.json", "list-schema", 2000),
      ...Array.from({ length: 12 }, (_, i) =>
        object(`Lists/Tasks/Item (${i}).json`, "list-item", 500),
      ),
    ];
    const plan = planSample(site, quotaFor(), seededRandom(3));
    expect(plan.eligible).toEqual({ mail: 0, file: 0, event: 0, contact: 0, site: 14 });
    expect(plan.items.every((item) => item.category === "site")).toBe(true);
    expect(plan.items).toHaveLength(5);
    const only = planSample(site.slice(0, 2), quotaFor(1), seededRandom(3));
    expect(only.items.map((item) => item.object.path)).toEqual(["site.json"]);
  });

  it("takes everything when a category holds fewer objects than the quota", () => {
    const plan = planSample(snapshot(3, 0), quotaFor(), seededRandom(1));
    expect(plan.items.map((item) => item.object.path)).toEqual([
      "mail/Inbox/0.eml",
      "mail/Inbox/1.eml",
      "mail/Inbox/2.eml",
    ]);
  });

  it("never draws the same object twice and keeps snapshot order", () => {
    const plan = planSample(snapshot(500, 0), quotaFor(), seededRandom(99));
    const paths = plan.items.map((item) => item.object.path);
    expect(new Set(paths).size).toBe(paths.length);
    const positions = paths.map((path) => Number(path.split("/")[2]?.split(".")[0]));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("is reproducible from its seed and varies between seeds", () => {
    const objects = snapshot(300, 300);
    const draw = (seed: number) =>
      planSample(objects, quotaFor(), seededRandom(seed)).items.map((item) => item.object.path);
    expect(draw(42)).toEqual(draw(42));
    expect(draw(42)).not.toEqual(draw(43));
  });

  it("returns an empty plan for a snapshot without content", () => {
    const plan = planSample([object("mail", "folder", 0)], quotaFor(), seededRandom(1));
    expect(plan.items).toHaveLength(0);
    expect(plan.eligible).toEqual({ mail: 0, file: 0, event: 0, contact: 0, site: 0 });
  });
});

describe("planFull", () => {
  it("takes every eligible object", () => {
    const plan = planFull(snapshot(30, 25, 4, 4));
    expect(plan.items).toHaveLength(63);
  });
});

describe("pickRandom", () => {
  it("spreads picks over the whole population", () => {
    const population = Array.from({ length: 10 }, (_, i) => i);
    const hits = new Array<number>(10).fill(0);
    const random = seededRandom(2026);
    for (let round = 0; round < 5000; round++) {
      for (const value of pickRandom(population, 2, random)) {
        hits[value]++;
      }
    }
    // Each value is expected 1000 times; allow generous statistical slack.
    for (const count of hits) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1150);
    }
  });
});

describe("parts of messages and files", () => {
  const message: ManifestObject = { ...object("mail/Inbox/Big (A1).json", "mail"), id: "A1" };
  const byPath: ManifestObject = {
    ...object("mail/Inbox/Big (A1).attachments/a.pdf", "attachment"),
    metadata: { messagePath: message.path },
  };
  const byId: ManifestObject = {
    ...object("mail/Inbox/Big (A1).attachments/b.pdf", "attachment"),
    metadata: { messageItemId: "A1" },
  };
  const orphan: ManifestObject = {
    ...object("mail/Gone (Z9).attachments/c.pdf", "attachment"),
    metadata: { messagePath: "mail/Gone (Z9).json" },
  };
  const file = object("Documents/Q3.xlsx", "file");
  const version = object("Documents/Q3.xlsx:versions/1.0", "file-version");
  const objects = [message, byPath, byId, orphan, file, version];

  it("reads a sampled message's attachments and a sampled file's versions with it", () => {
    const plan = planSample(objects, quotaFor(), seededRandom(1));
    const sampled = new Map(plan.items.map((item) => [item.object.path, item.parts ?? []]));
    expect(sampled.get(message.path)?.map((part) => part.path)).toEqual([byPath.path, byId.path]);
    expect(sampled.get(file.path)?.map((part) => part.path)).toEqual([version.path]);
    expect(plan.eligible).toMatchObject({ mail: 1, file: 1 });
  });

  it("reads every part in a health check, an attachment without its message on its own [VERIFY-004]", () => {
    const plan = planFull(objects);
    const read = plan.items.flatMap((item) => [item.object, ...(item.parts ?? [])]);
    expect(read.map((entry) => entry.path).sort()).toEqual(
      objects.map((entry) => entry.path).sort(),
    );
    expect(plan.items.find((item) => item.object.path === orphan.path)?.category).toBe("mail");
    expect(plan.eligible).toMatchObject({ mail: 2, file: 1 });
  });

  it("reads a bounded share of a sampled file's many versions, all of them in a health check [VERIFY-003]", () => {
    const big = object("Documents/Budget.xlsx", "file", 1024);
    const versions = Array.from({ length: 100 }, (_, n) => ({
      ...object(`Documents/Budget.xlsx:versions/${n + 1}.0`, "file-version", 1024),
      mtime: Date.UTC(2026, 0, 1) + n * 86_400_000,
    }));
    const all = [big, ...versions];
    for (const seed of [1, 2, 3]) {
      const plan = planSample(all, quotaFor(), seededRandom(seed));
      const parts = plan.items.find((item) => item.object.path === big.path)?.parts ?? [];
      expect(parts).toHaveLength(SAMPLED_VERSIONS_PER_FILE);
      // The newest and the oldest version are always among them.
      expect(parts.map((part) => part.path)).toEqual(
        expect.arrayContaining([versions[0]?.path, versions[99]?.path]),
      );
    }
    const full = planFull(all);
    expect(full.items.find((item) => item.object.path === big.path)?.parts).toHaveLength(100);
  });

  it("reads in a health check the versions of a file emptied to 0 bytes [VERIFY-004]", () => {
    const emptied = object("Documents/Notes.txt", "file", 0);
    const earlier = object("Documents/Notes.txt:versions/3.0", "file-version", 4096);
    const plan = planFull([emptied, earlier]);
    expect(plan.items.map((item) => item.object.path)).toEqual([earlier.path]);
    expect(plan.eligible.file).toBe(1);
  });
});
