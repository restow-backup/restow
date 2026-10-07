/**
 * Whether the mounter (apps/api/src/mounter, docs/MOUNTS.md) is adding or removing a
 * share right now. The updater asks before it recreates the mounter after an update
 * (self-update.ts), so that a running operation is not cut off.
 *
 * The updater holds no secret of the mounter, so it reads the unauthenticated
 * `GET /healthz` on the internal network, which answers `{ status, busy }`. A mounter
 * that cannot be reached, or one that predates the `busy` field, is "unknown" (null): the
 * updater then goes ahead. The mounter closes an operation it was stopped in as
 * `needs_attention` (code `interrupted`) when it starts again, so nothing is lost silently.
 */

export interface MounterStatus {
  /** true: an operation runs; false: idle; null: unknown (unreachable, older mounter). */
  busy(): Promise<boolean | null>;
}

export interface HttpMounterStatusOptions {
  /** The mounter's base URL inside the compose network (no trailing slash). */
  url: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class HttpMounterStatus implements MounterStatus {
  constructor(private readonly options: HttpMounterStatusOptions) {}

  async busy(): Promise<boolean | null> {
    const fetchImpl = this.options.fetch ?? fetch;
    try {
      const response = await fetchImpl(`${this.options.url}/healthz`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as unknown;
      if (typeof body === "object" && body !== null && "busy" in body) {
        const busy = (body as { busy: unknown }).busy;
        return typeof busy === "boolean" ? busy : null;
      }
      return null;
    } catch {
      return null;
    }
  }
}
