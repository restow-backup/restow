import { type ByteSource, ConcatSource, damaged, SliceSource, u64 } from "./source.js";

/**
 * LVM2 physical volumes and the logical volumes they hold, read only from the on-disk label and
 * the text metadata. Linear volumes (one stripe per segment, any number of segments, on any PVs
 * of the guest) are assembled; striped, mirrored, RAID, thin, cache and snapshot volumes are
 * reported as not readable.
 */

const SECTOR = 512;
const MDA_MAGIC = " LVM2 x[5A%r0N*>";
const MAX_METADATA_BYTES = 1024 * 1024;

export interface PhysicalVolume {
  uuid: string;
  source: ByteSource;
  /** The newest metadata text of its volume group, when the PV carries one. */
  metadata: string | null;
}

/** The PV on a device, or null when it carries no LVM2 label. */
export async function readPhysicalVolume(source: ByteSource): Promise<PhysicalVolume | null> {
  if (source.size < 4 * SECTOR) {
    return null;
  }
  const head = await source.read(0, 4 * SECTOR);
  for (let s = 0; s < 4; s++) {
    const at = s * SECTOR;
    if (head.toString("latin1", at, at + 8) !== "LABELONE") {
      continue;
    }
    if (head.toString("latin1", at + 24, at + 32) !== "LVM2 001") {
      continue;
    }
    const pvOffset = at + head.readUInt32LE(at + 20);
    if (pvOffset + 40 + 16 > head.length) {
      throw damaged("the LVM label points outside its sector");
    }
    const uuid = head.toString("latin1", pvOffset, pvOffset + 32);
    // After the UUID and the device size: data areas, then metadata areas, each list ending with zeros.
    let p = pvOffset + 40;
    const areas = (): { offset: number; size: number }[] => {
      const list: { offset: number; size: number }[] = [];
      for (let i = 0; i < 16 && p + 16 <= head.length; i++) {
        const offset = u64(head, p);
        const size = u64(head, p + 8);
        p += 16;
        if (offset === 0 && size === 0) {
          break;
        }
        list.push({ offset, size });
      }
      return list;
    };
    areas(); // the data areas: pe_start comes from the metadata
    const mdas = areas();
    let metadata: string | null = null;
    for (const mda of mdas) {
      metadata = await readMetadataArea(source, mda.offset, mda.size);
      if (metadata) {
        break;
      }
    }
    return { uuid: formatUuid(uuid), source, metadata };
  }
  return null;
}

function formatUuid(raw: string): string {
  const parts = [6, 4, 4, 4, 4, 4, 6];
  const out: string[] = [];
  let at = 0;
  for (const n of parts) {
    out.push(raw.slice(at, at + n));
    at += n;
  }
  return out.join("-");
}

async function readMetadataArea(
  source: ByteSource,
  offset: number,
  size: number,
): Promise<string | null> {
  if (size < 1024 || offset + size > source.size) {
    return null;
  }
  const header = await source.read(offset, 512);
  if (header.toString("latin1", 4, 20) !== MDA_MAGIC) {
    return null;
  }
  const textOffset = u64(header, 40);
  const textSize = u64(header, 48);
  if (textSize === 0 || textSize > MAX_METADATA_BYTES || textOffset >= size) {
    return null;
  }
  // The text area is a ring after the 512-byte header.
  const first = Math.min(textSize, size - textOffset);
  const parts = [await source.read(offset + textOffset, first)];
  if (first < textSize) {
    parts.push(await source.read(offset + 512, textSize - first));
  }
  return Buffer.concat(parts).toString("utf8").replace(/\0+$/, "");
}

// --- the LVM text format ----------------------------------------------------------------------

export type LvmValue = string | number | LvmValue[] | LvmSection;
export interface LvmSection {
  [key: string]: LvmValue;
}

/** Parse LVM's configuration text (sections, `key = value`, lists, strings, numbers). */
export function parseLvmText(text: string): LvmSection {
  if (text.length > MAX_METADATA_BYTES) {
    throw damaged("LVM metadata too large");
  }
  let i = 0;
  const skip = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === "#") {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") {
        i++;
      } else {
        break;
      }
    }
  };
  const ident = (): string => {
    const start = i;
    while (i < text.length && /[A-Za-z0-9_.+-]/.test(text[i] as string)) i++;
    if (i === start) {
      throw damaged(`LVM metadata: unexpected "${text[i] ?? "end"}" at ${i}`);
    }
    return text.slice(start, i);
  };
  const value = (depth: number): LvmValue => {
    skip();
    const c = text[i];
    if (c === '"') {
      i++;
      let out = "";
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) i++;
        out += text[i];
        i++;
      }
      i++;
      return out;
    }
    if (c === "[") {
      if (depth > 8) throw damaged("LVM metadata nested too deeply");
      i++;
      const list: LvmValue[] = [];
      for (let n = 0; n < 100_000; n++) {
        skip();
        if (text[i] === "]") {
          i++;
          return list;
        }
        if (i >= text.length) break;
        list.push(value(depth + 1));
      }
      throw damaged("LVM metadata: an unterminated list");
    }
    const word = ident();
    const n = Number(word);
    return Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(word) ? n : word;
  };
  const section = (depth: number, closing: boolean): LvmSection => {
    if (depth > 16) throw damaged("LVM metadata nested too deeply");
    const out: LvmSection = Object.create(null) as LvmSection;
    for (let n = 0; n < 100_000; n++) {
      skip();
      if (i >= text.length) {
        if (closing) throw damaged("LVM metadata: an unterminated section");
        return out;
      }
      if (text[i] === "}") {
        if (!closing) throw damaged("LVM metadata: an unexpected }");
        i++;
        return out;
      }
      const key = ident();
      skip();
      if (text[i] === "{") {
        i++;
        out[key] = section(depth + 1, true);
      } else if (text[i] === "=") {
        i++;
        out[key] = value(0);
      } else {
        throw damaged(`LVM metadata: expected = or { after ${key}`);
      }
    }
    throw damaged("LVM metadata: too many entries");
  };
  return section(0, false);
}

