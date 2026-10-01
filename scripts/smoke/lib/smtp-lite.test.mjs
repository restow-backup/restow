import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import net from "node:net";
import { after, before, test } from "node:test";
import tls from "node:tls";
import { createSelfSignedCertificate } from "./selfsigned.mjs";
import { sendMail } from "./smtp-lite.mjs";

/**
 * The smoke's SMTP client against a tiny fake receiver that behaves like the
 * journal receiver: STARTTLS offered, MAIL FROM answered 530 until the session
 * is secure. The client has to upgrade, verify the certificate against the
 * trust anchor and the name it is given, and report what it saw.
 */

const host = "archive.smoke.test";
const pair = createSelfSignedCertificate({ commonName: host, dnsNames: [host] });
const other = createSelfSignedCertificate({ commonName: host, dnsNames: [host] });

/** @returns {Promise<{ port: number, commands: string[], close: () => Promise<void> }>} */
async function fakeReceiver({ offerStartTls = true } = {}) {
  const commands = [];
  const server = net.createServer((raw) => {
    let socket = raw;
    let secure = false;
    let buffer = "";
    let inData = false;
    const write = (line) => socket.write(`${line}\r\n`);

    function command(line) {
      const verb = line.split(" ")[0].toUpperCase();
      if (verb === "EHLO") {
        write("250-archive.smoke.test");
        if (offerStartTls && !secure) {
          write("250-STARTTLS");
        }
        write("250 SIZE 1048576");
      } else if (verb === "STARTTLS") {
        write("220 Ready to start TLS");
        raw.removeAllListeners("data");
        socket = new tls.TLSSocket(raw, { isServer: true, cert: pair.certPem, key: pair.keyPem });
        socket.on("data", onData);
        socket.on("error", () => {});
        secure = true;
        buffer = "";
      } else if (verb === "MAIL") {
        write(secure ? "250 OK" : "530 Must issue a STARTTLS command first");
      } else if (verb === "RCPT") {
        write("250 OK");
      } else if (verb === "DATA") {
        write("354 End data with <CR><LF>.<CR><LF>");
        inData = true;
      } else if (verb === "QUIT") {
        write("221 Bye");
        socket.end();
      }
    }

    function onData(chunk) {
      buffer += chunk.toString("latin1");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end === -1) {
            return;
          }
          buffer = buffer.slice(end + 5);
          inData = false;
          write("250 accepted");
          continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline === -1) {
          return;
        }
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        commands.push(line.split(" ")[0].toUpperCase());
        command(line);
      }
    }

    raw.on("error", () => {});
    write("220 archive.smoke.test ESMTP");
    raw.on("data", onData);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    commands,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const message = "Subject: hello\r\n\r\nhello";
const base = {
  host: "127.0.0.1",
  from: "journal@contoso.onmicrosoft.com",
  to: "journal+x@a.test",
  message,
};

let receiver;
before(async () => {
  receiver = await fakeReceiver();
});
after(async () => {
  await receiver.close();
});

test("without TLS the receiver's 530 at MAIL FROM is what comes back, and nothing more is sent", async () => {
  receiver.commands.length = 0;
  const result = await sendMail({ ...base, port: receiver.port });
  assert.equal(result.accepted, false);
  assert.equal(result.final.code, 530);
  assert.match(result.final.text, /Must issue a STARTTLS command first/u);
  assert.equal(result.tls, undefined);
  assert.ok(!receiver.commands.includes("RCPT"));
});

test("with TLS it upgrades, verifies the certificate by name and delivers", async () => {
  receiver.commands.length = 0;
  const result = await sendMail({
    ...base,
    port: receiver.port,
    tls: { ca: pair.certPem, servername: host },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.final.code, 250);
  assert.equal(result.tls.fingerprint256, new X509Certificate(pair.certPem).fingerprint256);
  assert.match(result.tls.protocol, /^TLSv1\.[23]$/u);
  assert.deepEqual(receiver.commands.slice(0, 5), ["EHLO", "STARTTLS", "EHLO", "MAIL", "RCPT"]);
});

test("it refuses a certificate issued for another name", async () => {
  await assert.rejects(
    sendMail({
      ...base,
      port: receiver.port,
      tls: { ca: pair.certPem, servername: "other.smoke.test" },
    }),
    (error) => error.code === "ERR_TLS_CERT_ALTNAME_INVALID",
  );
});

test("it refuses a certificate that its trust anchor does not vouch for", async () => {
  await assert.rejects(
    sendMail({
      ...base,
      port: receiver.port,
      tls: { ca: other.certPem, servername: host },
    }),
    (error) => /self-signed|unable to verify|DEPTH_ZERO/iu.test(error.message),
  );
});

test("it fails loudly when a receiver that must use TLS does not offer STARTTLS", async () => {
  const plainOnly = await fakeReceiver({ offerStartTls: false });
  try {
    await assert.rejects(
      sendMail({ ...base, port: plainOnly.port, tls: { ca: pair.certPem, servername: host } }),
      /does not offer STARTTLS/u,
    );
  } finally {
    await plainOnly.close();
  }
});
