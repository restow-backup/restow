/**
 * HTTP requests that accept the self-signed certificate of the stack's edge
 * (Caddy's local CA for localhost). Only the smoke uses this, only against its
 * own stack.
 */
import https from "node:https";

export function insecureGet(url, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { rejectUnauthorized: false, timeout: timeoutMs, headers: { accept: "*/*" } },
      (response) => {
        // The socket is gone once the body has been read: take the protocol now.
        const tls = response.socket?.getProtocol?.() ?? null;
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            tls,
          }),
        );
      },
    );
    request.on("timeout", () => request.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    request.on("error", reject);
  });
}
