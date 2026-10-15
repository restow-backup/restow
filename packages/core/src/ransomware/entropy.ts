/**
 * Shannon entropy of file samples (docs/RANSOMWARE.md, "Entropy"). Encrypted data looks like
 * random bytes: close to 8 bits per byte. So do compressed formats (ZIP, the Office XML files,
 * JPEG, video, PDF streams), which is why those are left out entirely; for the formats that
 * hold plain or lightly structured data (text, CSV, the old Office files, bitmaps, WAV) a value
 * near 8 is a strong sign that the file is no longer what its name says.
 *
 * Runners measure the first and the last 64 KiB of a handful of new or changed files they read
 * anyway (`head`, `tail`); the server judges them here by the file type's expectation.
 */
import { extensionOf, normaliseExtension } from "./signatures.js";

/** How many bytes of the start and of the end of a file are measured. */
export const ENTROPY_SAMPLE_BYTES = 64 * 1024;

/** Shannon entropy in bits per byte (0 for no data, at most 8). */
export function shannonEntropy(data: Uint8Array): number {
  if (data.length === 0) {
    return 0;
  }
  const counts = new Uint32Array(256);
  for (const byte of data) {
    counts[byte] = (counts[byte] ?? 0) + 1;
  }
  let bits = 0;
  for (const count of counts) {
    if (count > 0) {
      const p = count / data.length;
      bits -= p * Math.log2(p);
    }
  }
  return bits;
}

/**
 * Formats that are compressed or encrypted by design: their entropy says nothing, they are
 * never judged (and runners prefer other files when they pick samples).
 */
export const COMPRESSED_EXTENSIONS: readonly string[] = [
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "zst",
  "lz4",
  "lzma",
  "cab",
  "jar",
  "war",
  "apk",
  "ipa",
  "msi",
  "msix",
  "appx",
  "docx",
  "xlsx",
  "pptx",
  "docm",
  "xlsm",
  "pptm",
  "odt",
  "ods",
  "odp",
  "epub",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "heic",
  "heif",
  "avif",
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "flac",
  "mp4",
  "m4v",
  "mov",
  "mkv",
  "avi",
  "wmv",
  "webm",
  "pdf",
  "dmg",
  "iso",
  "vhd",
  "vhdx",
  "vmdk",
  "qcow2",
  "kdbx",
  "gpg",
  "pgp",
  "age",
  "enc",
  "p12",
  "pfx",
  "pst",
  "ost",
  "nupkg",
  "whl",
  "deb",
  "rpm",
];

/**
 * Formats whose content is plain or lightly structured: well below 8 bits per byte as long as
 * the file is intact. One measured window near 8 is enough for such a file.
 */
export const PLAIN_EXTENSIONS: readonly string[] = [
  "txt",
  "csv",
  "tsv",
  "log",
  "md",
  "xml",
  "json",
  "html",
  "htm",
  "rtf",
  "sql",
  "ini",
  "cfg",
  "conf",
  "yaml",
  "yml",
  "doc",
  "xls",
  "ppt",
  "bmp",
  "wav",
  "tif",
  "tiff",
  "svg",
  "ps",
  "eps",
  "tex",
  "c",
  "h",
  "cpp",
  "cs",
  "js",
  "py",
  "java",
  "go",
  "php",
  "rb",
  "sh",
  "bat",
  "ps1",
  "dbf",
  "eml",
  "vcf",
  "ics",
];

const COMPRESSED = new Set(COMPRESSED_EXTENSIONS);
const PLAIN = new Set(PLAIN_EXTENSIONS);

/** What a file type leads to expect of its entropy. */
export type EntropyExpectation = "compressed" | "plain" | "unknown";

/** The expectation of a file type by its extension (with or without the dot) or its name. */
export function entropyExpectation(extensionOrName: string): EntropyExpectation {
  const ext = extensionOrName.includes(".")
    ? extensionOf(extensionOrName) || normaliseExtension(extensionOrName)
    : normaliseExtension(extensionOrName);
  if (COMPRESSED.has(ext)) return "compressed";
  if (PLAIN.has(ext)) return "plain";
  return "unknown";
}

/** One measured file as a runner reports it. `tail` is null for a file of one window or less. */
export interface EntropySample {
  path: string;
  /** The file's extension, lower case, without the dot ("" for none). */
  ext: string;
  size: number;
  head: number;
  tail: number | null;
}

/**
 * Whether a sample looks encrypted: a plain format with either window at or above `bits`, any
 * other uncompressed format with both windows there (one window of a file of unknown type may be
 * an embedded image). Compressed formats are never judged: null.
 */
export function looksEncrypted(sample: EntropySample, bits: number): boolean | null {
  const expectation = entropyExpectation(sample.ext);
  if (expectation === "compressed") {
    return null;
  }
  const head = sample.head >= bits;
  const tail = sample.tail === null ? head : sample.tail >= bits;
  return expectation === "plain" ? head || tail : head && tail;
}

/**
 * Measure a file's start and end windows (what the OneDrive backup does for the few files it
 * samples while they stream through). `head` holds up to the first {@link ENTROPY_SAMPLE_BYTES},
 * `tail` the last ones; a file no longer than one window has no tail.
 */
export function entropySampleOf(
  path: string,
  size: number,
  head: Uint8Array,
  tail: Uint8Array | null,
): EntropySample {
  return {
    path,
    ext: extensionOf(path),
    size,
    head: round(shannonEntropy(head)),
    tail: tail && size > ENTROPY_SAMPLE_BYTES ? round(shannonEntropy(tail)) : null,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
