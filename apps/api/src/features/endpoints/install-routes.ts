import { Readable } from "node:stream";
import { Hono } from "hono";
import { ProblemError } from "../../problem.js";
import {
  announcedAgentVersion,
  distributionFile,
  isReleaseFile,
  openDistributionFile,
  readChecksums,
  readInstallScript,
  readReleaseFile,
  readReleaseKey,
  renderInstallScript,
} from "./distribution.js";
import { instanceUrl } from "./instance-url.js";

/**
 * /install: what the one-line install command downloads (docs/AGENT.md).
 * No login: the machine has nothing yet. The scripts carry no secret (the
 * enrollment token is typed in when the script asks, never in a URL) and
 * check the maintainer's signature over the release's SHA256SUMS and the
 * checksums of the binaries before they run anything.
 *
 *   GET /install/linux.sh | macos.sh | windows.ps1   the install script for the system
 *   GET /install/agent/<version>/SHA256SUMS[.sig]    the signed checksums of a release, byte for byte
 *   GET /install/agent/<version>/<os>-<arch>/<file>  restow-agent, restic, THIRD_PARTY_NOTICES.txt, SHA256SUMS
 *
 * windows.ps1 (0.5.0, preview) is Windows PowerShell; it is served as text/plain so
 * that `irm` hands it over as a string. The placeholders it carries are checked
 * values without a single quote (renderInstallScript), so they are safe inside
 * the single-quoted PowerShell strings as well. Because the server rewrites the
 * script for every request, it cannot carry an Authenticode signature
 * (docs/WINDOWS-AGENT.md, section 15).
 */
export const installRoutes = new Hono();

for (const name of ["linux.sh", "macos.sh", "windows.ps1"] as const) {
  installRoutes.get(`/${name}`, async (c) => {
    const template = await readInstallScript(name);
    if (template === null) {
      throw new ProblemError(404, "Install script not available", {
        detail: "This installation does not ship the install scripts.",
      });
    }
    const instance = await instanceUrl(c);
    let body: string;
    try {
      body = renderInstallScript(
        template,
        instance.url,
        await announcedAgentVersion(),
        await readReleaseKey(),
      );
    } catch {
      throw new ProblemError(503, "Instance address unusable", {
        detail: "The public address of this installation cannot be used in an install script.",
      });
    }
    return c.body(body, 200, {
      "content-type": name.endsWith(".ps1")
        ? "text/plain; charset=utf-8"
        : "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
  });
}

installRoutes.get("/agent/:version/:file", async (c) => {
  const { version, file } = c.req.param();
  const content = isReleaseFile(file) ? await readReleaseFile(version, file) : null;
  if (!content) {
    throw new ProblemError(404, "Not Found", { detail: "No such file." });
  }
  return c.body(new Uint8Array(content), 200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
});

installRoutes.get("/agent/:version/:target/:file", async (c) => {
  const { version, target, file } = c.req.param();
  const found = await distributionFile(version, target, file);
  if (!found) {
    throw new ProblemError(404, "Not Found", { detail: "No such file." });
  }
  if (file === "SHA256SUMS") {
    // Serve the merged list, so the script finds every file whichever folder held its line.
    const sums = await readChecksums(version, target);
    const text = [...sums].map(([name, sum]) => `${sum}  ${name}`).join("\n");
    return c.body(`${text}\n`, 200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    });
  }
  return new Response(
    Readable.toWeb(openDistributionFile(found.path)) as unknown as ReadableStream,
    {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(found.size),
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    },
  );
});
