import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import resolveImage from "@react-pdf/image";
import { ProblemError } from "../../problem.js";

/**
 * Logo uploads (0.5.0, docs/NOTIFICATIONS.md "Branding"): PNG or JPEG only, checked and stripped
 * in pure TypeScript before anything is stored.
 *
 *   - Every SVG is refused (`svg-not-supported`), whatever type it was sent as: an SVG can carry
 *     scripts and external references, and rasterising it would need a native library the stack
 *     does not have. GIF, WebP and other formats are refused too (`unsupported-type`), and so is
 *     an animated PNG (an `acTL` chunk, `animated`).
 *   - At most 512 KiB, 16 to 2000 pixels per side and 4 megapixels (`too-large`, `dimensions`).
 *   - A PNG's header must be one the specification allows (colour type and bit depth, compression,
 *     filter and interlace method), and its image data must inflate to exactly the size the header
 *     announces, inflated with that size as the limit: a small file whose data inflates to far
 *     more (a decompression bomb) is refused before it costs memory (`corrupt`).
 *   - Metadata goes: of a PNG every chunk but the image's own (`IHDR`, `PLTE`, `IDAT`, `IEND`)
 *     and the few that change how it looks (`tRNS`, `gAMA`, `cHRM`, `sRGB`, `sBIT`, `bKGD`,
 *     `pHYs`), so text, time, EXIF, the compressed ICC profile (`iCCP`) and unknown chunks are
 *     dropped (an unknown critical chunk is refused, `corrupt`); of a JPEG the APP1 to APP15
 *     segments (EXIF, XMP, ICC and the rest) except APP14 (Adobe colour transform, which decoding
 *     needs) and comments. The image data itself is kept as it is.
 *   - The result is decoded once with the PDF library's image reader, so a report never fails on
 *     it later (`corrupt`).
 */

export const MAX_LOGO_BYTES = 512 * 1024;
export const MIN_LOGO_SIDE = 16;
export const MAX_LOGO_SIDE = 2000;
export const MAX_LOGO_PIXELS = 4_000_000;

export type LogoContentType = "image/png" | "image/jpeg";

export interface ValidatedLogo {
  readonly contentType: LogoContentType;
  /** The image without its metadata. */
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

export type LogoProblemCode =
  | "svg-not-supported"
  | "unsupported-type"
  | "too-large"
  | "dimensions"
  | "corrupt"
  | "animated";

export const UNSUPPORTED_IMAGE_PROBLEM = "urn:restow:problem:unsupported-image";
export const INVALID_IMAGE_PROBLEM = "urn:restow:problem:invalid-image";

function logoProblem(code: LogoProblemCode, detail: string): ProblemError {
  const unsupported = code === "svg-not-supported" || code === "unsupported-type";
  return new ProblemError(
    unsupported ? 415 : 422,
    unsupported ? "Unsupported image" : "Invalid image",
    {
      type: unsupported ? UNSUPPORTED_IMAGE_PROBLEM : INVALID_IMAGE_PROBLEM,
      detail,
      extensions: { code, field: "logo" },
    },
  );
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The PNG chunks a stored logo keeps: the image's own and the few that change how it looks. */
const PNG_KEPT_CHUNKS: ReadonlySet<string> = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "sBIT",
  "bKGD",
  "pHYs",
]);

/** The bit depths the PNG specification allows per colour type, and its channels. */
const PNG_COLOUR_TYPES: ReadonlyMap<number, { depths: readonly number[]; channels: number }> =
  new Map([
    [0, { depths: [1, 2, 4, 8, 16], channels: 1 }], // greyscale
    [2, { depths: [8, 16], channels: 3 }], // RGB
    [3, { depths: [1, 2, 4, 8], channels: 1 }], // palette
    [4, { depths: [8, 16], channels: 2 }], // greyscale with alpha
    [6, { depths: [8, 16], channels: 4 }], // RGB with alpha
  ]);

/** The Adam7 passes: first column, first row, column step, row step. */
const ADAM7_PASSES: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colourType: number;
  readonly interlace: number;
}

/**
 * The exact size of a PNG's image data once inflated: per row (of each Adam7 pass when
 * interlaced) one filter byte and the row's bytes. A pass without columns or rows has no rows.
 */
