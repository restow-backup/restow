/**
 * The DBX of the probe's firmware (docs/BAREMETAL.md 12.3): what a machine that took every
 * revocation update has in its forbidden signature database. Microsoft publishes the list as
 * signed updates (microsoft/secureboot_objects, BSD-2-Clause-Patent; the lab image carries the
 * files at a pinned commit, each with its SHA-256): the last complete list signed with the KEK of
 * 2011 and the newer one signed with the KEK of 2023, which leaves out entries that the older
 * updates already put into every firmware. A firmware keeps what it got (updates are appended),
 * so the probe's DBX is the union of both.
 *
 * `virt-fw-vars --set-dbx` takes one update file (EFI_VARIABLE_AUTHENTICATION_2: a time stamp, a
 * PKCS#7 certificate header and the signature lists). It writes the store offline and checks no
 * signature, so the union is written as one such file with the newest time stamp and an empty
 * certificate.
 */

/** EFI_CERT_TYPE_PKCS7_GUID as it is stored (mixed endian). */
const PKCS7_GUID = guidBytes("4aafd29d-68df-49ee-8aa9-347d375665a7");

/** A GUID in the byte order of EFI structures. */
export function guidBytes(guid: string): Buffer {
  const hex = guid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a GUID: ${guid}`);
  const b = Buffer.from(hex, "hex");
  return Buffer.concat([
    Buffer.from(b.subarray(0, 4)).reverse(),
    Buffer.from(b.subarray(4, 6)).reverse(),
    Buffer.from(b.subarray(6, 8)).reverse(),
    b.subarray(8, 16),
  ]);
}

export interface SignatureList {
  /** The signature type (16 bytes, as stored). */
  type: Buffer;
  header: Buffer;
  /** Each signature: owner (16 bytes) and data. */
  signatures: Buffer[];
  size: number;
}

export interface DbxUpdate {
  /** EFI_TIME, 16 bytes. */
  time: Buffer;
  lists: SignatureList[];
}

/** Parse an update file (EFI_VARIABLE_AUTHENTICATION_2 and EFI_SIGNATURE_LISTs). */
export function parseDbxUpdate(file: Buffer): DbxUpdate {
  if (file.length < 40) throw new Error("the DBX update is too short");
  const time = file.subarray(0, 16);
  const certLength = file.readUInt32LE(16);
  if (!file.subarray(24, 40).equals(PKCS7_GUID))
    throw new Error("the DBX update has no PKCS#7 header");
  if (certLength < 24 || 16 + certLength > file.length)
    throw new Error("the DBX update's certificate length is wrong");
  const lists: SignatureList[] = [];
  let offset = 16 + certLength;
  while (offset < file.length) {
    if (offset + 28 > file.length) throw new Error("a signature list is cut off");
    const type = file.subarray(offset, offset + 16);
    const listSize = file.readUInt32LE(offset + 16);
    const headerSize = file.readUInt32LE(offset + 20);
    const signatureSize = file.readUInt32LE(offset + 24);
    if (listSize < 28 + headerSize || offset + listSize > file.length || signatureSize < 16) {
      throw new Error("a signature list has a wrong size");
    }
    const body = 28 + headerSize;
    if ((listSize - body) % signatureSize !== 0) throw new Error("a signature list is not whole");
    const signatures: Buffer[] = [];
    for (let at = offset + body; at < offset + listSize; at += signatureSize) {
      signatures.push(file.subarray(at, at + signatureSize));
    }
    lists.push({
      type,
      header: file.subarray(offset + 28, offset + body),
      signatures,
      size: signatureSize,
    });
    offset += listSize;
  }
  return { time, lists };
}

/** EFI_TIME as a comparable number (year to seconds). */
function timeKey(time: Buffer): number {
  return (
    time.readUInt16LE(0) * 1e10 +
    (time[2] ?? 0) * 1e8 +
    (time[3] ?? 0) * 1e6 +
    (time[4] ?? 0) * 1e4 +
    (time[5] ?? 0) * 1e2 +
    (time[6] ?? 0)
  );
}

/**
 * One update with every signature of `updates`, each once (same type, same data; the owner of the
 * first one kept), one list per type, size and header, in the order they first appear.
 */
export function unionDbx(updates: readonly Buffer[]): Buffer {
  if (updates.length === 0) throw new Error("no DBX update");
  const parsed = updates.map(parseDbxUpdate);
  const time = parsed.reduce((a, b) => (timeKey(b.time) > timeKey(a.time) ? b : a)).time;
  const groups = new Map<
    string,
    { list: SignatureList; seen: Set<string>; signatures: Buffer[] }
  >();
  for (const update of parsed) {
    for (const list of update.lists) {
      const key = `${list.type.toString("hex")}:${list.size}:${list.header.toString("hex")}`;
      let group = groups.get(key);
      if (!group) {
        group = { list, seen: new Set(), signatures: [] };
        groups.set(key, group);
      }
      for (const signature of list.signatures) {
        const data = signature.subarray(16).toString("hex");
        if (group.seen.has(data)) continue;
        group.seen.add(data);
        group.signatures.push(signature);
      }
    }
  }
  const header = Buffer.alloc(24);
  header.writeUInt32LE(24, 0); // dwLength: the WIN_CERTIFICATE_UEFI_GUID header, no certificate
  header.writeUInt16LE(0x0200, 4); // wRevision
  header.writeUInt16LE(0x0ef1, 6); // WIN_CERT_TYPE_EFI_GUID
  PKCS7_GUID.copy(header, 8);
  const lists = [...groups.values()].map(({ list, signatures }) => {
    const head = Buffer.alloc(28);
    list.type.copy(head, 0);
    head.writeUInt32LE(28 + list.header.length + signatures.length * list.size, 16);
    head.writeUInt32LE(list.header.length, 20);
    head.writeUInt32LE(list.size, 24);
    return Buffer.concat([head, list.header, ...signatures]);
  });
  return Buffer.concat([time, header, ...lists]);
}

/** How many signatures an update holds (for the lab's log and the tests). */
export function dbxCount(update: Buffer): number {
  return parseDbxUpdate(update).lists.reduce((sum, list) => sum + list.signatures.length, 0);
}
