import { deflateSync } from "node:zlib";
import { crc32 } from "../images.js";

/** A PNG chunk with its length and CRC. */
export function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A valid RGB PNG of one colour, with optional extra chunks before the image data. */
export function testPng(
  width: number,
  height: number,
  options: { before?: Buffer[]; after?: Buffer[]; rgb?: [number, number, number] } = {},
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const [r, g, b] = options.rgb ?? [29, 78, 216];
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...(options.before ?? []),
    pngChunk("IDAT", deflateSync(raw)),
    ...(options.after ?? []),
    pngChunk("IEND"),
  ]);
}

function segment(marker: number, data: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

/**
 * A structurally valid baseline JPEG (markers, frame header, one scan), with EXIF and a comment
 * the upload has to strip. Its scan data is not a real picture: the PDF library reads only the
 * structure, as a mail client would reject nothing about it.
 */
export function testJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(15);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  for (let component = 0; component < 3; component++) {
    sof[6 + component * 3] = component + 1;
    sof[7 + component * 3] = 0x11;
    sof[8 + component * 3] = 0;
  }
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
    segment(0xe1, Buffer.from("Exif\0\0GPS 52.52N 13.40E secret-camera", "latin1")),
    segment(0xfe, Buffer.from("made by someone@example.com", "latin1")),
    segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    segment(0xc0, sof),
    segment(0xc4, Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 0), Buffer.alloc(0)])),
    segment(0xda, Buffer.from([3, 1, 0, 2, 0, 3, 0, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0x56, 0x78]),
    Buffer.from([0xff, 0xd9]),
  ]);
}