export interface LogicalVolume {
  vg: string;
  name: string;
  /** Null when this reader cannot assemble it; `reason` says why. */
  source: ByteSource | null;
  reason: string | null;
}

const asSection = (v: LvmValue | undefined): LvmSection | null =>
  v !== undefined && typeof v === "object" && !Array.isArray(v) ? v : null;
const asNumber = (v: LvmValue | undefined): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** The logical volumes of every volume group whose metadata one of `pvs` carries. */
export function assembleLogicalVolumes(pvs: readonly PhysicalVolume[]): LogicalVolume[] {
  const byUuid = new Map(pvs.map((pv) => [pv.uuid, pv]));
  const groups = new Map<string, { name: string; vg: LvmSection; seqno: number }>();
  for (const pv of pvs) {
    if (!pv.metadata) continue;
    let root: LvmSection;
    try {
      root = parseLvmText(pv.metadata);
    } catch {
      continue;
    }
    for (const [name, value] of Object.entries(root)) {
      const vg = asSection(value);
      const id = vg && typeof vg.id === "string" ? vg.id : null;
      if (!vg || !id) continue;
      const seqno = asNumber(vg.seqno) ?? 0;
      const known = groups.get(id);
      if (!known || known.seqno < seqno) {
        groups.set(id, { name, vg, seqno });
      }
    }
  }
  const out: LogicalVolume[] = [];
  for (const { name: vgName, vg } of groups.values()) {
    const extentSectors = asNumber(vg.extent_size);
    const pvSection = asSection(vg.physical_volumes);
    const lvSection = asSection(vg.logical_volumes);
    if (!extentSectors || !pvSection || !lvSection) continue;
    const extentBytes = extentSectors * SECTOR;
    const pvPlaces = new Map<string, { pv: PhysicalVolume; peStart: number } | null>();
    for (const [pvName, value] of Object.entries(pvSection)) {
      const section = asSection(value);
      const id = section && typeof section.id === "string" ? section.id : "";
      const pv = byUuid.get(id);
      const peStart = asNumber(section?.pe_start);
      pvPlaces.set(pvName, pv && peStart !== null ? { pv, peStart: peStart * SECTOR } : null);
    }
    for (const [lvName, value] of Object.entries(lvSection).slice(0, 1024)) {
      const lv = asSection(value);
      if (!lv) continue;
      const status = Array.isArray(lv.status) ? lv.status : [];
      if (!status.includes("VISIBLE")) continue;
      const segments = Object.entries(lv)
        .filter(([key]) => /^segment\d+$/.test(key))
        .map(([, seg]) => asSection(seg))
        .filter((seg): seg is LvmSection => seg !== null)
        .sort((a, b) => (asNumber(a.start_extent) ?? 0) - (asNumber(b.start_extent) ?? 0));
      let reason: string | null = null;
      const parts: ByteSource[] = [];
      let next = 0;
      for (const seg of segments) {
        const start = asNumber(seg.start_extent);
        const count = asNumber(seg.extent_count);
        const stripes = Array.isArray(seg.stripes) ? seg.stripes : [];
        if (seg.type !== "striped" || asNumber(seg.stripe_count) !== 1 || stripes.length !== 2) {
          reason = `the ${String(seg.type ?? "unknown")} segment type is not supported`;
          break;
        }
        const place = pvPlaces.get(String(stripes[0]));
        const firstPe = asNumber(stripes[1]);
        if (start !== next || !count || firstPe === null) {
          reason = "the segments do not form a whole volume";
          break;
        }
        if (!place) {
          reason = "a physical volume of it is not among the VM's disks";
          break;
        }
        try {
          parts.push(
            new SliceSource(
              place.pv.source,
              place.peStart + firstPe * extentBytes,
              count * extentBytes,
            ),
          );
        } catch {
          reason = "a segment lies outside its physical volume";
          break;
        }
        next = start + count;
      }
      if (segments.length === 0) reason = "it has no segments";
      out.push({
        vg: vgName,
        name: lvName,
        source: reason ? null : new ConcatSource(parts),
        reason,
      });
    }
  }
  return out;
}
