import { ApiError, NetworkError, type ProblemDetails, TENANT_HEADER } from "@/lib/api";
import { getActiveTenantId } from "@/lib/tenant";

/**
 * File downloads from the API (CSV exports, the PDF report). The file is
 * fetched with the session cookie and the active-tenant header, like every
 * other API call, so a refused or failed export surfaces as an error the page
 * can show instead of a browser error page; only a successful answer is
 * handed to the browser as a file.
 */

const rawBaseUrl = import.meta.env.VITE_API_URL as string | undefined;
const API_BASE_URL = (rawBaseUrl ?? "/api/v1").replace(/\/+$/, "");

/** What a download needs from the browser; tests pass a fake. */
export interface DownloadEnvironment {
  fetch: typeof fetch;
  /** Hand the file to the browser under `filename`. */
  save: (file: Blob, filename: string) => void;
  /** Active tenant for the tenant header (null sends none). */
  tenantId: () => string | null;
  /** UI language for the `accept-language` header. */
  language: () => string;
}

export interface DownloadRequest {
  /** API path below `/api/v1`, with its query string. */
  path: string;
  /** Media type asked for, e.g. `text/csv`. */
  accept: string;
  /** Name to use when the server does not send one. */
  fallbackName: string;
}

/** Characters that are unsafe or reserved in file names on common systems. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is stripped.
const UNSAFE_FILENAME = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g;

/** A file name safe to save under: no path parts, no reserved characters. */
export function safeFilename(name: string, fallback: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(UNSAFE_FILENAME, "_").replace(/^\.+/, "").trim().slice(0, 200);
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * The file name from a `Content-Disposition` header (RFC 6266): the UTF-8
 * `filename*` wins over the plain `filename`; null when there is neither.
 */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) {
    return null;
  }
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (extended?.[1]) {
    const value = extended[1].trim().replace(/^"(.*)"$/, "$1");
    const encoded = value.replace(/^[\w-]+'[^']*'/, "");
    try {
      const decoded = decodeURIComponent(encoded);
      if (decoded.length > 0) {
        return decoded;
      }
    } catch {
      // Malformed percent-encoding: fall back to the plain parameter.
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted?.[1]) {
    return quoted[1].replace(/\\(.)/g, "$1");
  }
  const bare = /filename\s*=\s*([^;\s]+)/i.exec(header);
  return bare?.[1] ?? null;
}

async function problemOf(response: Response): Promise<ProblemDetails | null> {
  if (!(response.headers.get("content-type") ?? "").includes("json")) {
    return null;
  }
  try {
    const body = (await response.json()) as Partial<ProblemDetails> | null;
    if (typeof body !== "object" || body === null) {
      return null;
    }
    return {
      ...body,
      type: typeof body.type === "string" ? body.type : "about:blank",
      title: typeof body.title === "string" ? body.title : response.statusText,
      status: typeof body.status === "number" ? body.status : response.status,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a file and hand it to the browser. Resolves with the file name used;
 * rejects with `ApiError` (refused or failed on the server) or
 * `NetworkError` (server not reachable), as `apiFetch` does.
 */
export async function downloadFile(
  request: DownloadRequest,
  environment: DownloadEnvironment = browserEnvironment,
): Promise<string> {
  const headers = new Headers({ accept: request.accept });
  const language = environment.language();
  if (language) {
    headers.set("accept-language", language);
  }
  const tenant = environment.tenantId();
  if (tenant) {
    headers.set(TENANT_HEADER, tenant);
  }

  let response: Response;
  try {
    response = await environment.fetch(`${API_BASE_URL}${request.path}`, {
      credentials: "include",
      headers,
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      await problemOf(response),
      `Download of ${request.path} failed with status ${response.status}`,
    );
  }

  const file = await response.blob();
  const filename = safeFilename(
    filenameFromDisposition(response.headers.get("content-disposition")) ?? "",
    request.fallbackName,
  );
  environment.save(file, filename);
  return filename;
}

/** Save through a temporary object URL and a hidden link (every current browser). */
function saveInBrowser(file: Blob, filename: string): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next tick: some browsers read the URL after click() returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const browserEnvironment: DownloadEnvironment = {
  fetch: (...args) => fetch(...args),
  save: saveInBrowser,
  tenantId: getActiveTenantId,
  language: () => (typeof document === "undefined" ? "" : document.documentElement.lang),
};
