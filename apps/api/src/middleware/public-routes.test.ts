import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { PUBLIC_ROUTES } from "../lib/provider-access.js";
import { CROSS_SITE_PROBLEM, UNSUPPORTED_MEDIA_TYPE_PROBLEM } from "./browser-request.js";

/**
 * The routes that change state without a session, and how each is protected
 * against a request a web page sends from another site. The session routes
 * get that from their middleware (middleware/session.ts); these do not, so
 * every one is listed here: a new public route that changes state fails the
 * first test until it is decided which protection it has.
 */

/** Refused from another site (403) and with a body that is not JSON (415). */
const BROWSER_GUARDED: Readonly<Record<string, string>> = {
  "POST /api/v1/setup": "/api/v1/setup",
  "POST /api/v1/setup/token": "/api/v1/setup/token",
  "POST /api/v1/accounts/set-password": "/api/v1/accounts/set-password",
  "POST /agent/v1/enroll": "/agent/v1/enroll",
  "POST /agent/pve/v1/enroll": "/agent/pve/v1/enroll",
};

/** Protected some other way, which a page on another site cannot meet either. */
const OTHERWISE_PROTECTED: Readonly<Record<string, string>> = {
  "POST /api/auth/*": "better-auth's own CSRF and origin checks (Fetch Metadata, Origin)",
  "POST /agent/v1/heartbeat": "HTTP Basic with the agent's secret",
  "POST /agent/v1/runs": "HTTP Basic with the agent's secret",
  "POST /agent/v1/runs/:runId/progress": "HTTP Basic with the agent's secret",
  "POST /agent/v1/runs/:runId/finish": "HTTP Basic with the agent's secret",
  "POST /agent/pve/v1/heartbeat": "HTTP Basic with the PVE node's secret",
  "POST /agent/pve/v1/inventory": "HTTP Basic with the PVE node's secret",
  "POST /agent/pve/v1/runs": "HTTP Basic with the PVE node's secret",
  "PUT /agent/pve/v1/runs/:runId/blocks": "HTTP Basic with the PVE node's secret",
  "POST /agent/pve/v1/runs/:runId/commit": "HTTP Basic with the PVE node's secret",
  "POST /agent/pve/v1/runs/:runId/finish": "HTTP Basic with the PVE node's secret",
  "POST /agent/pve/v1/runs/:runId/incremental": "HTTP Basic with the PVE node's secret",
  "POST /agent/pve/v1/runs/:runId/log": "HTTP Basic with the PVE node's secret",
  "POST /agent/pve/v1/runs/:runId/restic": "HTTP Basic with the PVE node's secret",
  "POST /agent/pve/v1/snapshots/:snapshotId/restic": "HTTP Basic with the PVE node's secret",
  "POST /agent/pve/v1/tasks/:taskId/result": "HTTP Basic with the PVE node's secret",
};

const SAFE = /^(GET|HEAD|OPTIONS) /;

describe("public routes that change state", () => {
  it("each has a decided protection", () => {
    const changing = [...PUBLIC_ROUTES].filter((route) => !SAFE.test(route)).sort();
    expect(changing).toEqual(
      [...Object.keys(BROWSER_GUARDED), ...Object.keys(OTHERWISE_PROTECTED)].sort(),
    );
  });

  const app = buildApp();
  const send = (path: string, headers: Record<string, string>, body = "{}") =>
    app.request(path, {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.240", ...headers },
      body,
    });

  for (const [route, path] of Object.entries(BROWSER_GUARDED)) {
    it(`${route} refuses a request from another site`, async () => {
      const response = await send(path, {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
        origin: "https://evil.example",
      });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { type: string }).type).toBe(CROSS_SITE_PROBLEM);
    });

    it(`${route} refuses a body that is not JSON (a no-cors form post)`, async () => {
      const response = await send(
        path,
        { "content-type": "text/plain", "sec-fetch-site": "same-origin" },
        '{"token":"x"}',
      );
      expect(response.status).toBe(415);
      expect(((await response.json()) as { type: string }).type).toBe(
        UNSUPPORTED_MEDIA_TYPE_PROBLEM,
      );
    });
  }

  it("counts refused enrollments in the enrollment limit", async () => {
    const enroll = (contentType: string) =>
      app.request("/agent/v1/enroll", {
        method: "POST",
        headers: { "content-type": contentType, "x-forwarded-for": "198.51.100.241" },
        body: "{}",
      });
    for (let attempt = 0; attempt < 20; attempt++) {
      expect((await enroll("text/plain")).status).toBe(415);
    }
    expect((await enroll("application/json")).status).toBe(429);
  });
});