export function pngRawSize(header: PngHeader): number {
  const channels = PNG_COLOUR_TYPES.get(header.colourType)?.channels ?? 0;
  const bitsPerPixel = channels * header.bitDepth;
  const rows = (width: number, height: number) =>
    width === 0 || height === 0 ? 0 : height * (1 + Math.ceil((width * bitsPerPixel) / 8));
  if (header.interlace === 0) {
    return rows(header.width, header.height);
  }
  let total = 0;
  for (const [x0, y0, dx, dy] of ADAM7_PASSES) {
    total += rows(
      Math.max(0, Math.ceil((header.width - x0) / dx)),
      Math.max(0, Math.ceil((header.height - y0) / dy)),
    );
  }
  return total;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as PNG computes it. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Whether the bytes look like an SVG (or any XML/HTML document), however it was declared. */
export function looksLikeSvg(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 4096).toString("utf8").replace(/^﻿/, "").trimStart();
  if (head.startsWith("<")) {
    return true;
  }
  return /<svg[\s>]/i.test(head);
}

interface ParsedImage {
  contentType: LogoContentType;
  bytes: Buffer;
  width: number;
  height: number;
  /** A PNG's header, for the inflated size of its image data. */
  png?: PngHeader;
}

function parsePng(bytes: Buffer): ParsedImage {
  const kept: Buffer[] = [PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.length;
  let header: PngHeader | null = null;
  let sawData = false;
  let sawEnd = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw logoProblem("corrupt", "The PNG file is truncated.");
    }
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > bytes.length || !/^[A-Za-z]{4}$/.test(type)) {
      throw logoProblem("corrupt", "The PNG file is truncated or malformed.");
    }
    const chunk = bytes.subarray(offset, end);
    const crc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== crc) {
      throw logoProblem("corrupt", `The PNG chunk ${type} is damaged.`);
    }
    if (!header) {
      if (type !== "IHDR" || length !== 13) {
        throw logoProblem("corrupt", "The PNG file does not start with its header.");
      }
      header = pngHeaderOf(bytes.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IHDR") {
      throw logoProblem("corrupt", "The PNG file has more than one header.");
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw logoProblem("animated", "Animated PNG files are not supported.");
    }
    if (type === "IDAT") {
      sawData = true;
    }
    // An unknown critical chunk (upper-case first letter) cannot be skipped by a decoder.
    if (!PNG_KEPT_CHUNKS.has(type) && type.charCodeAt(0) < 0x61) {
      throw logoProblem("corrupt", `The PNG chunk ${type} is not supported.`);
    }
    if (PNG_KEPT_CHUNKS.has(type)) {
      kept.push(chunk);
    }
    offset = end;
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!header || !sawData || !sawEnd) {
    throw logoProblem("corrupt", "The PNG file is incomplete.");
  }
  return {
    contentType: "image/png",
    bytes: Buffer.concat(kept),
    width: header.width,
    height: header.height,
    png: header,
  };
}

/** A PNG header the specification allows; anything else is `corrupt`. */
function pngHeaderOf(data: Buffer): PngHeader {
  const header: PngHeader = {
    width: data.readUInt32BE(0),
    height: data.readUInt32BE(4),
    bitDepth: data[8] ?? 0,
    colourType: data[9] ?? 0,
    interlace: data[12] ?? 0,
  };
  const colour = PNG_COLOUR_TYPES.get(header.colourType);
  if (
    !colour?.depths.includes(header.bitDepth) ||
    data[10] !== 0 || // compression method: deflate
    data[11] !== 0 || // filter method: adaptive
    (header.interlace !== 0 && header.interlace !== 1)
  ) {
    throw logoProblem("corrupt", "The PNG header is not valid.");
  }
  return header;
}

