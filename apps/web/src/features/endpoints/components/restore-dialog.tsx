import { CircleCheck, TriangleAlert } from "lucide-react";
import * as React from "react";

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

import { type EndpointDetail, type EndpointOs, type EndpointSnapshot, LIMITS } from "../api.js";
import { useCreateTask, useEndpointFormat } from "../hooks.js";
import { endpointErrorKey, endpointName, hasControlCharacters } from "../presenters.js";

/**
 * A snapshot path as the machine writes it: restic stores C:\Users\anna as /C/Users/anna, which
 * a Windows machine shows as C:\Users\anna again; other systems show it unchanged. The API and
 * the agent keep the /C/... form.
 */
export function displaySnapshotPath(path: string, os: EndpointOs): string {
  if (os !== "windows") {
    return path;
  }
  const match = /^\/([A-Za-z])(\/.*)?$/.exec(path);
  if (!match) {
    return path;
  }
  const rest = (match[2] ?? "/").replaceAll("/", "\\");
  return `${match[1]?.toUpperCase()}:${rest}`;
}

/** How many of the chosen paths the dialog lists before it says how many more there are. */
const PATHS_SHOWN = 5;

export type TargetProblem =
  | "notAbsolute"
  | "root"
  | "notPlain"
  | "controlCharacters"
  | "tooLong"
  | "networkPath"
  | "forwardSlash"
  | "invalidCharacter"
  | "trailingDotOrSpace"
  | "reservedName"
  | "systemFolder"
  | null;

const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** Folders a Windows restore never writes to (the agent checks the real ones of the machine). */
const WINDOWS_BLOCKED = [
  "C:\\WINDOWS",
  "C:\\PROGRAM FILES",
  "C:\\PROGRAM FILES (X86)",
  "C:\\PROGRAMDATA\\RESTOW",
];

/**
 * The Windows rules (@restow/core restoreTargetIssue, docs/WINDOWS-AGENT.md 18.1): a local drive
 * path below the drive root, no UNC path, no forward slash, no "." or "..", none of <>"|?* or a
 * colon after the drive, no component ending in a dot or a space, no device name, and not in the
 * Windows folder, the program folders or the agent's own data.
 */
function checkWindowsTarget(target: string): TargetProblem {
  if (target.startsWith("\\\\") || target.startsWith("//")) return "networkPath";
  if (!/^[A-Za-z]:\\/.test(target)) return "notAbsolute";
  if (target.includes("/")) return "forwardSlash";
  const rest = target.slice(3);
  if (rest === "") return "root";
  if (/[<>"|?*:]/.test(rest)) return "invalidCharacter";
  const parts = rest.split("\\");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return "notPlain";
    if (part.endsWith(".") || part.endsWith(" ")) return "trailingDotOrSpace";
    if (WINDOWS_RESERVED.has((part.split(".")[0] ?? "").trimEnd().toUpperCase())) {
      return "reservedName";
    }
  }
  const full = `${target.slice(0, 1)}:\\${rest}`.toUpperCase();
  if (
    WINDOWS_BLOCKED.some((base) => full === base || full.startsWith(`${base}\\`)) ||
    parts.some((part) => part.toUpperCase() === "SYSTEM VOLUME INFORMATION")
  ) {
    return "systemFolder";
  }
  return null;
}

/**
 * Checks the optional target folder by the rules the API and the agent apply
 * (@restow/core `restoreTargetIssue`): on Linux and macOS an absolute path below `/`, in plain
 * form; on Windows a local drive path such as D:\Restore outside the system folders. An empty
 * one is fine (the agent picks a new folder). Whether the folder is new or empty and its parent
 * exists only the machine can tell; the hint says so.
 */
export function checkTargetDir(value: string, os: EndpointOs = "linux"): TargetProblem {
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
  if (os === "windows") {
    return checkWindowsTarget(target);
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
  endpoint: Pick<
    EndpointDetail,
    "id" | "displayName" | "hostname" | "connection" | "profile" | "os"
  >;
  snapshot: EndpointSnapshot;
  /** The paths to restore, with folders already including what is inside them. */
  paths: readonly string[];
  /**
   * Show the overview, where the pending request and the run appear. Absent for a restore
   * operator, who may not open the machine's page.
   */
  onShowOverview?: (() => void) | undefined;
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
  const problem = checkTargetDir(target, endpoint.os);

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
                <p>
                  {t(
                    onShowOverview
                      ? "restore.requested.description"
                      : "restore.requested.descriptionRestorer",
                  )}
                </p>
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("restore.close")}
              </Button>
              {onShowOverview ? (
                <Button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    onShowOverview();
                  }}
                >
                  {t("restore.showOverview")}
                </Button>
              ) : null}
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
                    {displaySnapshotPath(path, endpoint.os)}
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
                placeholder={t("restore.target.placeholder", { os: endpoint.os })}
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
                  ? t(`restore.target.errors.${problem}`, { os: endpoint.os })
                  : t("restore.target.hint", { os: endpoint.os })}
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
