import { CircleCheck, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";

import { type EndpointDetail, type EndpointSnapshot, LIMITS } from "../api.js";
import { useCreateTask, useEndpointFormat } from "../hooks.js";
import { endpointErrorKey, endpointName, hasControlCharacters } from "../presenters.js";

/** How many of the chosen paths the dialog lists before it says how many more there are. */
const PATHS_SHOWN = 5;

export type TargetProblem =
  | "notAbsolute"
  | "root"
  | "notPlain"
  | "controlCharacters"
  | "tooLong"
  | null;

/**
 * Checks the optional target folder by the rules the API and the agent apply
 * (apps/api/src/features/endpoints/schemas.ts `restoreTargetSchema`): an
 * absolute Linux or macOS path below `/`, in plain form. A Windows path is
 * refused here already rather than by the server. An empty one is fine (the
 * agent picks a new folder). Whether the folder is new or empty and its
 * parent exists only the machine can tell; the hint says so.
 */
export function checkTargetDir(value: string): TargetProblem {
  const target = value.trim();
  if (target === "") {
    return null;
  }
  if (hasControlCharacters(target)) {
    return "controlCharacters";
  }
  if (target.length > LIMITS.pathLength) {
    return "tooLong";
  }
  if (!target.startsWith("/")) {
    return "notAbsolute";
  }
  if (target === "/") {
    return "root";
  }
  const plain =
    !target.endsWith("/") &&
    target
      .slice(1)
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..");
  return plain ? null : "notPlain";
}

export interface RestoreDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpoint: Pick<EndpointDetail, "id" | "displayName" | "hostname" | "connection" | "profile">;
  snapshot: EndpointSnapshot;
  /** The paths to restore, with folders already including what is inside them. */
  paths: readonly string[];
  /** Show the overview, where the pending request and the run appear. */
  onShowOverview: () => void;
  /** The request was made; the selection can be cleared. */
  onRequested: () => void;
}

/**
 * Restores the chosen files and folders onto the machine itself. The restore
 * never overwrites: the agent writes into a new folder (its own default, or
 * the one named here). The request waits for the agent's next contact.
 */
export function RestoreDialog({
  open,
  onOpenChange,
  endpoint,
  snapshot,
  paths,
  onShowOverview,
  onRequested,
}: RestoreDialogProps) {
  const format = useEndpointFormat();
  const { t } = format;
  const create = useCreateTask(endpoint.id);
  const [target, setTarget] = React.useState("");
  const [attempted, setAttempted] = React.useState(false);
  const requested = create.isSuccess;
  const problem = checkTargetDir(target);

  // Every opening starts clean.
  const { reset } = create;
  React.useEffect(() => {
    if (open) {
      reset();
      setTarget("");
      setAttempted(false);
    }
  }, [open, reset]);

  const submit = () => {
    setAttempted(true);
    if (problem || paths.length === 0) {
      return;
    }
    const targetDir = target.trim();
    create.mutate(
      {
        kind: "restore",
        snapshotId: snapshot.id,
        paths: [...paths],
        ...(targetDir ? { targetDir } : {}),
      },
      {
        onSuccess: () => {
          onRequested();
          toast.success(t("restore.toast.requested"));
        },
      },
    );
  };

  const shown = paths.slice(0, PATHS_SHOWN);
  const hidden = paths.length - shown.length;
  const name = endpointName(endpoint);
  const offline = endpoint.connection !== "online";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("restore.title")}</DialogTitle>
          <DialogDescription>{t("restore.description", { name })}</DialogDescription>
        </DialogHeader>

        {requested ? (
          <div className="grid gap-4">
            <Alert variant="info" data-restore="requested">
              <CircleCheck />
              <AlertTitle>{t("restore.requested.title")}</AlertTitle>
              <AlertDescription>
                <p>{t("restore.requested.description")}</p>
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("restore.close")}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onShowOverview();
                }}
              >
                {t("restore.showOverview")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <section className="space-y-1.5">
              <p className="text-sm font-medium">
                {t("restore.selection", {
                  count: paths.length,
                  id: snapshot.shortId,
                  time: format.dateTime(snapshot.time) ?? "",
                })}
              </p>
              <ul className="space-y-0.5 rounded-md border bg-muted/40 p-2 font-mono text-xs">
                {shown.map((path) => (
                  <li key={path} className="break-all">
                    {path}
                  </li>
                ))}
                {hidden > 0 ? (
                  <li className="font-sans text-muted-foreground">
                    {t("restore.moreItems", { count: hidden })}
                  </li>
                ) : null}
              </ul>
            </section>

            <div className="grid gap-1.5">
              <Label htmlFor="restore-target">{t("restore.target.label")}</Label>
              <Input
                id="restore-target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder={t("restore.target.placeholder")}
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-sm"
                aria-invalid={attempted && problem !== null}
                aria-describedby="restore-target-hint"
              />
              <p
                id="restore-target-hint"
                role={attempted && problem ? "alert" : undefined}
                className={
                  attempted && problem
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {attempted && problem
                  ? t(`restore.target.errors.${problem}`)
                  : t("restore.target.hint")}
              </p>
            </div>

            <Alert variant="info">
              <CircleCheck />
              <AlertDescription>
                <p>{t("restore.neverOverwrites")}</p>
              </AlertDescription>
            </Alert>

            {offline ? (
              <Alert variant="warning" data-restore="offline">
                <TriangleAlert />
                <AlertDescription>
                  <p>{t(`restore.offline.${endpoint.profile}`)}</p>
                </AlertDescription>
              </Alert>
            ) : (
              <p className="text-xs text-muted-foreground">{t("restore.timing")}</p>
            )}

            {create.isError ? (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertDescription>
                  <p>{t(endpointErrorKey(create.error))}</p>
                </AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("restore.cancel")}
              </Button>
              <Button type="submit" loading={create.isPending} disabled={paths.length === 0}>
                {t("restore.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
