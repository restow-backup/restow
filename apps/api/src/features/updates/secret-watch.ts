import {
  daysLeft,
  type EntraAppResolution,
  type SecretExpiryAlertStage,
  secretExpiryAlertDue,
  secretExpiryStage,
} from "@restow/core";
import {
  type AppSecretAlertEntry,
  type AppSecretAlertState,
  type Database,
  settings,
} from "@restow/db";
import { eq, sql } from "drizzle-orm";
import { raiseInstallationEvent } from "./notify.js";

/**
 * The expiry reminder of the central backup app registration (docs/ENTRA-SETUP.md, "Expiry").
 * Every quarter of an hour the api resolves the registration that applies (the environment's
 * or the one saved under Settings → Microsoft 365, features/sources/entra.ts) and looks at its
 * end: the date an admin noted for the client secret (ENTRA_CLIENT_SECRET_EXPIRES_AT for the
 * environment's) or the certificate's notAfter. Without a date there is nothing to remind of.
 *
 * Reminders go out 30 days before (`soon30`), 7 days before (`soon7`) and once it has run out
 * (`expired`), once per stage and date (@restow/core entra/expiry.ts): a notification in the
 * bell of the provider administrators and, for every event rule that lists
 * `installation.app_secret_expiring`, its e-mails and webhooks. A check that first sees the
 * date late raises only the stage it is in; a new date (a new secret, an edit, a new
 * certificate) or another registration (client ID and source kept in the mark) starts over. The last reminder is kept in `settings.app_secret_alerts`, claimed
 * with FOR UPDATE, so neither an api restart nor a second api replica repeats it.
 *
 * The per-source apps (a customer's own app on one source) are checked by the worker's monitor
 * pass (apps/worker source-app-expiry.ts), with `source.app_secret_expiring`.
 */

export const APP_SECRET_EVENT = "installation.app_secret_expiring";
export const SECRET_WATCH_INTERVAL_MS = 15 * 60_000;
const FIRST_CHECK_MS = 120_000;

export interface SecretWatchDeps {
  db: Database;
  /** The central registration that applies right now (resolveEntraApp). */
  resolve: () => Promise<EntraAppResolution>;
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", message: string, fields?: object) => void;
}

/**
 * What one check found: `raised` with the stage it raised, `alerted` when that stage was
 * already sent for this date, `ok` while the end is further away, `unknown` without a usable
 * registration or a date.
 */
export type SecretWatchOutcome =
  | { status: "raised"; stage: SecretExpiryAlertStage; expiresAt: string }
  | { status: "alerted" | "ok"; expiresAt: string }
  | { status: "unknown" };

/**
 * The stored mark when it is about this registration, else none: another app (a switch between
 * the environment's and the saved one, or a new app) whose secret ends on the same day must
 * still get its own reminders. A mark without a client ID was written before it was kept and
 * counts as this registration's, so a deploy does not repeat the stage already sent.
 */
export function markFor(
  mark: AppSecretAlertEntry | undefined,
  clientId: string,
  source: string,
): AppSecretAlertEntry | undefined {
  if (!mark) {
    return undefined;
  }
  if (mark.clientId === undefined) {
    return mark;
  }
  return mark.clientId === clientId && mark.source === source ? mark : undefined;
}

export class SecretWatch {
  constructor(private readonly deps: SecretWatchDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** One check of the central registration; raises the reminder that is due. */
  async checkOnce(): Promise<SecretWatchOutcome> {
    const resolution = await this.deps.resolve();
    // An unusable registration is reported on the Microsoft 365 page; its date is unknown.
    if (resolution.status !== "ready" || !resolution.app.expiresAt) {
      return { status: "unknown" };
    }
    const app = resolution.app;
    const expiresAt = app.expiresAt as string;
    const now = this.now();
    if (secretExpiryStage(expiresAt, now) === null) {
      return { status: "unknown" };
    }
    return this.deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: settings.id, alerts: settings.appSecretAlerts })
        .from(settings)
        .limit(1)
        .for("update");
      if (!row) {
        return { status: "unknown" } as const;
      }
      const mark = markFor(row.alerts?.central, app.credentials.clientId, app.source);
      const stage = secretExpiryAlertDue(expiresAt, mark, now);
      if (!stage) {
        return {
          status: secretExpiryStage(expiresAt, now) === "ok" ? "ok" : "alerted",
          expiresAt,
        } as const;
      }
      const days = daysLeft(expiresAt, now) ?? 0;
      const clientId = app.credentials.clientId;
      const what = app.credentialKind === "certificate" ? "certificate" : "client secret";
      const day = expiresAt.slice(0, 10);
      await raiseInstallationEvent(tx, {
        event: APP_SECRET_EVENT,
        level: stage === "expired" ? "error" : "warning",
        message:
          stage === "expired"
            ? `The ${what} of the Microsoft 365 app ${clientId} expired on ${day}.`
            : `The ${what} of the Microsoft 365 app ${clientId} expires on ${day} (${days} ${days === 1 ? "day" : "days"} left).`,
        details: {
          clientId,
          source: app.source,
          credentialKind: app.credentialKind,
          // The subject key (entra_app:<expiresAt>:<stage>, @restow/core reports/rules.ts)
          // reads these two, so each stage passes a rule's throttle on its own.
          expiresAt,
          stage,
          days,
          // The subject line of the alert mail names the app.
          objectName: clientId,
        },
        now,
      });
      const next: AppSecretAlertState = {
        ...(row.alerts ?? {}),
        central: {
          expiresAt,
          stage,
          at: now.toISOString(),
          clientId: app.credentials.clientId,
          source: app.source,
        },
      };
      await tx
        .update(settings)
        .set({ appSecretAlerts: next, updatedAt: sql`${settings.updatedAt}` })
        .where(eq(settings.id, row.id));
      this.deps.log?.("warn", "the Microsoft 365 app credential expires soon", {
        clientId,
        expiresAt,
        stage,
      });
      return { status: "raised", stage, expiresAt } as const;
    });
  }

  /** Check now and then; `close` stops it. */
  start(): { close(): void } {
    let closed = false;
    let timer: NodeJS.Timeout | null = null;
    const loop = (delay: number) => {
      timer = setTimeout(() => {
        if (closed) {
          return;
        }
        this.checkOnce()
          .catch((error) =>
            this.deps.log?.("warn", "the app secret expiry check failed", {
              error: error instanceof Error ? error.message : String(error),
            }),
          )
          .finally(() => {
            if (!closed) {
              loop(SECRET_WATCH_INTERVAL_MS);
            }
          });
      }, delay);
      timer.unref();
    };
    loop(FIRST_CHECK_MS);
    return {
      close() {
        closed = true;
        if (timer) {
          clearTimeout(timer);
        }
      },
    };
  }
}
