/**
 * A minimal SMTP sender for the journal check: one message to one recipient,
 * no authentication. With `tls` it upgrades with STARTTLS the way Exchange
 * Online's connector does (always TLS) and verifies the certificate against the
 * given trust anchor and name; without it the session stays in plain text, which
 * is how the check proves that the receiver refuses mail before STARTTLS.
 * Returns the server's final reply so the check can assert on the code the way
 * Exchange Online would.
 */
import net from "node:net";
import tls from "node:tls";

function dotStuff(message) {
  return message.replace(/^\./gmu, "..");
}

/**
 * @param {object} options
 * @param {{ ca: string, servername: string }} [options.tls]  upgrade with STARTTLS, trusting `ca`
 *   and checking the certificate against `servername`
 * @returns the server's final reply, every reply, and (after STARTTLS) the TLS session's
 *   protocol and the SHA-256 fingerprint of the certificate the server presented
 */
export async function sendMail({
  host,
  port,
  from,
  to,
  message,
  heloName = "exchange.smoke.test",
  timeoutMs = 30_000,
  tls: tlsOptions,
}) {
  let socket = net.connect({ host, port });
  let buffer = "";
  let wake = null;
  function attach(target) {
    target.setTimeout(timeoutMs, () => target.destroy(new Error("SMTP socket timed out")));
    target.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      wake?.();
    });
    target.on("close", () => wake?.());
    target.on("error", () => wake?.());
  }
  attach(socket);

  async function reply() {
    for (;;) {
      const lines = buffer.split("\r\n");
      // A reply ends at a line "NNN text" (a space after the code, not "NNN-").
      const complete = lines.findIndex((line) => /^\d{3} /u.test(line));
      if (complete !== -1) {
        const text = lines.slice(0, complete + 1).join("\r\n");
        buffer = lines.slice(complete + 1).join("\r\n");
        return { code: Number(lines[complete].slice(0, 3)), text };
      }
      if (socket.destroyed) {
        throw new Error("the SMTP connection closed unexpectedly");
      }
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
  }

  async function send(line) {
    socket.write(`${line}\r\n`);
    return reply();
  }

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const replies = [];
  let tlsSession;
  replies.push(await reply()); // banner
  const ehlo = await send(`EHLO ${heloName}`);
  replies.push(ehlo);
  if (tlsOptions) {
    if (!/^250[- ]STARTTLS$/mu.test(ehlo.text)) {
      socket.destroy();
      throw new Error("the receiver does not offer STARTTLS");
    }
    const ready = await send("STARTTLS");
    replies.push(ready);
    if (ready.code !== 220) {
      socket.destroy();
      throw new Error(`STARTTLS was answered ${ready.code} ${ready.text}`);
    }
    const plain = socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("close");
    plain.removeAllListeners("error");
    plain.setTimeout(0);
    buffer = "";
    const secure = tls.connect({
      socket: plain,
      ca: tlsOptions.ca,
      servername: tlsOptions.servername,
    });
    await new Promise((resolve, reject) => {
      secure.once("secureConnect", resolve);
      secure.once("error", reject);
    });
    socket = secure;
    attach(secure);
    tlsSession = {
      protocol: secure.getProtocol(),
      fingerprint256: secure.getPeerCertificate().fingerprint256,
    };
    replies.push(await send(`EHLO ${heloName}`));
  }
  const mail = await send(`MAIL FROM:<${from}>`);
  replies.push(mail);
  if (mail.code >= 400) {
    await send("QUIT").catch(() => {});
    socket.destroy();
    return { accepted: false, final: mail, replies, tls: tlsSession };
  }
  const rcpt = await send(`RCPT TO:<${to}>`);
  replies.push(rcpt);
  if (rcpt.code >= 400) {
    await send("QUIT").catch(() => {});
    socket.destroy();
    return { accepted: false, final: rcpt, replies, tls: tlsSession };
  }
  replies.push(await send("DATA"));
  socket.write(`${dotStuff(message)}\r\n.\r\n`);
  const final = await reply();
  replies.push(final);
  await send("QUIT").catch(() => {});
  socket.destroy();
  return { accepted: final.code >= 200 && final.code < 300, final, replies, tls: tlsSession };
}
