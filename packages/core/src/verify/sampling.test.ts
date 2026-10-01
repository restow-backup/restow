import { describe, expect, it } from "vitest";
import type { ManifestObject } from "../manifest.js";
import { pickRandom, seededRandom } from "./random.js";
import {
  DEFAULT_SAMPLE_SIZE,
  planFull,
  planSample,
  quotaFor,
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
    expect(sampleCategoryOf(object("Documents/a.pdf:versions/1", "file-version"))).toBeNull();
    expect(sampleCategoryOf(object("Notebooks/Work", "package"))).toBeNull();
    expect(sampleCategoryOf(object("mail/Inbox/1/att", "attachment"))).toBeNull();
  });
});

describe("quotaFor", () => {
  it("draws 20 mails and 20 files by default and a quarter of that for calendar and contacts", () => {
    expect(quotaFor()).toEqual({ mail: 20, file: 20, event: 5, contact: 5 });
    expect(quotaFor(DEFAULT_SAMPLE_SIZE)).toEqual(quotaFor());
    expect(quotaFor(1)).toEqual({ mail: 1, file: 1, event: 1, contact: 1 });
    expect(quotaFor(0).mail).toBe(1);
  });
});

describe("planSample", () => {
  it("draws up to the quota per category and counts what was eligible", () => {
    const plan = planSample(snapshot(120, 45, 30, 2), quotaFor(), seededRandom(7));
    const byCategory = (category: string) =>
      plan.items.filter((item) => item.category === category).length;
    expect(byCategory("mail")).toBe(20);
    expect(byCategory("file")).toBe(20);
    expect(byCategory("event")).toBe(5);
    expect(byCategory("contact")).toBe(2);
    expect(plan.eligible).toEqual({ mail: 120, file: 45, event: 30, contact: 2 });
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
    expect(plan.eligible).toEqual({ mail: 0, file: 0, event: 0, contact: 0 });
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
