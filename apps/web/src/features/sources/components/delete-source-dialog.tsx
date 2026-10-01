import { useNavigate } from "@tanstack/react-router";
import { Pause, ShieldAlert, TriangleAlert } from "lucide-react";
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
import { toast } from "@/components/ui/sonner";
import { sourcesListTo } from "../paths";
import { retainedDataOf, sourceErrorKey } from "../presenters";
import type { SourceDto } from "../types";
import { useDeleteSource, useUpdateSource } from "../use-sources";

interface DeleteSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: SourceDto;
}

/**
 * Delete a source. The API refuses while backups, archived mail or legal
 * holds hang off it; the dialog then says so with the counts and offers the
 * safe alternative, pausing.
 */
export function DeleteSourceDialog({ open, onOpenChange, source }: DeleteSourceDialogProps) {
  const { t } = useTranslation("sources");
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const remove = useDeleteSource(source.id);
  const pause = useUpdateSource(source.id);
  const retained = retainedDataOf(remove.error);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      remove.reset();
      pause.reset();
    }
    onOpenChange(next);
  };

  const confirm = () => {
    remove.mutate(undefined, {
      onSuccess: () => {
        toast.success(t("toasts.deleted"));
        onOpenChange(false);
        void navigate({ to: sourcesListTo(), replace: true });
      },
    });
  };

  const pauseInstead = () => {
    pause.mutate(
      { status: "disabled" },
      {
        onSuccess: () => {
          toast.success(t("toasts.paused"));
          handleOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("delete.title")}</DialogTitle>
          <DialogDescription>
            {t(source.kind === "import" ? "delete.importDescription" : "delete.description", {
              name: source.name,
            })}
          </DialogDescription>
        </DialogHeader>

        {retained ? (
          <Alert variant="warning">
            <ShieldAlert />
            <AlertTitle>{t("delete.blocked.title")}</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{t("delete.blocked.description")}</p>
              <ul className="list-inside list-disc text-muted-foreground">
                {retained.snapshots > 0 ? (
                  <li>{t("delete.blocked.snapshots", { count: retained.snapshots })}</li>
                ) : null}
                {retained.archiveItems > 0 ? (
                  <li>{t("delete.blocked.archiveItems", { count: retained.archiveItems })}</li>
                ) : null}
                {retained.legalHolds > 0 ? (
                  <li>{t("delete.blocked.legalHolds", { count: retained.legalHolds })}</li>
                ) : null}
              </ul>
            </AlertDescription>
          </Alert>
        ) : remove.error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{tc(sourceErrorKey(remove.error))}</AlertDescription>
          </Alert>
        ) : null}
        {pause.error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{tc(sourceErrorKey(pause.error))}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {tc("actions.cancel")}
          </Button>
          {retained ? (
            source.status === "disabled" ? null : (
              <Button onClick={pauseInstead} loading={pause.isPending}>
                {pause.isPending ? null : <Pause />}
                {t("delete.pauseInstead")}
              </Button>
            )
          ) : (
            <Button variant="destructive" onClick={confirm} loading={remove.isPending}>
              {t("delete.confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
