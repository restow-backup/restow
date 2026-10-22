import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { ImapClient } from "./imap-lite.mjs";

/**
 * The smoke's IMAP client against a tiny fake server: a logged-in client that sits idle
 * between commands longer than its timeout still works (check 13 holds it across minutes of
 * waiting for the stack), while a server that stops answering a command is given up on.
 */

/** @returns {Promise<{ port: number, close: () => Promise<void> }>} */
async function fakeServer({ answerAppend = true } = {}) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let literal = null;
    socket.write("* OK fake ready\r\n");
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (literal) {
          if (buffer.length < literal.size + 2) {
            return;
          }
          buffer = buffer.subarray(literal.size + 2);
          if (answerAppend) {
            socket.write(`${literal.tag} OK APPEND completed\r\n`);
          }
          literal = null;
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end === -1) {
          return;
        }
        const line = buffer.subarray(0, end).toString("latin1");
        buffer = buffer.subarray(end + 2);
        const [tag, verb] = line.split(" ");
        const size = /\{(\d+)\}$/u.exec(line);
        if (size) {
          literal = { tag, size: Number(size[1]) };
          socket.write("+ go ahead\r\n");
        } else if (verb === "LOGOUT") {
          socket.end(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
        } else {
          socket.write(`${tag} OK ${verb} completed\r\n`);
        }
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const login = (port, timeoutMs) =>
  ImapClient.connect({ host: "127.0.0.1", port, user: "u@smoke.test", password: "pw", timeoutMs });

test("a client idle between commands longer than its timeout still appends", async () => {
  const server = await fakeServer();
  try {
    // timeoutMs 25 arms a 100 ms inactivity timeout while a command waits.
    const client = await login(server.port, 25);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await client.append("INBOX", Buffer.from("Subject: x\r\n\r\nbody\r\n"));
    await client.logout();
  } finally {
    await server.close();
  }
});

test("a command the server never answers fails with the timeout as the reason", async () => {
  const server = await fakeServer({ answerAppend: false });
  try {
    const client = await login(server.port, 25);
    await assert.rejects(
      client.append("INBOX", Buffer.from("Subject: x\r\n\r\nbody\r\n")),
      /closed unexpectedly \(IMAP socket timed out\)/u,
    );
  } finally {
    await server.close();
  }
});
