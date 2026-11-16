import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalLayoutJson, layoutSha256, noControlChars } from "./canonical.js";
import { MAX_LAYOUT_BYTES, parseLayoutManifest } from "./manifest.js";

/**
 * The manifests the Go agent writes and owns (agent/internal/baremetal/testdata/manifests): every
 * valid one parses here, encodes to the same bytes and hashes to the same SHA-256, and every
 * invalid one is refused by both sides.
 */
const SHARED_MANIFESTS = fileURLToPath(
  new URL("../../../../../agent/internal/baremetal/testdata/manifests/", import.meta.url),
);

const files = readdirSync(SHARED_MANIFESTS).filter((name) => name.endsWith(".json"));
const valid = files.filter((name) => !name.startsWith("invalid-"));
const invalid = files.filter((name) => name.startsWith("invalid-"));
const read = (name: string) => readFileSync(join(SHARED_MANIFESTS, name), "utf8");

describe("the shared layout manifests", () => {
  it("has valid and invalid cases", () => {
    expect(valid.length).toBeGreaterThanOrEqual(2);
    expect(valid).toContain("darwin-minimal.json");
    for (const name of [
      "control-char",
      "u2028",
      "both-platforms",
      "missing-required",
      "blockref-cycle",
      "blockref-dangling",
      "too-large",
      "negative-int",
      "float",
    ]) {
      expect(invalid).toContain(`invalid-${name}.json`);
    }
  });

  it.each(valid)("%s parses, encodes byte for byte and hashes like the agent", (name) => {
    const bytes = read(name);
    const parsed = parseLayoutManifest(JSON.parse(bytes));
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.canonical).toBe(bytes);
    expect(canonicalLayoutJson(JSON.parse(bytes))).toBe(bytes);
    const sha = read(name.replace(/\.json$/, ".sha256")).trim();
    expect(parsed.sha256).toBe(sha);
    expect(layoutSha256(JSON.parse(bytes))).toBe(sha);
  });

  it.each(invalid)("%s is refused", (name) => {
    const bytes = read(name);
    let value: unknown;
    try {
      value = JSON.parse(bytes);
    } catch {
      // Not even JSON: refused before it gets here.
      return;
    }
    const parsed = parseLayoutManifest(value);
    expect(parsed.ok).toBe(false);
  });
});

describe("the canonical encoding", () => {
  it("sorts keys by UTF-8 bytes, not UTF-16 units, and escapes only quote and backslash", () => {
    // UTF-16 puts U+1F600 (its surrogate 0xD83D) before U+FF5E; UTF-8 puts it after (F0 > EF).
    const value = { "\u{1f600}": 1, "～": 2, a: 'x"y\\z/<>&' };
    expect(canonicalLayoutJson(value)).toBe('{"a":"x\\"y\\\\z/<>&","～":2,"\u{1f600}":1}');
  });

  it("leaves out undefined members and keeps array order", () => {
    expect(canonicalLayoutJson({ b: [3, 1, 2], a: undefined, c: null, d: true })).toBe(
      '{"b":[3,1,2],"c":null,"d":true}',
    );
  });

  it("refuses floats, negative and unsafe integers", () => {
    expect(() => canonicalLayoutJson({ a: 1.5 })).toThrow(/integer/);
    expect(() => canonicalLayoutJson({ a: -1 })).toThrow(/integer/);
    expect(() => canonicalLayoutJson({ a: 2 ** 53 })).toThrow(/integer/);
    expect(canonicalLayoutJson({ a: 2 ** 53 - 1 })).toBe('{"a":9007199254740991}');
  });

  it("refuses control characters, U+2028, U+2029 and lone surrogates, in keys too", () => {
    for (const bad of [
      "a\u0000",
      "\u001f",
      "\u007f",
      "\u0085",
      "\u009f",
      " ",
      " ",
      "\ud800",
      "x\udc00",
    ]) {
      expect(noControlChars(bad), JSON.stringify(bad)).toBe(false);
      expect(() => canonicalLayoutJson({ s: bad })).toThrow(/control/);
      expect(() => canonicalLayoutJson({ [bad]: 1 })).toThrow(/control/);
    }
    expect(noControlChars("Grüße \u{1f600}  ")).toBe(true);
  });
});

describe("parseLayoutManifest", () => {
  const example = () =>
    JSON.parse(read("example-debian12-uefi-luks-lvm.json")) as Record<string, unknown>;

  it("keeps a key it does not know, so the value is stored as received", () => {
    const value = { ...example(), futureField: { x: 1 } };
    const parsed = parseLayoutManifest(value);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.canonical).toContain('"futureField":{"x":1}');
  });

  it("refuses a Linux manifest with a macOS key", () => {
    expect(parseLayoutManifest({ ...example(), users: [] })).toMatchObject({ ok: false });
  });

  it("refuses a manifest larger than 512 KiB", () => {
    const value = { ...example(), padding: "x".repeat(MAX_LAYOUT_BYTES) };
    expect(parseLayoutManifest(value)).toMatchObject({ ok: false, reason: /larger than/ });
  });

  it("refuses an unknown platform and a wrong format", () => {
    expect(parseLayoutManifest({ ...example(), platform: "windows" }).ok).toBe(false);
    expect(parseLayoutManifest({ ...example(), format: "restow-layout-v2" }).ok).toBe(false);
    expect(parseLayoutManifest(null).ok).toBe(false);
    expect(parseLayoutManifest("{}").ok).toBe(false);
  });
});
