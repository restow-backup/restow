import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { fetchSetupState } from "@/lib/api";
import { LOGIN_PATH } from "@/lib/entry";
import { RESTORE_ACTIVATED_KEY } from "@/routes/setup/restore-api";

/**
 * How to finish a restore whose activation did not complete (docs/DATABASE.md, "When a restore
 * needs attention"): activate again (it finishes a cut-off swap, or answers that the restored
 * database is live already), then start everything; or drop the restored database again.
 */
export const RESTORE_FINISH_COMMANDS = [
  "cd /opt/restow",
  "sudo docker compose run --rm --no-deps --entrypoint restow api restore activate",
  "sudo docker compose up -d",
].join("\n");

export const RESTORE_ABORT_COMMANDS = [
  "cd /opt/restow",
  "sudo docker compose run --rm --no-deps --entrypoint restow api restore abort",
  "sudo docker compose up -d",
].join("\n");

/** Updater statuses after which the restored installation does not come up by itself. */
const STUCK = new Set(["needs_attention", "failed"]);

/**
 * The restore is activated: the updater stops the api, makes the restored database the live one
 * and starts it again, then worker and scheduler. The page asks the public setup state until the
 * restored installation answers (configured: it brought its users), then the operator signs in
 * with an account of it and checks Installation › Restore mode before ending it. When the
 * updater reports instead that the activation did not finish (`needs_attention`, `failed`: the
 * setup token is retired by then, so the public state is all this page has), it says why, that
 * worker and scheduler stay stopped, and how to finish or undo it on the server.
 */
export function RestoreDoneStep() {
  const { t } = useTranslation("setup");
  const navigate = useNavigate();
  const state = useQuery({
    queryKey: ["setup", "restore", "done"],
    queryFn: fetchSetupState,
    refetchInterval: (query) => (query.state.data?.configured ? false : 3000),
    retry: true,
  });
  const live = state.data?.configured === true;
  const restore = state.data?.restore;
  const stuck = !live && restore?.status ? STUCK.has(restore.status) : false;
  React.useEffect(() => {
    if (live) {
      try {
        sessionStorage.removeItem(RESTORE_ACTIVATED_KEY);
      } catch {
        // Nothing to forget.
      }
    }
  }, [live]);

  if (stuck) {
    return (
      <div className="space-y-4 text-sm">
        <div role="alert" className="space-y-1">
          <p className="font-medium text-destructive">{t("restoreDone.attention.title")}</p>
          <p>{t("restoreDone.attention.text")}</p>
          {restore?.message ? (
            <p className="text-muted-foreground">
              {t("restoreDone.attention.reason", { message: restore.message })}
            </p>
          ) : null}
        </div>
        <p className="text-muted-foreground">{t("restoreDone.attention.finish")}</p>
        <pre className="overflow-x-auto whitespace-pre rounded-md border bg-muted px-3 py-2 font-mono text-xs text-foreground">
          {RESTORE_FINISH_COMMANDS}
        </pre>
        <p className="text-muted-foreground">{t("restoreDone.attention.abort")}</p>
        <pre className="overflow-x-auto whitespace-pre rounded-md border bg-muted px-3 py-2 font-mono text-xs text-foreground">
          {RESTORE_ABORT_COMMANDS}
        </pre>
        <p className="text-xs text-muted-foreground">{t("restoreDone.attention.docs")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-sm">
      {live ? (
        <>
          <p>{t("restoreDone.live")}</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>{t("restoreDone.next.signIn")}</li>
            <li>{t("restoreDone.next.restoreMode")}</li>
            <li>{t("restoreDone.next.end")}</li>
          </ol>
          <Button type="button" onClick={() => void navigate({ to: LOGIN_PATH, replace: true })}>
            {t("restoreDone.signIn")}
          </Button>
        </>
      ) : (
        <>
          <Progress />
          <p className="text-muted-foreground">{t("restoreDone.waiting")}</p>
        </>
      )}
    </div>
  );
}
