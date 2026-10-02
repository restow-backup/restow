import { describe, expect, it } from "vitest";

import {
  EXCLUSION_PRESETS,
  addOwnPattern,
  excludesProblem,
  ownPatterns,
  parseLargerThanGib,
  patternProblem,
  patternsOfText,
  presetIsOn,
  presetsOn,
  removePattern,
  togglePreset,
} from "./exclusions.js";

const preset = (id: string) => {
  const found = EXCLUSION_PRESETS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe("exclusion presets", () => {
  it("carry the stored patterns the maintainer named", () => {
    expect(preset("videos").patterns).toEqual([
      "*.mp4",
      "*.mkv",
      "*.mov",
      "*.avi",
      "*.wmv",
      "*.m4v",
    ]);
    expect(preset("diskImages").patterns).toEqual([
      "*.iso",
      "*.vhd",
      "*.vhdx",
      "*.vmdk",
      "*.qcow2",
      "*.img",
    ]);
    expect(preset("temporary").patterns).toEqual(["*.tmp", "*.temp", "~$*", "*.swp", "*.part"]);
    expect(preset("installers").patterns).toEqual([
      "*.msi",
      "*.exe",
      "*.dmg",
      "*.pkg",
      "*.deb",
      "*.rpm",
    ]);
    expect(preset("music").patterns).toEqual([
      "*.mp3",
      "*.flac",
      "*.aac",
      "*.m4a",
      "*.wav",
      "*.ogg",
    ]);
    expect(preset("trash").patterns).toEqual([
      "**/.cache",
      "**/.Trash",
      "**/.Trashes",
      "**/.local/share/Trash",
      "**/Library/Caches",
      "**/$RECYCLE.BIN",
    ]);
  });

  it("share no pattern, so switching one never switches another", () => {
    const all = EXCLUSION_PRESETS.flatMap((entry) => [...entry.patterns]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("are valid patterns for the API", () => {
    for (const entry of EXCLUSION_PRESETS) {
      for (const pattern of entry.patterns) {
        expect(patternProblem(pattern), pattern).toBeNull();
      }
    }
  });
});

describe("a chip is on when all of its patterns are in the list", () => {
  it("is off for an empty list, on for a full one and off for a partial one", () => {
    const videos = preset("videos");
    expect(presetIsOn([], videos)).toBe(false);
    expect(presetIsOn([...videos.patterns], videos)).toBe(true);
    expect(presetIsOn(videos.patterns.slice(0, 5), videos)).toBe(false);
    expect(presetsOn([...videos.patterns, "*.bak"])).toEqual(["videos"]);
  });

  it("switching on adds exactly the missing patterns and keeps what was there", () => {
    const temporary = preset("temporary");
    const before = ["*.bak", "*.tmp", "**/Downloads"];
    const after = togglePreset(before, temporary);
    expect(after.slice(0, 3)).toEqual(before);
    expect(new Set(after)).toEqual(new Set([...before, ...temporary.patterns]));
    expect(after.filter((pattern) => pattern === "*.tmp")).toHaveLength(1);
    expect(presetIsOn(after, temporary)).toBe(true);
  });

  it("switching off removes exactly its patterns, nothing else", () => {
    const music = preset("music");
    const before = ["*.bak", ...music.patterns, "**/Downloads"];
    expect(togglePreset(before, music)).toEqual(["*.bak", "**/Downloads"]);
  });

  it("switching on and off again is the identity when the list had none of its patterns", () => {
    const list = ["*.bak", "**/node_modules"];
    const videos = preset("videos");
    expect(togglePreset(togglePreset(list, videos), videos)).toEqual(list);
  });

  it("keeps other chips as they are", () => {
    const list = togglePreset(togglePreset([], preset("videos")), preset("music"));
    expect(presetsOn(list)).toEqual(["videos", "music"]);
    const without = togglePreset(list, preset("videos"));
    expect(presetsOn(without)).toEqual(["music"]);
  });
});

describe("own patterns are what no chip that is on accounts for", () => {
  it("is the rest of the list", () => {
    const list = [...preset("videos").patterns, "*.bak", "**/Downloads"];
    expect(ownPatterns(list)).toEqual(["*.bak", "**/Downloads"]);
  });

  it("shows the patterns of a chip that is only partly there, because that chip is off", () => {
    const partial = preset("temporary").patterns.slice(0, 2);
    expect(ownPatterns(partial)).toEqual(partial);
    // Switching the chip on takes them over: they are no longer "own".
    expect(ownPatterns(togglePreset(partial, preset("temporary")))).toEqual([]);
  });

  it("adds without duplicates and removes wherever a pattern stands", () => {
    expect(addOwnPattern(["*.bak"], "  *.bak  ")).toEqual(["*.bak"]);
    expect(addOwnPattern(["*.bak"], "*.old")).toEqual(["*.bak", "*.old"]);
    expect(addOwnPattern(["*.bak"], "   ")).toEqual(["*.bak"]);
    expect(removePattern(["*.a", "*.b", "*.c"], "*.b")).toEqual(["*.a", "*.c"]);
  });
});

describe("what the API would refuse", () => {
  it("checks one pattern: not empty, no control characters, at most 512 characters", () => {
    expect(patternProblem("   ")).toBe("empty");
    expect(patternProblem("a\nb")).toBe("controlCharacters");
    expect(patternProblem("a\u0000b")).toBe("controlCharacters");
    expect(patternProblem("x".repeat(513))).toBe("tooLong");
    expect(patternProblem("x".repeat(512))).toBeNull();
    expect(patternProblem("**/node_modules")).toBeNull();
  });

  it("checks the list: at most 500 patterns, naming the first bad one", () => {
    expect(excludesProblem(Array.from({ length: 500 }, (_, index) => `*.${index}`))).toBeNull();
    expect(excludesProblem(Array.from({ length: 501 }, (_, index) => `*.${index}`))).toEqual({
      code: "tooMany",
      max: 500,
    });
    expect(excludesProblem(["*.ok", "bad\tpattern"])).toEqual({
      code: "controlCharacters",
      value: "bad\tpattern",
    });
    expect(excludesProblem(["y".repeat(600)])).toMatchObject({ code: "tooLong", max: 512 });
  });

  it("reads pasted lines as patterns", () => {
    expect(patternsOfText("*.a\r\n  *.b  \n\n*.c")).toEqual(["*.a", "*.b", "*.c"]);
  });

  it("reads the size limit in GB: above zero, up to the API's limit, a comma counts as a point", () => {
    expect(parseLargerThanGib("4")).toBe(4);
    expect(parseLargerThanGib("0,5")).toBe(0.5);
    expect(parseLargerThanGib("0")).toBeNull();
    expect(parseLargerThanGib("-1")).toBeNull();
    expect(parseLargerThanGib("")).toBeNull();
    expect(parseLargerThanGib("abc")).toBeNull();
    expect(parseLargerThanGib("1000000")).toBe(1_000_000);
    expect(parseLargerThanGib("1000001")).toBeNull();
  });
});