/** JPEG markers of a frame header (baseline, progressive, lossless, arithmetic). */
const SOF_MARKERS: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function parseJpeg(bytes: Buffer): ParsedImage {
  const kept: Buffer[] = [bytes.subarray(0, 2)];
  let offset = 2;
  let width = 0;
  let height = 0;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw logoProblem("corrupt", "The JPEG file is malformed.");
    }
    // Fill bytes before a marker.
    let markerAt = offset;
    while (bytes[markerAt + 1] === 0xff) {
      markerAt++;
    }
    const marker = bytes[markerAt + 1];
    if (marker === undefined) {
      throw logoProblem("corrupt", "The JPEG file is truncated.");
    }
    if (marker === 0xd9) {
      throw logoProblem("corrupt", "The JPEG file has no image data.");
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(bytes.subarray(markerAt, markerAt + 2));
      offset = markerAt + 2;
      continue;
    }
    if (markerAt + 4 > bytes.length) {
      throw logoProblem("corrupt", "The JPEG file is truncated.");
    }
    const length = bytes.readUInt16BE(markerAt + 2);
    const end = markerAt + 2 + length;
    if (length < 2 || end > bytes.length) {
      throw logoProblem("corrupt", "The JPEG file is truncated.");
    }
    if (SOF_MARKERS.has(marker)) {
      if (length < 8) {
        throw logoProblem("corrupt", "The JPEG frame header is malformed.");
      }
      height = bytes.readUInt16BE(markerAt + 5);
      width = bytes.readUInt16BE(markerAt + 7);
    }
    const metadata = (marker >= 0xe1 && marker <= 0xef && marker !== 0xee) || marker === 0xfe;
    if (!metadata) {
      kept.push(bytes.subarray(markerAt, end));
    }
    offset = end;
    if (marker === 0xda) {
      // Start of scan: the entropy-coded data (and any further scans) follow up to EOI.
      const rest = bytes.subarray(offset);
      if (rest.length < 2 || rest[rest.length - 2] !== 0xff || rest[rest.length - 1] !== 0xd9) {
        throw logoProblem("corrupt", "The JPEG file is truncated.");
      }
      kept.push(rest);
      if (width === 0 || height === 0) {
        throw logoProblem("corrupt", "The JPEG file has no frame header.");
      }
      return { contentType: "image/jpeg", bytes: Buffer.concat(kept), width, height };
    }
  }
  throw logoProblem("corrupt", "The JPEG file is truncated.");
}

/** Decode the image once the way the PDF reports will; throws `corrupt` when it cannot. */
async function decodeCheck(image: ParsedImage): Promise<void> {
  let decoded: Awaited<ReturnType<typeof resolveImage>> = null;
  try {
    if (image.png) {
      // The PDF reader keeps PNG data compressed; inflating it proves the stream is whole. The
      // header says exactly how large the data is: never inflate more (a decompression bomb
      // stops at the limit), and refuse data of any other size.
      const expected = pngRawSize(image.png);
      const idat = Buffer.concat(pngChunks(image.bytes, "IDAT"));
      const raw = inflateSync(idat, { maxOutputLength: expected + 1 });
      if (raw.length !== expected) {
        throw new Error("The image data does not match the header.");
      }
    }
    decoded = await resolveImage(
      { data: image.bytes, format: image.contentType === "image/png" ? "png" : "jpg" },
      { cache: false },
    );
  } catch {
    throw logoProblem("corrupt", "The image cannot be decoded.");
  }
  if (!decoded || decoded.width !== image.width || decoded.height !== image.height) {
    throw logoProblem("corrupt", "The image cannot be decoded.");
  }
}

/** The data of every chunk of `type` of a (checked) PNG. */
function pngChunks(bytes: Buffer, type: string): Buffer[] {
  const found: Buffer[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("latin1", offset + 4, offset + 8) === type) {
      found.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  return found;
}

/**
 * Check an uploaded logo and strip its metadata: the stored image, or the problem the API
 * answers with (415 `unsupported-image`, 422 `invalid-image`, `extensions.code` says which).
 */
export async function validateLogo(
  bytes: Buffer,
  declaredType: string | null,
): Promise<ValidatedLogo> {
  const declared = (declaredType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (declared === "image/svg+xml" || looksLikeSvg(bytes)) {
    throw logoProblem(
      "svg-not-supported",
      "SVG logos are not accepted; upload the logo as a PNG or JPEG file.",
    );
  }
  if (declared !== "image/png" && declared !== "image/jpeg" && declared !== "image/jpg") {
    throw logoProblem("unsupported-type", "Only PNG and JPEG logos are accepted.");
  }
  if (bytes.length > MAX_LOGO_BYTES) {
    throw logoProblem("too-large", "The logo may be at most 512 KiB.");
  }
  let parsed: ParsedImage;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    parsed = parsePng(bytes);
  } else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    parsed = parseJpeg(bytes);
  } else {
    throw logoProblem("unsupported-type", "Only PNG and JPEG logos are accepted.");
  }
  const { width, height } = parsed;
  if (
    width < MIN_LOGO_SIDE ||
    height < MIN_LOGO_SIDE ||
    width > MAX_LOGO_SIDE ||
    height > MAX_LOGO_SIDE ||
    width * height > MAX_LOGO_PIXELS
  ) {
    throw logoProblem(
      "dimensions",
      "The logo must be 16 to 2000 pixels on each side and at most 4 megapixels.",
    );
  }
  await decodeCheck(parsed);
  return {
    contentType: parsed.contentType,
    bytes: parsed.bytes,
    width,
    height,
    sha256: createHash("sha256").update(parsed.bytes).digest("hex"),
  };
}
