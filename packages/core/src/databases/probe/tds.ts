import type { DbSqlServerFacts } from "../facts.js";

/**
 * SQL Server is recognised by its answer to a TDS PRELOGIN (docs/DATABASES.md 3.1): a packet of
 * type 0x12 with the options VERSION, ENCRYPTION, INSTOPT, THREADID and MARS; the server answers
 * with a packet of type 0x04 that carries its own VERSION and ENCRYPTION. Nothing signs in: the
 * sign-in to SQL Server stays with the agent on its machine (4.1).
 */

const PRELOGIN = 0x12;
const TABULAR_RESULT = 0x04;

const OPTION_VERSION = 0x00;
const OPTION_ENCRYPTION = 0x01;
const OPTION_INSTOPT = 0x02;
const OPTION_THREADID = 0x03;
const OPTION_MARS = 0x04;
const OPTION_TERMINATOR = 0xff;

/** ENCRYPT_NOT_SUP: the probe never encrypts, it only asks. */
const ENCRYPT_NOT_SUP = 0x02;

/** The PRELOGIN packet the probe sends. */
export function tdsPreloginPacket(): Buffer {
  const options: [number, Buffer][] = [
    [OPTION_VERSION, Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00])],
    [OPTION_ENCRYPTION, Buffer.from([ENCRYPT_NOT_SUP])],
    [OPTION_INSTOPT, Buffer.from([0x00])],
    [OPTION_THREADID, Buffer.from([0x00, 0x00, 0x00, 0x00])],
    [OPTION_MARS, Buffer.from([0x00])],
  ];
  const headerLength = options.length * 5 + 1;
  const parts: Buffer[] = [];
  let offset = headerLength;
  const header = Buffer.alloc(headerLength);
  options.forEach(([token, data], index) => {
    header.writeUInt8(token, index * 5);
    header.writeUInt16BE(offset, index * 5 + 1);
    header.writeUInt16BE(data.length, index * 5 + 3);
    offset += data.length;
    parts.push(data);
  });
  header.writeUInt8(OPTION_TERMINATOR, headerLength - 1);
  const payload = Buffer.concat([header, ...parts]);
  const packet = Buffer.alloc(8);
  packet.writeUInt8(PRELOGIN, 0);
  packet.writeUInt8(0x01, 1); // end of message
  packet.writeUInt16BE(payload.length + 8, 2);
  packet.writeUInt16BE(0, 4); // SPID
  packet.writeUInt8(0x01, 6); // packet id
  packet.writeUInt8(0x00, 7); // window
  return Buffer.concat([packet, payload]);
}

const ENCRYPTION_NAMES = ["off", "on", "not_supported", "required"] as const;

/** The facts of a PRELOGIN answer (header included); null when the bytes are no such answer. */
export function parseTdsPreloginResponse(packet: Buffer): DbSqlServerFacts | null {
  if (packet.length < 8 + 1 || packet.readUInt8(0) !== TABULAR_RESULT) {
    return null;
  }
  const length = packet.readUInt16BE(2);
  if (length < 9 || length > packet.length) {
    return null;
  }
  const payload = packet.subarray(8, length);
  let version: string | null = null;
  let encryption: DbSqlServerFacts["encryption"] = null;
  let sawVersion = false;
  for (let index = 0; index + 1 <= payload.length; index += 5) {
    const token = payload.readUInt8(index);
    if (token === OPTION_TERMINATOR) {
      break;
    }
    if (index + 5 > payload.length) {
      return null;
    }
    const offset = payload.readUInt16BE(index + 1);
    const size = payload.readUInt16BE(index + 3);
    if (offset + size > payload.length) {
      return null;
    }
    const data = payload.subarray(offset, offset + size);
    if (token === OPTION_VERSION && size >= 4) {
      sawVersion = true;
      version = `${data.readUInt8(0)}.${data.readUInt8(1)}.${data.readUInt16BE(2)}`;
    } else if (token === OPTION_ENCRYPTION && size >= 1) {
      encryption = ENCRYPTION_NAMES[data.readUInt8(0)] ?? null;
    }
  }
  return sawVersion ? { version, encryption } : null;
}

/** The length a TDS packet announces in its header (bytes 2 and 3), or null. */
export function tdsPacketLength(header: Buffer): number | null {
  if (header.length < 4 || header.readUInt8(0) !== TABULAR_RESULT) {
    return null;
  }
  return header.readUInt16BE(2);
}
