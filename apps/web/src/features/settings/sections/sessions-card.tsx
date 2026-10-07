import type { TFunction } from "i18next";
import { LogOut, Monitor, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { errorMessageKey } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

import { ConfirmDialog } from "../components/confirm-dialog";
import { AuthRequestError, useRevokeOtherSessions, useRevokeSession, useSessions } from "../hooks";
import { type SessionRow, authStatusKey } from "../presenters";

/** i18n key for a failed plain better-auth request (listing, sessions). */
function requestErrorKey(error: unknown): string {
  return error instanceof AuthRequestError
    ? authStatusKey(error.detail)
    : `common:${errorMessageKey(error)}`;
}

/**
 * Every browser and device signed in with the own account: device, browser,
 * IP address, sign-in and last activity, the current one marked. Each other
 * session can be signed out on its own, or all of them at once.
 */
export function SessionsCard() {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const currentToken = authClient.useSession().data?.session.token ?? null;
  const sessions = useSessions(currentToken);
  const revokeOthers = useRevokeOtherSessions();
  const revokeOne = useRevokeSession();
  const [confirmingAll, setConfirmingAll] = React.useState(false);
  const [revoking, setRevoking] = React.useState<SessionRow | null>(null);
  const others = sessions.data?.filter((row) => !row.current) ?? [];

  const confirmAll = () => {
    revokeOthers.mutate(undefined, {
      onSuccess: () => {
        toast.success(t("toasts.sessionsRevoked"));
        setConfirmingAll(false);
      },
      onError: (error) => {
        toast.error(tc(requestErrorKey(error)));
        setConfirmingAll(false);
      },
    });
  };

  const confirmOne = () => {
    if (!revoking) {
      return;
    }
    revokeOne.mutate(revoking.token, {
      onSuccess: () => {
        toast.success(t("toasts.sessionRevoked"));
        setRevoking(null);
      },
      onError: (error) => {
        toast.error(tc(requestErrorKey(error)));
        setRevoking(null);
      },
    });
  };

  return (
    <Card data-slot="sessions-card">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{t("security.sessions.title")}</CardTitle>
          <CardDescription>{t("security.sessions.description")}</CardDescription>
        </div>
        <Button
          variant="outline"
          className="shrink-0"
          onClick={() => setConfirmingAll(true)}
          disabled={sessions.isSuccess && others.length === 0}
        >
          <LogOut />
          {t("security.sessions.revoke")}
        </Button>
      </CardHeader>
      <CardContent>
        {sessions.isPending ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : sessions.isError ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>{t("security.sessions.loadError")}</AlertTitle>
            <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <span>{tc(requestErrorKey(sessions.error))}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void sessions.refetch()}
                loading={sessions.isFetching}
              >
                {tc("actions.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <ul
            className="divide-y divide-border rounded-lg border border-border"
            data-slot="session-list"
          >
            {sessions.data.map((row) => (
              <SessionItem key={row.id} row={row} onRevoke={setRevoking} />
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmingAll}
        onOpenChange={setConfirmingAll}
        title={t("security.sessions.confirmTitle")}
        description={t("security.sessions.confirmDescription")}
        confirmLabel={t("security.sessions.revoke")}
        pending={revokeOthers.isPending}
        onConfirm={confirmAll}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("security.sessions.revokeOneTitle")}
        description={t("security.sessions.revokeOneDescription", {
          device: revoking ? sessionLabel(revoking, t) : "",
        })}
        confirmLabel={t("security.sessions.revokeOne")}
        pending={revokeOne.isPending}
        onConfirm={confirmOne}
      />
    </Card>
  );
}

function sessionLabel(row: SessionRow, t: TFunction<"settings">): string {
  if (row.browser && row.device) {
    return t("security.sessions.browserOn", { browser: row.browser, device: row.device });
  }
  return row.browser ?? row.device ?? t("security.sessions.unknownDevice");
}

function SessionItem({
  row,
  onRevoke,
}: {
  row: SessionRow;
  onRevoke: (row: SessionRow) => void;
}) {
  const { t } = useTranslation("settings");
  const label = sessionLabel(row, t);
  return (
    <li
      className="flex items-center gap-3 px-4 py-3"
      data-slot="session"
      data-current={row.current}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Monitor className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="truncate">{label}</span>
          {row.current ? <Badge variant="secondary">{t("security.sessions.current")}</Badge> : null}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("security.sessions.lastActive")} <RelativeTime value={row.updatedAt} />
          {" · "}
          {t("security.sessions.signedIn")} <RelativeTime value={row.createdAt} />
          {row.ipAddress ? ` · ${t("security.sessions.ip", { ip: row.ipAddress })}` : null}
        </p>
      </div>
      {row.current ? null : (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onRevoke(row)}
          aria-label={t("security.sessions.revokeOneLabel", { device: label })}
        >
          <LogOut />
          {t("security.sessions.revokeOne")}
        </Button>
      )}
    </li>
  );
}
