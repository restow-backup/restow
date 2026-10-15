import { Link } from "@tanstack/react-router";
import { CircleCheck, Repeat, TriangleAlert } from "lucide-react";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";

import type {
  ConflictMode,
  FileShareDetail,
  RestoreDestination,
  ShareProtocol,
  ShareSnapshot,
} from "../api.js";
import { useRequestRestore, useRestoreTargets, useShareFormat } from "../hooks.js";
import { fileShareTo, linkTo } from "../paths.js";
import {
  cleanSubfolder,
  defaultRestoreFolder,
  restoreDefaults,
  shareErrorKey,
} from "../presenters.js";

/** How many of the chosen paths the dialog lists before it says how many more there are. */
const PATHS_SHOWN = 5;

type Where = "zip" | RestoreDestination;

export interface ShareRestoreDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  share: Pick<FileShareDetail, "id" | "name" | "protocol" | "allowRestore">;
  point: ShareSnapshot;
  /** The selected paths below the share root; empty restores everything. */
  paths: readonly string[];
  /** "Download as ZIP": the browser's own download of the selection. */
  onDownload: () => void;
  onRequested: () => void;
  onShowRuns: () => void;
  /** Tests pin the clock (the default folder name). */
  now?: () => Date;
}

/**
 * Restoring from a file share's restore point (docs/FILESHARES.md 12.4): where to (a ZIP
 * download, the original location or a new folder in this share when it allows restores, or a
 * folder of another share that does), what happens when a file exists at the original location
 * (overwrite, keep both, skip), whether the permissions go back and whether written files are
 * verified, then a summary to confirm. The run appears in the share's runs.
 */
