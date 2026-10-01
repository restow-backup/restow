import { describe, expect, it } from "vitest";

import { ApiError, NetworkError, TENANT_HEADER } from "@/lib/api";

import {
  type DownloadEnvironment,
  type DownloadRequest,
  downloadFile,
  filenameFromDisposition,
  safeFilename,
} from "./download.js";

const REQUEST: DownloadRequest = {
  path: "/stats/export.csv?dataset=backups&granularity=day",
  accept: "text/csv",
  fallbackName: "restow-stats-backups.csv",
};

interface Recorded {
  url?: string;
  init?: RequestInit;
  saved: { file: Blob; filename: string }[];
}

function environment(
  respond: () => Response | Promise<Response>,
  overrides: Partial<DownloadEnvironment> = {},
): { env: DownloadEnvironment; recorded: Recorded } {
  const recorded: Recorded = { saved: [] };
  const env: DownloadEnvironment = {
    fetch: async (input, init) => {
      recorded.url = String(input);
      recorded.init = init;
      return respond();
    },
    save: (file, filename) => recorded.saved.push({ file, filename }),
    tenantId: () => "0b5c6f0e-0000-4000-8000-000000000001",
    language: () => "de",
    ...overrides,
  };
  return { env, recorded };
}

describe("filenameFromDisposition", () => {
  it("prefers the UTF-8 name over the plain one", () => {
    expect(
      filenameFromDisposition(
        `attachment; filename="stats.csv"; filename*=UTF-8''Statistik%20M%C3%A4rz.csv`,
      ),
    ).toBe("Statistik März.csv");
  });

  it("reads quoted and bare names", () => {
    expect(filenameFromDisposition('attachment; filename="report 2026.pdf"')).toBe(
      "report 2026.pdf",
    );
    expect(filenameFromDisposition('attachment; filename="a \\"b\\".csv"')).toBe('a "b".csv');
    expect(filenameFromDisposition("attachment; filename=stats.csv")).toBe("stats.csv");
  });

  it("falls back to the plain name when the encoded one is broken", () => {
    expect(
      filenameFromDisposition(`attachment; filename*=UTF-8''%E0%A4%A; filename="ok.csv"`),
    ).toBe("ok.csv");
  });

  it("returns null without a name", () => {
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition("attachment")).toBeNull();
  });
});

describe("safeFilename", () => {
  it("keeps only the last path part and replaces reserved characters", () => {
    expect(safeFilename("../../etc/passwd", "x")).toBe("passwd");
    expect(safeFilename("C:\\temp\\a:b?.csv", "x")).toBe("a_b_.csv");
    expect(safeFilename(".hidden.csv", "x")).toBe("hidden.csv");
  });

  it("uses the fallback for an empty name", () => {
    expect(safeFilename("", "fallback.csv")).toBe("fallback.csv");
    expect(safeFilename("   ", "fallback.csv")).toBe("fallback.csv");
  });
});

describe("downloadFile", () => {
  it("fetches with the session and tenant, then saves under the server's name", async () => {
    const { env, recorded } = environment(
      () =>
        new Response("\uFEFFt,succeeded\r\n2026-09-17,10\r\n", {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="restow-backups.csv"',
          },
        }),
    );

    const filename = await downloadFile(REQUEST, env);

    expect(filename).toBe("restow-backups.csv");
    expect(recorded.url).toBe(`/api/v1${REQUEST.path}`);
    expect(recorded.init?.credentials).toBe("include");
    const headers = new Headers(recorded.init?.headers);
    expect(headers.get("accept")).toBe("text/csv");
    expect(headers.get("accept-language")).toBe("de");
    expect(headers.get(TENANT_HEADER)).toBe("0b5c6f0e-0000-4000-8000-000000000001");
    expect(recorded.saved).toHaveLength(1);
    expect(recorded.saved[0]?.filename).toBe("restow-backups.csv");
    expect(await recorded.saved[0]?.file.text()).toContain("2026-09-17,10");
  });

  it("uses the fallback name and sends no tenant header without a tenant", async () => {
    const { env, recorded } = environment(() => new Response("%PDF-1.7", { status: 200 }), {
      tenantId: () => null,
    });

    await expect(downloadFile(REQUEST, env)).resolves.toBe("restow-stats-backups.csv");
    expect(new Headers(recorded.init?.headers).has(TENANT_HEADER)).toBe(false);
    expect(recorded.saved[0]?.filename).toBe("restow-stats-backups.csv");
  });

  it("rejects with the problem details and saves nothing when refused", async () => {
    const { env, recorded } = environment(
      () =>
        new Response(
          JSON.stringify({ type: "about:blank", title: "Forbidden", status: 403, detail: "No." }),
          { status: 403, headers: { "content-type": "application/problem+json" } },
        ),
    );

    const error = await downloadFile(REQUEST, env).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).problem?.detail).toBe("No.");
    expect(recorded.saved).toHaveLength(0);
  });

  it("rejects with a network error when the server is unreachable", async () => {
    const { env, recorded } = environment(() => {
      throw new TypeError("Failed to fetch");
    });

    await expect(downloadFile(REQUEST, env)).rejects.toBeInstanceOf(NetworkError);
    expect(recorded.saved).toHaveLength(0);
  });

  it("rejects a server error without a problem body", async () => {
    const { env } = environment(() => new Response("boom", { status: 500 }));
    const error = await downloadFile(REQUEST, env).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
    expect((error as ApiError).problem).toBeNull();
  });
});
