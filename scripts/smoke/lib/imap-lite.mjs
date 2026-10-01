/**
 * A minimal IMAP client for the smoke: log in, create a mailbox, append
 * messages, list the messages of a mailbox with their bytes. Plain IMAP (the
 * test Dovecot has no TLS). Only what the checks need; the Restow under test
 * uses its own client (imapflow), so this one is an independent witness when
 * the checks compare what was written with what came back.
 */
import net from "node:net";

const CRLF = Buffer.from("\r\n");

export class ImapClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiting = null;
    this.tagCounter = 0;
    this.closed = false;
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    socket.on("close", () => {
      this.closed = true;
      this.wake();
    });
    socket.on("error", () => {
      this.closed = true;
      this.wake();
    });
  }

  static async connect({ host, port, user, password, timeoutMs = 15_000 }) {
    const socket = net.connect({ host, port });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.setTimeout(timeoutMs * 4, () => socket.destroy(new Error("IMAP socket timed out")));
    const client = new ImapClient(socket);
    await client.readLine(); // greeting
    await client.command(`LOGIN ${quote(user)} ${quote(password)}`);
    return client;
  }

  wake() {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve();
    }
  }

  async ensure(predicate) {
    while (!predicate()) {
      if (this.closed) {
        throw new Error("the IMAP connection closed unexpectedly");
      }
      await new Promise((resolve) => {
        this.waiting = resolve;
      });
    }
  }

  async readLine() {
    await this.ensure(() => this.buffer.indexOf(CRLF) !== -1);
    const end = this.buffer.indexOf(CRLF);
    const line = this.buffer.subarray(0, end).toString("latin1");
    this.buffer = this.buffer.subarray(end + 2);
    return line;
  }

  async readBytes(count) {
    await this.ensure(() => this.buffer.length >= count);
    const bytes = Buffer.from(this.buffer.subarray(0, count));
    this.buffer = this.buffer.subarray(count);
    return bytes;
  }

  /** Send a command, return the untagged responses `{ line, literals }` and the tagged status line. */
  async command(text, { literal } = {}) {
    const tag = `s${++this.tagCounter}`;
    if (literal) {
      this.socket.write(`${tag} ${text} {${literal.length}}\r\n`);
      // Wait for the continuation request before sending the literal.
      let continued = false;
      const responses = [];
      while (!continued) {
        const line = await this.readLine();
        if (line.startsWith("+")) {
          continued = true;
        } else if (line.startsWith(`${tag} `)) {
          throw new Error(`IMAP ${text.split(" ")[0]} refused: ${line}`);
        } else {
          responses.push(line);
        }
      }
      this.socket.write(Buffer.concat([literal, CRLF]));
      return this.finish(tag, text);
    }
    this.socket.write(`${tag} ${text}\r\n`);
    return this.finish(tag, text);
  }

  async finish(tag, text) {
    const untagged = [];
    for (;;) {
      let line = await this.readLine();
      const literals = [];
      // A line ending in {n} is followed by n bytes and then the rest of the line.
      for (;;) {
        const match = /\{(\d+)\}$/u.exec(line);
        if (!match) {
          break;
        }
        literals.push(await this.readBytes(Number(match[1])));
        line += `<literal ${match[1]}>${await this.readLine()}`;
      }
      if (line.startsWith(`${tag} `)) {
        if (!/^\S+ OK/iu.test(line)) {
          throw new Error(`IMAP ${text.split(" ")[0]} failed: ${line}`);
        }
        return { status: line, untagged };
      }
      untagged.push({ line, literals });
    }
  }

  async create(mailbox) {
    try {
      await this.command(`CREATE ${quote(mailbox)}`);
    } catch (error) {
      if (!/ALREADYEXISTS|exists/iu.test(String(error.message))) {
        throw error;
      }
    }
  }

  async append(mailbox, message, { flags = "", date } = {}) {
    const parts = [`APPEND ${quote(mailbox)}`];
    if (flags) {
      parts.push(`(${flags})`);
    }
    if (date) {
      parts.push(`"${formatInternalDate(date)}"`);
    }
    await this.command(parts.join(" "), { literal: message });
  }

  async list() {
    const { untagged } = await this.command('LIST "" "*"');
    return untagged
      .map(({ line }) => /^\* LIST \([^)]*\) (?:"[^"]*"|NIL) (.+)$/u.exec(line)?.[1])
      .filter(Boolean)
      .map((name) => (name.startsWith('"') ? name.slice(1, -1).replace(/\\(.)/gu, "$1") : name));
  }

  /** Every message of `mailbox` as `{ uid, bytes }`, oldest first. Empty when the mailbox does not exist. */
  async messages(mailbox) {
    try {
      await this.command(`EXAMINE ${quote(mailbox)}`);
    } catch {
      return [];
    }
    const found = await this.command("UID SEARCH ALL");
    const uids = (found.untagged.find(({ line }) => line.startsWith("* SEARCH"))?.line ?? "")
      .replace("* SEARCH", "")
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    const result = [];
    for (const uid of uids) {
      const fetched = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`);
      const entry = fetched.untagged.find(({ literals }) => literals.length > 0);
      if (entry) {
        result.push({ uid: Number(uid), bytes: entry.literals[0] });
      }
    }
    return result;
  }

  async logout() {
    try {
      await this.command("LOGOUT");
    } catch {
      // The server closes the connection right after BYE.
    }
    this.socket.destroy();
  }
}

function quote(text) {
  return `"${String(text).replace(/(["\\])/gu, "\\$1")}"`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** dd-Mon-yyyy hh:mm:ss +0000, the IMAP internal date format. */
export function formatInternalDate(date) {
  const two = (value) => String(value).padStart(2, "0");
  return `${two(date.getUTCDate())}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} +0000`;
}