export function ShareRestoreDialog({
  open,
  onOpenChange,
  share,
  point,
  paths,
  onDownload,
  onRequested,
  onShowRuns,
  now = () => new Date(),
}: ShareRestoreDialogProps) {
  const format = useShareFormat();
  const { t } = format;
  const targets = useRestoreTargets(open);
  const restore = useRequestRestore(share.id);
  const others = (targets.data?.items ?? []).filter((target) => target.id !== share.id);
  const [where, setWhere] = React.useState<Where>(share.allowRestore ? "new_folder" : "zip");
  const [conflict, setConflict] = React.useState<ConflictMode>("keep_both");
  const [targetId, setTargetId] = React.useState<string>("");
  const [folder, setFolder] = React.useState("");
  const [permissions, setPermissions] = React.useState<boolean | null>(null);
  const [verify, setVerify] = React.useState<boolean | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const folderPlaceholder = React.useMemo(() => defaultRestoreFolder(now()), [now]);

  const { reset } = restore;
  React.useEffect(() => {
    if (open) {
      reset();
      setWhere(share.allowRestore ? "new_folder" : "zip");
      setConflict("keep_both");
      setTargetId("");
      setFolder("");
      setPermissions(null);
      setVerify(null);
      setConfirming(false);
    }
  }, [open, reset, share.allowRestore]);

  const target = others.find((item) => item.id === (targetId || others[0]?.id)) ?? null;
  const targetProtocol: ShareProtocol =
    where === "other_share" ? (target?.protocol ?? share.protocol) : share.protocol;
  const defaults =
    where === "zip"
      ? { restorePermissions: false, verify: false }
      : restoreDefaults(where, targetProtocol);
  const restorePermissions = permissions ?? defaults.restorePermissions;
  const verifyWritten = verify ?? defaults.verify;
  const shown = paths.slice(0, PATHS_SHOWN);
  const hidden = paths.length - shown.length;
  const intoThis = where === "original" || where === "new_folder";
  const blocked = (intoThis && !share.allowRestore) || (where === "other_share" && !target);

  const submit = () => {
    if (where === "zip") {
      onDownload();
      onOpenChange(false);
      return;
    }
    if (!confirming) {
      setConfirming(true);
      return;
    }
    restore.mutate(
      {
        snapshotId: point.id,
        paths: [...paths],
        destination: where,
        ...(where === "other_share"
          ? { targetShareId: target?.id, folder: cleanSubfolder(folder) }
          : {}),
        ...(where === "original" ? { conflict } : {}),
        restorePermissions,
        verify: verifyWritten,
      },
      {
        onSuccess: () => {
          onRequested();
          toast.success(t("restore.requested"));
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-slot="share-restore-dialog">
        <DialogHeader>
          <DialogTitle>{t("restore.title")}</DialogTitle>
          <DialogDescription>
            {t("restore.description", {
              name: share.name,
              time: format.dateTime(point.time) ?? "",
            })}
          </DialogDescription>
        </DialogHeader>
        {restore.isSuccess ? (
          <div className="grid gap-4">
            <Alert variant="info" data-restore="requested">
              <CircleCheck aria-hidden="true" />
              <AlertTitle>{t("restore.requestedTitle")}</AlertTitle>
              <AlertDescription>{t("restore.requestedDescription")}</AlertDescription>
            </Alert>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("restore.close")}
              </Button>
              <Button
                onClick={() => {
                  onOpenChange(false);
                  onShowRuns();
                }}
              >
                {t("restore.showRuns")}
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
                {paths.length === 0
                  ? t("restore.everything")
                  : t("restore.selection", { count: paths.length })}
              </p>
              {paths.length > 0 ? (
                <ul className="space-y-0.5 rounded-md border bg-muted/40 p-2 font-mono text-xs">
                  {shown.map((path) => (
                    <li key={path} className="break-all">
                      {path}
                    </li>
                  ))}
                  {hidden > 0 ? (
                    <li className="font-sans text-muted-foreground">
                      {t("restore.more", { count: hidden })}
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </section>

            <fieldset className="grid gap-2" disabled={confirming}>
              <legend className="text-sm font-medium">{t("restore.where")}</legend>
              <RadioGroup value={where} onValueChange={(value) => setWhere(value as Where)}>
                {(["zip", "original", "new_folder", "other_share"] as const).map((option) => {
                  const disabled =
                    ((option === "original" || option === "new_folder") && !share.allowRestore) ||
                    (option === "other_share" && others.length === 0);
                  return (
                    <div key={option} className="grid gap-0.5">
                      <Label
                        htmlFor={`restore-where-${option}`}
                        className="flex items-center gap-2 font-normal"
                      >
                        <RadioGroupItem
                          id={`restore-where-${option}`}
                          value={option}
                          disabled={disabled}
                          data-where={option}
                        />
                        {t(`restore.options.${option}`)}
                      </Label>
                      {disabled ? (
                        <p
                          className="pl-6 text-xs text-muted-foreground"
                          data-disabled-reason={option}
                        >
                          {option === "other_share" ? (
                            t("restore.noTargets")
                          ) : (
                            <>
                              {t("restore.notAllowed")}{" "}
                              <Link
                                {...linkTo(fileShareTo(share.id, "settings"))}
                                className="underline"
                              >
                                {t("restore.openSettings")}
                              </Link>
                            </>
                          )}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </RadioGroup>
            </fieldset>

            {where === "original" ? (
              <fieldset className="grid gap-2" disabled={confirming}>
                <legend className="text-sm font-medium">{t("restore.ifExists")}</legend>
                <RadioGroup
                  value={conflict}
                  onValueChange={(value) => setConflict(value as ConflictMode)}
                >
                  {(["overwrite", "keep_both", "skip"] as const).map((mode) => (
                    <Label
                      key={mode}
                      htmlFor={`restore-conflict-${mode}`}
                      className="grid gap-0.5 font-normal"
                    >
                      <span className="flex items-center gap-2">
                        <RadioGroupItem
                          id={`restore-conflict-${mode}`}
                          value={mode}
                          data-conflict={mode}
                        />
                        {t(`restore.conflict.${mode}`)}
                      </span>
                      <span className="pl-6 text-xs text-muted-foreground">
                        {t(`restore.conflictHint.${mode}`)}
                      </span>
                    </Label>
                  ))}
                </RadioGroup>
              </fieldset>
            ) : null}

            {where === "other_share" && others.length > 0 ? (
              <div className="grid gap-3" data-slot="other-share">
                <div className="grid gap-1.5">
                  <Label htmlFor="restore-target-share">{t("restore.targetShare")}</Label>
                  <select
                    id="restore-target-share"
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                    value={target?.id ?? ""}
                    onChange={(event) => setTargetId(event.target.value)}
                    disabled={confirming}
                  >
                    {others.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} ({item.location})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="restore-folder">{t("restore.folder")}</Label>
                  <Input
                    id="restore-folder"
                    value={folder}
                    placeholder={folderPlaceholder}
                    onChange={(event) => setFolder(event.target.value)}
                    disabled={confirming}
                  />
                  <p className="text-xs text-muted-foreground">{t("restore.folderHint")}</p>
                </div>
                {target ? (
                  <Link
                    to={"/jobs" as never}
                    search={
                      {
                        type: "copy",
                        new: 1,
                        source: share.id,
                        target: target.id,
                        ...(cleanSubfolder(folder) ? { folder: cleanSubfolder(folder) } : {}),
                      } as never
                    }
                    className="inline-flex items-center gap-1 text-sm underline"
                    data-action="repeat-on-schedule"
                  >
                    <Repeat className="size-3.5" aria-hidden="true" />
                    {t("restore.repeat")}
                  </Link>
                ) : null}
              </div>
            ) : null}

            {where !== "zip" ? (
              <div className="grid gap-3">
                <div className="flex items-start gap-3">
                  <Switch
                    id="restore-permissions"
                    checked={restorePermissions}
                    onCheckedChange={(checked) => setPermissions(checked === true)}
                    disabled={confirming}
                  />
                  <div className="grid gap-0.5">
                    <Label htmlFor="restore-permissions">{t("restore.permissions")}</Label>
                    <p className="text-xs text-muted-foreground">
                      {where === "other_share"
                        ? t("restore.permissionsOther")
                        : t("restore.permissionsHint")}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Switch
                    id="restore-verify"
                    checked={verifyWritten}
                    onCheckedChange={(checked) => setVerify(checked === true)}
                    disabled={confirming}
                  />
                  <div className="grid gap-0.5">
                    <Label htmlFor="restore-verify">{t("restore.verify")}</Label>
                    <p className="text-xs text-muted-foreground">{t("restore.verifyHint")}</p>
                  </div>
                </div>
              </div>
            ) : null}

            {confirming ? (
              <Alert variant="warning" data-slot="restore-summary">
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>{t("restore.summaryTitle")}</AlertTitle>
                <AlertDescription>
                  {t(`restore.summary.${where}`, {
                    count: paths.length,
                    name: where === "other_share" ? (target?.name ?? "") : share.name,
                    folder: cleanSubfolder(folder) || folderPlaceholder,
                    conflict: t(`restore.conflict.${conflict}`),
                  })}
                </AlertDescription>
              </Alert>
            ) : null}

            {restore.isError ? (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden="true" />
                <AlertDescription>{t(shareErrorKey(restore.error))}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => (confirming ? setConfirming(false) : onOpenChange(false))}
              >
                {confirming ? t("restore.back") : t("restore.cancel")}
              </Button>
              <Button
                type="submit"
                loading={restore.isPending}
                disabled={blocked}
                data-action="restore-submit"
              >
                {where === "zip"
                  ? t("restore.download")
                  : confirming
                    ? t("restore.confirm")
                    : t("restore.next")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
